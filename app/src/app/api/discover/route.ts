import { NextResponse } from "next/server";
import { buildDiscoverPrompt } from "@/lib/prompts/discover";
import { getNodesWithUnderstandings } from "@/lib/curriculum-data";
import { getAIProvider } from "@/lib/ai";
import {
  AcquisitionDedupTracker,
  acquireCandidate,
  type DiscoveryCandidate,
  type AcquisitionResult,
  DEFAULT_ACQUISITION_OPTIONS,
} from "@/lib/acquisition";
import { normalizeResourceType } from "@/lib/acquisition/resourceTypes";
import { extractEducationalEvidence } from "@/lib/evidence";
import { verifyContent } from "@/lib/verification";
import { persistVerifiedResource, type PersistenceResult } from "@/lib/persistence";
import { requireAdminApi } from "@/lib/auth";

export const maxDuration = 60;

type ResourceCandidate = {
  url: string;
  title: string;
  resource_type: string;
  source_domain: string;
  ai_note: string;
  license_status: "cc_open" | "link_only" | "unknown_review_needed";
};

// Lazy AI provider getter - avoids initialization at module load time (build time)
function getAI(operation: string): ReturnType<typeof getAIProvider> {
  return getAIProvider(undefined, { operation });
}

/**
 * Call AI for resource discovery with text completion and JSON extraction.
 * Preserves exact pre-6-Pre behavior: same prompts, same JSON extraction, same retry logic.
 */
async function callAIDiscover(prompt: string, signal?: AbortSignal): Promise<ResourceCandidate[]> {
  const textResult = await getAI("api_resource_discovery").complete(prompt, {
    useSearch: true,
    maxTokens: 2000,
    signal,
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

/**
 * Map a ResourceCandidate (from AI discovery) to a DiscoveryCandidate (for acquisition pipeline).
 * Only includes fields that DiscoveryCandidate accepts; license_status goes via callerMetadata.
 */
function mapToDiscoveryCandidate(candidate: ResourceCandidate): DiscoveryCandidate {
  return {
    url: candidate.url,
    title: candidate.title,
    sourceDomain: candidate.source_domain,
    resourceType: candidate.resource_type,
    aiNote: candidate.ai_note,
  };
}

/**
 * Build AcquisitionOptions with a conservative per-candidate timeout.
 * The route has a 60s budget; acquisition can involve DNS+HTTP+redirects.
 * Use 8s to leave margin for evidence/verification/persistence overhead.
 */
function getAcquisitionOptions(): typeof DEFAULT_ACQUISITION_OPTIONS {
  return {
    ...DEFAULT_ACQUISITION_OPTIONS,
    timeoutMs: 8000,
  };
}

/**
 * Check if enough time budget remains to process another candidate.
 * Returns true if we should continue, false if we should stop.
 */
export function hasTimeBudget(deadlineMs: number, minRequiredMs: number = 10000): boolean {
  return Date.now() + minRequiredMs < deadlineMs;
}

export async function POST(request: Request) {
  // Initialize deadline as early as possible to account for all route work
  const REQUEST_DEADLINE_MS = Date.now() + 55000; // 5s margin before Vercel 60s limit
  const AI_MAX_BUDGET_MS = 20000; // Max time for AI discovery call
  const PIPELINE_RESERVE_MS = 5000; // Reserve for response serialization + overhead
  const MIN_PIPELINE_PER_CANDIDATE_MS = 10000; // Minimum per candidate (acquisition + evidence + verification + persistence)

  // Helper to check if enough time remains for an operation
  const checkBudget = (deadlineMs: number, minRequiredMs: number): boolean => {
    return Date.now() + minRequiredMs < deadlineMs;
  };

  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const supabase = auth.supabase;
  const body = await request.json();
  const { node_id, curriculum_id, granularity, major_understanding_id } = body;

  console.log("Discover called:", { node_id, curriculum_id, granularity, major_understanding_id });

  if (!node_id || !curriculum_id) {
    return NextResponse.json(
      { error: "node_id and curriculum_id are required" },
      { status: 400 }
    );
  }

  // Check budget after auth and body parsing
  if (!checkBudget(REQUEST_DEADLINE_MS, 5000)) { // Minimum for DB lookups
    return NextResponse.json(
      { error: "Insufficient time budget for discovery" },
      { status: 503 }
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

  // Check budget before prompt building (minimal cost)
  if (!checkBudget(REQUEST_DEADLINE_MS, 1000)) {
    return NextResponse.json(
      { error: "Insufficient time budget for discovery" },
      { status: 503 }
    );
  }

  const prompt = buildDiscoverPrompt(
    node,
    granularity ?? "topic",
    mu?.code ?? undefined,
    mu?.description ?? undefined,
    curriculumTitle,
    []
  );

  // Check budget before AI call - need enough time for AI + pipeline reserve
  const aiBudgetAvailable = REQUEST_DEADLINE_MS - Date.now() - PIPELINE_RESERVE_MS;
  const aiBudgetMs = Math.min(20000, Math.max(5000, aiBudgetAvailable)); // At least 5s for AI

  if (aiBudgetMs < 5000) {
    return NextResponse.json(
      { error: "Insufficient time budget for AI discovery" },
      { status: 503 }
    );
  }

  // Create AbortController for AI call with timeout
  const aiController = new AbortController();
  const aiTimeoutId = setTimeout(() => aiController.abort(), 20000); // Fixed 20s timeout for AI

  let candidates: ResourceCandidate[];
  try {
    candidates = await callAIDiscover(prompt, aiController.signal);
  } catch (err) {
    // Ensure timeout timer is always cleaned up
    clearTimeout(aiTimeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      console.log("AI discovery timed out");
      return NextResponse.json(
        { error: "Discovery timed out" },
        { status: 504 }
      );
    }
    console.log("AI discover failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to discover resources" },
      { status: 500 }
    );
  } finally {
    // Always clean up the timeout timer
    clearTimeout(aiTimeoutId);
  }

  // Create ONE dedup tracker for this entire discovery request
  const dedupTracker = new AcquisitionDedupTracker();

  // Request-scoped acquisition job ID for exact-retry idempotency within this request.
  // Separate POST requests will have different IDs — cross-request exact-retry is not guaranteed.
  const acquisitionJobId = crypto.randomUUID();

  let insertedCount = 0;
  let skippedCount = 0;
  let unprocessedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];

    // Check request-wide time budget before processing next candidate
    if (!checkBudget(REQUEST_DEADLINE_MS, 10000)) {
      console.log("Time budget exhausted, skipping remaining candidates");
      unprocessedCount = candidates.length - i;
      break;
    }

    if (!candidate.url || !candidate.title) {
      skippedCount++;
      continue;
    }

    // Validate resource type
    const resourceType = normalizeResourceType(candidate.resource_type);

    // Map to DiscoveryCandidate for the acquisition pipeline
    const discoveryCandidate = mapToDiscoveryCandidate({ ...candidate, resource_type: resourceType });

    // ---- ACQUISITION ----
    // Check budget before acquisition (network call, may take several seconds)
    if (!checkBudget(REQUEST_DEADLINE_MS, 15000)) { // acquisition needs ~15s budget
      console.log("Insufficient budget for acquisition, skipping candidate");
      unprocessedCount = candidates.length - i;
      break;
    }

    let acquisitionResult: AcquisitionResult;
    try {
      acquisitionResult = await acquireCandidate(
        discoveryCandidate,
        getAcquisitionOptions(),
        dedupTracker
      );
    } catch (err) {
      console.log("Acquisition error:", err instanceof Error ? err.message : err, "for url:", candidate.url);
      skippedCount++;
      continue;
    }

    if (!acquisitionResult.success || !acquisitionResult.acquiredPage || !acquisitionResult.structuredContent) {
      console.log("Acquisition failed:", acquisitionResult.error?.code, acquisitionResult.error?.message, "for url:", candidate.url);
      skippedCount++;
      continue;
    }

    const { acquiredPage, structuredContent } = acquisitionResult;

    // Check budget before evidence extraction (synchronous but may process large content)
    if (!checkBudget(REQUEST_DEADLINE_MS, 3000)) {
      console.log("Insufficient budget for evidence extraction, skipping candidate");
      unprocessedCount = candidates.length - i;
      break;
    }

    // ---- EVIDENCE EXTRACTION ----
    let educationalEvidence;
    try {
      educationalEvidence = extractEducationalEvidence(structuredContent);
    } catch (err) {
      console.log("Evidence extraction error:", err instanceof Error ? err.message : err, "for url:", candidate.url);
      skippedCount++;
      continue;
    }

    // Check budget before verification (synchronous but may process large content)
    if (!checkBudget(REQUEST_DEADLINE_MS, 3000)) {
      console.log("Insufficient budget for verification, skipping candidate");
      unprocessedCount = candidates.length - i;
      break;
    }

    // ---- VERIFICATION ----
    let verificationResult;
    try {
      verificationResult = verifyContent({
        acquiredPage: {
          contentHash: acquiredPage.contentHash,
          canonicalUrl: acquiredPage.canonicalUrl.url,
          finalUrl: acquiredPage.finalUrl,
          statusCode: acquiredPage.statusCode,
          contentType: acquiredPage.contentType,
          acquiredAt: acquiredPage.acquiredAt,
        },
        structuredContent,
        educationalEvidence,
      });
    } catch (err) {
      console.log("Verification error:", err instanceof Error ? err.message : err, "for url:", candidate.url);
      skippedCount++;
      continue;
    }

    // Check budget before persistence (DB write, may take several seconds)
    if (!checkBudget(REQUEST_DEADLINE_MS, 10000)) { // persistence needs ~10s budget
      console.log("Insufficient budget for persistence, skipping candidate");
      unprocessedCount = candidates.length - i;
      break;
    }

    // ---- PERSISTENCE ----
    // Build caller metadata from discovery context
    const licenseStatus = candidate.license_status ?? "link_only";

    let persistenceResult: PersistenceResult;
    try {
      persistenceResult = await persistVerifiedResource({
        acquiredPage,
        structuredContent,
        educationalEvidence,
        verificationResult,
        target: {
          nodeId: mu ? undefined : node_id,
          understandingId: mu ? mu.id : undefined,
        },
        acquisitionJobId,
        callerMetadata: {
          resourceType: resourceType,
          licenseStatus,
          aiNote: candidate.ai_note ?? null,
        } as import("@/lib/persistence").ResourceCallerMetadata,
      });
    } catch (err) {
      console.log("Persistence error:", err instanceof Error ? err.message : err, "for url:", candidate.url);
      skippedCount++;
      continue;
    }

    // Count based on actual persistence outcome
    if (persistenceResult.resource.isNew) {
      insertedCount++;
    } else {
      // Existing resource (dedup or exact retry) — not a new insertion
      skippedCount++;
    }
  }

  console.log(`Inserted: ${insertedCount}, Skipped: ${skippedCount}, Unprocessed: ${unprocessedCount}`);

  return NextResponse.json({
    inserted: insertedCount,
    skipped: skippedCount,
    unprocessed: unprocessedCount,
    message: `${insertedCount} new resources persisted${unprocessedCount > 0 ? `; ${unprocessedCount} unprocessed due to time limit` : ""}`,
  });
}
