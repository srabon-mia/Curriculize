import { createClient as createServiceClient } from "@supabase/supabase-js";
import { buildSkeletonPrompt } from "@/lib/prompts/skeleton";
import { buildDiscoverPrompt, buildTopicBatchPrompt } from "@/lib/prompts/discover";
import { buildSourceDiscoveryPrompt } from "@/lib/prompts/sources";
import type { NodeWithChildren } from "@/lib/curriculum-data";
import { getAIProvider } from "@/lib/ai";
import {
  discoverVerifiedResource,
  type LearnParams,
} from "@/lib/learningEngine";
import {
  createCache,
  getCacheStore,
} from "@/lib/cache";
import { AcquisitionDedupTracker } from "@/lib/acquisition";

export const maxDuration = 300;

const supabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Lazy AI provider getter - avoids initialization at module load time (build time)
function getAI(): ReturnType<typeof getAIProvider> {
  return getAIProvider();
}

/**
 * Call AI provider with text completion.
 * Preserves exact pre-6-Pre behavior: same prompts, same retry logic.
 * Returns raw text response; callers handle JSON extraction.
 */
async function callAI(prompt: string, useSearch = true): Promise<string> {
  const textResult = await getAI().complete(prompt, {
    useSearch,
    maxTokens: 4000,
  });
  return textResult.text;
}

/**
 * Call AI for source discovery (no search, smaller max tokens).
 * Preserves exact pre-6-Pre behavior.
 * Returns raw text response; callers handle JSON extraction.
 */
async function callAISources(prompt: string): Promise<string> {
  const textResult = await getAI().complete(prompt, {
    useSearch: false,
    maxTokens: 2000,
  });
  return textResult.text;
}

/**
 * Fetch the acquisition job id for this curriculum, if one exists.
 * POST /api/generate creates a pending job (job_type='curriculum_generation')
 * before opening the SSE stream; the job id is recorded against verification
 * evidence for idempotent retry-dedup (Phase 9). When no job exists (e.g. job
 * creation failed at POST time), returns undefined — persistence still works,
 * it simply skips job-scoped retry dedup.
 */
async function getAcquisitionJobId(curriculumId: string): Promise<string | undefined> {
  const { data } = await supabase
    .from("acquisition_jobs")
    .select("id")
    .eq("curriculum_id", curriculumId)
    .eq("job_type", "curriculum_generation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id;
}

/** Normalize an AI discovery candidate into the Learning Engine input shape. */
function toLearnParams(
  candidate: Record<string, unknown>,
  target: { nodeId?: string; understandingId?: string },
  acquisitionJobId?: string,
  aiNote?: string | null
): LearnParams {
  return {
    candidate: {
      url: String(candidate.url),
      title: candidate.title ? String(candidate.title) : undefined,
      resourceType: candidate.resource_type ? String(candidate.resource_type) : undefined,
      licenseStatus: (candidate.license_status as
        | "cc_open"
        | "link_only"
        | "unknown_review_needed"
        | undefined) ?? "link_only",
      aiNote: (candidate.ai_note as string | undefined) ?? aiNote ?? null,
    },
    target,
    acquisitionJobId,
  };
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

        const skeleton = await callAI(skeletonPrompt, true);

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

        let skeletonParsed: Skeleton;
        try {
          const jsonMatch = (skeleton as string).match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          skeletonParsed = JSON.parse(jsonMatch[0]) as Skeleton;
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
            title: skeletonParsed.title,
            source_type: skeletonParsed.source_type,
            source_attribution: skeletonParsed.source_attribution,
            source_url: skeletonParsed.source_url,
          })
          .eq("id", id);

        const curriculumTitle = skeletonParsed.title;

        send(controller, "skeleton", {
          title: skeletonParsed.title,
          topic_count: skeletonParsed.nodes.length,
        });

        // Step 2: Insert nodes and major understandings
        const nodeIds: Array<{
          nodeId: string;
          node: SkeletonNode;
        }> = [];

        for (const node of skeletonParsed.nodes) {
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
          const sourcesText = await callAISources(sourcesPrompt);
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

        // Step 4: Discover topic-level resources during generation.
        //
        // Phase 12: candidates are routed through the Learning Engine
        // (acquire → evidence → verify → persist) via discoverVerifiedResource(),
        // not inserted directly. This writes every resource as status='draft'
        // (pending admin approval) with content_type_verified derived from the
        // deterministic verification gate — never hardcoded.
        //
        // A scoped cache + dedup tracker spans the topic loop AND the later
        // background per-understanding batch so the same URL is acquired at
        // most once within this generation request (Phase 11 cache keys).
        const cache = createCache({ enabled: true, maxEntries: 200 });
        const dedupTracker = new AcquisitionDedupTracker();
        const acquisitionJobId = await getAcquisitionJobId(id);

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

            const topicText = await callAI(topicPrompt, true);

            // Try array first, fall back to object with a resources key
            const jsonMatch = topicText.match(/\[[\s\S]*\]/);
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

            const persisted = [];
            for (const c of candidates.filter((c) => c.url && c.title)) {
              const params = toLearnParams(
                c as Record<string, unknown>,
                { nodeId },
                acquisitionJobId,
                c.ai_note ?? null
              );
              try {
                const out = await discoverVerifiedResource(params, {
                  cache,
                  dedupTracker,
                });
                if (out) {
                  persisted.push(out);
                }
              } catch (routeErr) {
                // acquireVerifyPersist already isolates per-candidate failures,
                // but guard here so one unexpected error can't abort the topic.
                console.log(
                  `learnResource threw for ${c.url}:`,
                  routeErr instanceof Error ? routeErr.message : routeErr
                );
              }
            }

            if (persisted.length > 0) {
              console.log(
                `Topic "${node.title}": ${persisted.length}/${candidates.length} candidates persisted ` +
                  `(verified: ${persisted.filter((p) => p.verificationStatus === "verified").length})`
              );
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

              const text = await callAI(prompt, true);
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

                // Phase 12: persist each (candidate, understanding) pair through the
                // Learning Engine so it goes through acquisition + verification +
                // evidence before landing as a draft resource. The scoped cache
                // makes re-acquiring the same URL (for other MUs) a cache hit, so
                // this does not multiply network fetches. No dedup tracker here:
                // a URL legitimately targets multiple understandings.
                let batchPersisted = 0;
                for (const muId of targetMuIds) {
                  const params = toLearnParams(
                    candidate as Record<string, unknown>,
                    { understandingId: muId },
                    acquisitionJobId,
                    candidate.ai_note ?? null
                  );
                  try {
                    const out = await discoverVerifiedResource(params, { cache });
                    if (out) batchPersisted++;
                  } catch (routeErr) {
                    console.log(
                      `learnResource threw for ${candidate.url} (mu ${muId}):`,
                      routeErr instanceof Error ? routeErr.message : routeErr
                    );
                  }
                }

                if (batchPersisted > 0) {
                  console.log(
                    `Batch topic "${node.title}": ${batchPersisted}/${targetMuIds.length} ` +
                      `MU mappings persisted for "${candidate.title}"`
                  );
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