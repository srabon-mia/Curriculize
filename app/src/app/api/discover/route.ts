import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { buildDiscoverPrompt } from "@/lib/prompts/discover";
import { getNodesWithUnderstandings, getDomainScores } from "@/lib/curriculum-data";
import { getAIProvider } from "@/lib/ai";

export const maxDuration = 60;

type ResourceCandidate = {
  url: string;
  title: string;
  resource_type: string;
  source_domain: string;
  ai_note: string;
  license_status: "cc_open" | "link_only" | "unknown_review_needed";
};

const VALID_TYPES = [
  "video", "text", "textbook", "problem_set",
  "reference_tool", "practice_exam", "other"
];

// Lazy AI provider getter - avoids initialization at module load time (build time)
function getAI(): ReturnType<typeof getAIProvider> {
  return getAIProvider();
}

/**
 * Call AI for resource discovery with text completion and JSON extraction.
 * Preserves exact pre-6-Pre behavior: same prompts, same JSON extraction, same retry logic.
 */
async function callAIDiscover(prompt: string): Promise<ResourceCandidate[]> {
  const textResult = await getAI().complete(prompt, {
    useSearch: true,
    maxTokens: 2000,
  });

  // Extract JSON array from wherever it appears in the text
  // Claude sometimes wraps it in prose, sometimes returns it clean
  const allText = textResult.text;
  const jsonMatch = allText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log("No JSON array found in response:", allText.slice(0, 300));
    throw new Error("No JSON array found in AI response");
  }

  let candidates: ResourceCandidate[];
  try {
    candidates = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(candidates)) throw new Error("Not an array");
  } catch (e) {
    console.log("Parse error:", e, "matched text:", jsonMatch[0].slice(0, 300));
    throw new Error("Failed to parse AI response as JSON");
  }

  console.log(`Parsed ${candidates.length} candidates`);
  return candidates;
}

export async function POST(request: Request) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { node_id, curriculum_id, granularity, major_understanding_id } = body;

  console.log("Discover called:", { node_id, curriculum_id, granularity, major_understanding_id });

  if (!node_id || !curriculum_id) {
    return NextResponse.json(
      { error: "node_id and curriculum_id are required" },
      { status: 400 }
    );
  }

  const nodes = await getNodesWithUnderstandings(curriculum_id);
  const node = nodes.find((n) => n.id === node_id);
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }

  const { data: curriculumRow } = await supabase
    .from("curricula")
    .select("title")
    .eq("id", curriculum_id)
    .single();

  const curriculumTitle = curriculumRow?.title ?? "the course";

  const mu = major_understanding_id
    ? node.major_understandings.find((m) => m.id === major_understanding_id)
    : null;

  console.log("Found MU:", mu ? { id: mu.id, code: mu.code } : null);

  const prompt = buildDiscoverPrompt(
    node,
    granularity ?? "topic",
    mu?.code ?? undefined,
    mu?.description ?? undefined,
    curriculumTitle,
    []
  );

  let candidates: ResourceCandidate[];
  try {
    candidates = await callAIDiscover(prompt);
  } catch (err) {
    console.log("AI discover failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to discover resources" },
      { status: 500 }
    );
  }

  const domainScores = await getDomainScores();
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const candidate of candidates) {
    if (!candidate.url || !candidate.title) {
      skipped.push(candidate.url ?? "unknown");
      continue;
    }

    const resourceType = VALID_TYPES.includes(candidate.resource_type)
      ? candidate.resource_type
      : "other";

    const domain = candidate.source_domain ?? "";
    const domainScore = domainScores[domain] ?? 2;
    const embedAllowed =
      candidate.license_status === "cc_open" && domainScore >= 4;

    console.log("Inserting:", {
      url: candidate.url,
      node_id: mu ? null : node_id,
      major_understanding_id: mu ? mu.id : null,
    });

    const { error } = await supabase.from("resources").insert({
      node_id: mu ? null : node_id,
      major_understanding_id: mu ? mu.id : null,
      url: candidate.url,
      title: candidate.title,
      source_domain: domain,
      resource_type: resourceType,
      license_status: candidate.license_status ?? "link_only",
      embed_allowed: embedAllowed,
      ai_note: candidate.ai_note ?? null,
      content_type_verified: true,
      status: "draft",
    });

    if (error) {
      console.log("Insert error:", error.message, "for url:", candidate.url);
      skipped.push(candidate.url);
    } else {
      inserted.push(candidate.url);
    }
  }

  console.log(`Inserted: ${inserted.length}, Skipped: ${skipped.length}`);

  return NextResponse.json({
    inserted: inserted.length,
    skipped: skipped.length,
    message: `${inserted.length} resources added to review queue`,
  });
}