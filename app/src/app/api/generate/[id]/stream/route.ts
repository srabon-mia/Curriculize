import { createClient as createServiceClient } from "@supabase/supabase-js";
import { buildSkeletonPrompt } from "@/lib/prompts/skeleton";
import { buildDiscoverPrompt, buildTopicBatchPrompt } from "@/lib/prompts/discover";
import { buildSourceDiscoveryPrompt } from "@/lib/prompts/sources";
import type { NodeWithChildren } from "@/lib/curriculum-data";

export const maxDuration = 300;

const supabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function callClaude(prompt: string, useSearch = true): Promise<string> {
  let lastErr = "";

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const waitMs = attempt * 30000;
      console.log(`Rate limited, waiting ${waitMs / 1000}s before retry ${attempt}...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        ...(useSearch && {
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (res.status === 429) {
      lastErr = await res.text();
      continue;
    }

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();
    const textBlocks = data.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text);

    const allText = textBlocks.join("");
    return allText;
  }

  throw new Error(`Rate limited after retries: ${lastErr}`);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const encoder = new TextEncoder();

  function send(
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown
  ) {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Get the curriculum record
        const { data: curriculum } = await supabase
          .from("curricula")
          .select("*")
          .eq("id", id)
          .single();

        if (!curriculum) {
          send(controller, "error", { message: "Curriculum not found" });
          controller.close();
          return;
        }

        const notes = curriculum.notes ? JSON.parse(curriculum.notes) : {};

        // Step 1: Generate skeleton
        send(controller, "status", {
          message: "Finding the best curriculum structure…",
          step: "skeleton",
        });

        const skeletonPrompt = buildSkeletonPrompt(
          curriculum.title,
          notes.grade_level ?? "high school",
          notes.difficulty ?? "standard",
          notes.existing_knowledge ?? "",
          notes.learning_goal ?? "understand the subject",
          notes.time_available ?? "no time pressure",
          notes.added_context ?? ""
        );

        const skeletonText = await callClaude(skeletonPrompt, true);

        type SkeletonNode = {
          title: string;
          order_index: number;
          major_understandings: Array<{
            code: string | null;
            description: string;
          }>;
        };

        type Skeleton = {
          title: string;
          source_type: string;
          source_attribution: string | null;
          source_url: string | null;
          nodes: SkeletonNode[];
        };

        let skeleton: Skeleton;
        try {
          const jsonMatch = skeletonText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          skeleton = JSON.parse(jsonMatch[0]) as Skeleton;
        } catch {
          send(controller, "error", {
            message: "Failed to generate curriculum structure",
          });
          controller.close();
          return;
        }

        // Update curriculum with real title and attribution
        await supabase
          .from("curricula")
          .update({
            title: skeleton.title,
            source_type: skeleton.source_type,
            source_attribution: skeleton.source_attribution,
            source_url: skeleton.source_url,
          })
          .eq("id", id);

        const curriculumTitle = skeleton.title;

        send(controller, "skeleton", {
          title: skeleton.title,
          topic_count: skeleton.nodes.length,
        });

        // Step 2: Insert nodes and major understandings
        const nodeIds: Array<{
          nodeId: string;
          node: SkeletonNode;
        }> = [];

        for (const node of skeleton.nodes) {
          const { data: nodeRow } = await supabase
            .from("nodes")
            .insert({
              curriculum_id: id,
              title: node.title,
              order_index: node.order_index,
            })
            .select("id")
            .single();

          if (!nodeRow) continue;

          const mus = node.major_understandings.map((mu, i) => ({
            node_id: nodeRow.id,
            external_key: mu.code ?? `${node.order_index}.${i + 1}`,
            code: mu.code,
            description: mu.description,
            order_index: i,
          }));

          await supabase.from("major_understandings").insert(mus);
          nodeIds.push({ nodeId: nodeRow.id, node });
        }

        // Step 3: Discover best sources for this subject/difficulty
        send(controller, "status", {
          message: "Finding the best sources for this subject…",
          step: "sources",
        });

        type DiscoveredSource = {
          domain: string;
          name: string;
          why: string;
          best_for: string;
        };

        let discoveredSources: DiscoveredSource[] = [];

        try {
          const sourcesPrompt = buildSourceDiscoveryPrompt(
            curriculumTitle,
            notes.difficulty ?? "standard",
            notes.learning_goal ?? "understand the subject"
          );

          // No web search needed — Claude already knows which sites are good
          const sourcesText = await callClaude(sourcesPrompt, false);
          const jsonMatch = sourcesText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            discoveredSources = JSON.parse(jsonMatch[0]) as DiscoveredSource[];
            console.log(
              `Discovered ${discoveredSources.length} sources:`,
              discoveredSources.map((s) => s.domain).join(", ")
            );
          }
        } catch (err) {
          console.log("Source discovery failed, continuing without prioritized sources:", err);
        }

        // Step 4: Discover topic-level resources during generation
        for (let i = 0; i < nodeIds.length; i++) {
          const { nodeId, node } = nodeIds[i];

          send(controller, "status", {
            message: `Finding resources for: ${node.title}`,
            step: "discovery",
            current: i + 1,
            total: nodeIds.length,
          });

          try {
            const topicPrompt = buildDiscoverPrompt(
              {
                id: nodeId,
                curriculum_id: id,
                external_key: null,
                title: node.title,
                order_index: node.order_index,
                exam_weight_pct: null,
                claim_statement: null,
                major_understandings: [],
              } as NodeWithChildren,
              "topic",
              undefined,
              undefined,
              curriculumTitle,
              discoveredSources.map((s) => s.domain)
            );

            const topicText = await callClaude(topicPrompt, true);
            console.log(`Topic text for "${node.title}":`, topicText.slice(0, 200));

            // Try array first, fall back to object with a resources key
            let jsonMatch = topicText.match(/\[[\s\S]*\]/);
            let candidates: Array<{
              url: string;
              title: string;
              resource_type: string;
              source_domain: string;
              ai_note: string;
              license_status: string;
            }> = [];

            if (!jsonMatch) {
              // Claude may have returned an object like { resources: [...] }
              const objMatch = topicText.match(/\{[\s\S]*\}/);
              if (objMatch) {
                try {
                  const parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
                  // Find any array value inside the object
                  const arrayValue = Object.values(parsed).find((v) => Array.isArray(v));
                  if (arrayValue) {
                    candidates = arrayValue as typeof candidates;
                  }
                } catch {
                  // ignore
                }
              }
              if (candidates.length === 0) {
                console.log(`No JSON found for topic "${node.title}", skipping`);
                continue;
              }
            } else {
              try {
                candidates = JSON.parse(jsonMatch[0]);
                if (!Array.isArray(candidates)) {
                  console.log(`JSON wasn't an array for topic "${node.title}", skipping`);
                  continue;
                }
              } catch {
                console.log(`Parse failed for topic "${node.title}", skipping`);
                continue;
              }
            }

            const resources = candidates
              .filter((c) => c.url && c.title)
              .map((c) => ({
                node_id: nodeId,
                major_understanding_id: null,
                url: c.url,
                title: c.title,
                source_domain: c.source_domain ?? "",
                resource_type: c.resource_type ?? "other",
                license_status: c.license_status ?? "link_only",
                embed_allowed: false,
                ai_note: c.ai_note ?? null,
                content_type_verified: true,
                status: "approved",
              }));

            if (resources.length > 0) {
              await supabase.from("resources").insert(resources);
            }
          } catch (err) {
            console.log(
              `Resource discovery failed for topic "${node.title}":`,
              err instanceof Error ? err.message : err
            );
            // If rate limited, wait and the next topic will still run
          }

          if (i < nodeIds.length - 1) {
            await new Promise((r) => setTimeout(r, 15000));
          }
        }

        // Publish the curriculum
        await supabase
          .from("curricula")
          .update({ status: "published" })
          .eq("id", id);

        send(controller, "complete", { curriculum_id: id });

        // Background per-understanding discovery — one batch call per topic
        (async () => {
          const { data: curriculumRow } = await supabase
            .from("curricula")
            .select("title")
            .eq("id", id)
            .single();

          const bgCurriculumTitle = curriculumRow?.title ?? curriculumTitle;

          for (let i = 0; i < nodeIds.length; i++) {
            const { nodeId, node } = nodeIds[i];

            const { data: muRows } = await supabase
              .from("major_understandings")
              .select("id, code, description, external_key")
              .eq("node_id", nodeId);

            if (!muRows || muRows.length === 0) continue;

            try {
              const prompt = buildTopicBatchPrompt(
                {
                  id: nodeId,
                  curriculum_id: id,
                  external_key: null,
                  title: node.title,
                  order_index: node.order_index,
                  exam_weight_pct: null,
                  claim_statement: null,
                  major_understandings: muRows.map((m) => ({
                    id: m.id,
                    node_id: nodeId,
                    external_key: m.external_key ?? m.code ?? null,
                    code: m.code ?? null,
                    description: m.description,
                    order_index: 0,
                  })),
                } as NodeWithChildren,
                bgCurriculumTitle,
                discoveredSources.map((s) => s.domain)
              );

              const text = await callClaude(prompt, true);
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (!jsonMatch) {
                console.log(`No JSON object found for batch topic "${node.title}"`);
                continue;
              }

              const parsed = JSON.parse(jsonMatch[0]) as {
                topic_resources: Array<{
                  url: string;
                  title: string;
                  resource_type: string;
                  source_domain: string;
                  ai_note: string;
                  license_status: string;
                  understanding_codes: string[];
                }>;
              };

              if (!Array.isArray(parsed.topic_resources)) continue;

              for (const candidate of parsed.topic_resources) {
                if (!candidate.url || !candidate.title) continue;

                const coveredMuIds = muRows
                  .filter((mu) =>
                    candidate.understanding_codes?.some(
                      (code) => code === mu.code || code === mu.external_key
                    )
                  )
                  .map((mu) => mu.id);

                const targetMuIds =
                  coveredMuIds.length > 0
                    ? coveredMuIds
                    : muRows.map((m) => m.id);

                const resources = targetMuIds.map((muId) => ({
                  node_id: null,
                  major_understanding_id: muId,
                  url: candidate.url,
                  title: candidate.title,
                  source_domain: candidate.source_domain ?? "",
                  resource_type: candidate.resource_type ?? "other",
                  license_status: candidate.license_status ?? "link_only",
                  embed_allowed: false,
                  ai_note: candidate.ai_note ?? null,
                  content_type_verified: true,
                  status: "approved",
                }));

                if (resources.length > 0) {
                  await supabase.from("resources").insert(resources);
                }
              }
            } catch (err) {
              console.log(`Batch discovery failed for topic "${node.title}":`, err);
            }

            if (i < nodeIds.length - 1) {
              await new Promise((r) => setTimeout(r, 15000));
            }
          }
        })();

        controller.close();
      } catch (err) {
        send(controller, "error", {
          message:
            err instanceof Error ? err.message : "Something went wrong",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}