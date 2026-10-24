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
import { createCache } from "@/lib/cache";
import { AcquisitionDedupTracker } from "@/lib/acquisition";
import { DEFAULT_BUDGET_LIMITS } from "@/lib/acquisition/jobTypes";
import { CandidateArraySchema, SourcesArraySchema } from "@/lib/acquisition/discoverySchemas";
import {
  reserveAICall,
  releaseJobClaim,
  recordResourceCoverageAttempt,
} from "@/lib/acquisition/jobService";
import { runBoundedCoverageAttempts, mapUnderstandingCodesToIds } from "@/lib/acquisition/coverage";
import { PersistenceError } from "@/lib/persistence";
import { z } from "zod";

export const maxDuration = 300;

// Maximum topics to process per SSE invocation before yielding.
// Matches the durable worker's MAX_TOPICS_PER_INVOCATION to ensure
// the job stays within the 300s Vercel limit and can resume via cron.
const MAX_TOPICS_PER_SSE_INVOCATION = 2;
const MAX_COVERAGE_ATTEMPTS = 2;

const supabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Lazy AI provider getter - avoids initialization at module load time (build time)
function getAI(operation: string): ReturnType<typeof getAIProvider> {
  return getAIProvider(undefined, { operation });
}

/**
 * Skeleton schema for validation - matches the Skeleton type in the stream handler.
 */
const SkeletonNodeSchema = z.object({
  title: z.string().min(1),
  order_index: z.number().int().positive(),
  major_understandings: z.array(
    z.object({
      code: z.string().nullable(),
      description: z.string().min(1),
    })
  ).min(1),
});

const SkeletonSchema = z.object({
  title: z.string().min(1),
  source_type: z.enum(["adapted", "ai_organized"]),
  source_attribution: z.string().nullable(),
  source_url: z.string().nullable(),
  nodes: z.array(SkeletonNodeSchema).min(1).max(12),
});

type Skeleton = z.infer<typeof SkeletonSchema>;
type SkeletonNode = z.infer<typeof SkeletonNodeSchema>;

/**
 * Extract a JSON object from text, handling common formatting issues:
 * - Markdown code fences (```json ... ```)
 * - Explanatory text around a single JSON object
 * - Multiple JSON objects (returns first valid one matching schema)
 */
function extractSkeletonJson(text: string): Skeleton | null {
  // Strategy 1: Try to find JSON in markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      const result = SkeletonSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Fall through to next strategy
    }
  }

  // Strategy 2: Try greedy match for a single JSON object
  // Match from first { to last } but validate it's a single object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const result = SkeletonSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Fall through
    }
  }

  // Strategy 3: scan complete top-level objects. Unlike repeatedly shrinking
  // a greedy match, this always makes progress on malformed output and can
  // select a valid object when the response contains multiple JSON objects.
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          const parsed = JSON.parse(text.slice(objectStart, i + 1));
          const result = SkeletonSchema.safeParse(parsed);
          if (result.success) return result.data;
        } catch {
          // Try the next complete top-level object, if any.
        }
        objectStart = -1;
      }
    }
  }

  return null;
}

// Leave time inside this route's 300s execution limit for cleanup and checkpointing.
const AI_CALL_TIMEOUT_MS = 4 * 60 * 1000;
const STALL_TIMEOUT_MS = 4 * 60 * 1000;

class AITimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out after ${AI_CALL_TIMEOUT_MS / 1000}s`);
    this.name = "AITimeoutError";
  }
}

/**
 * Call AI provider with text completion.
 * Preserves exact pre-6-Pre behavior: same prompts, same retry logic.
 * Returns raw text response; callers handle JSON extraction.
 * Verifies web search completion when useSearch=true.
 * Includes a timeout to prevent indefinite hangs.
 */
async function callAI(prompt: string, useSearch = true, operation = "text_completion"): Promise<string> {
  const startTime = Date.now();
  const provider = getAI(operation);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_CALL_TIMEOUT_MS);
  let textResult;
  try {
    textResult = await provider.complete(prompt, {
      useSearch,
      maxTokens: 4000,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AITimeoutError("AI call");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startTime;

  // Verify web search completed when requested (Priority 2)
  if (useSearch && textResult.searchCompleted === false) {
    console.error(
      `[stream] Web search did not complete: provider=${provider.name}, searchCompleted=false, response_chars=${textResult.text.length}`
    );
    throw new Error(`Web search required but did not complete (provider: ${provider.name})`);
  }

  console.log(
    `[stream] AI call completed: provider=${provider.name}, duration_ms=${durationMs}, response_chars=${textResult.text.length}, searchCompleted=${textResult.searchCompleted ?? 'N/A'}`
  );
  return textResult.text;
}

/**
 * Call AI provider for structured output with native schema validation.
 * Uses provider.structured() where available (OpenRouter, Azure) or
 * falls back to prompt-based extraction with Zod validation (Anthropic).
 * Verifies web search completion when useSearch=true.
 * Includes a timeout to prevent indefinite hangs.
 */
async function callAIStructured<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  useSearch = true,
  operation = "structured_completion",
  diagnostics?: {
    curriculumId?: string;
    jobId?: string;
    streamId?: string;
    topicId?: string;
  }
): Promise<T> {
  const startTime = Date.now();
  const provider = getAI(operation);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_CALL_TIMEOUT_MS);
  let result;
  try {
    result = await provider.structured(prompt, {
      schema,
      useSearch,
      maxTokens: 4000,
      signal: controller.signal,
      diagnostics: { ...diagnostics, operation, attemptNumber: 1 },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AITimeoutError("Structured AI call");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startTime;

  // Verify web search completed when requested (Priority 2)
  // Note: structured() doesn't return searchCompleted, but the underlying
  // complete() call would have. For providers that support structured output
  // with search, we assume search runs as part of the structured call.
  if (useSearch && provider.capabilities.webSearch) {
    // The structured() call internally uses complete() with useSearch,
    // so we can't directly check searchCompleted. Log for diagnostics.
    console.log(
      `[stream] Structured AI call completed: provider=${provider.name}, duration_ms=${durationMs}, webSearchCapable=${provider.capabilities.webSearch}`
    );
  }

  return result.data;
}

/**
 * Call AI provider for source discovery (no search, smaller max tokens).
/**
 * Schema for batch discovery response (object with topic_resources array).
 */
const BatchResponseSchema = z.object({
  topic_resources: z.array(
    z.object({
      url: z.string().url(),
      title: z.string().min(1),
      resource_type: z.enum(["video", "text", "textbook", "problem_set", "reference_tool", "practice_exam", "other"]),
      source_domain: z.string().min(1),
      ai_note: z.string().min(1),
      license_status: z.enum(["cc_open", "link_only"]),
      understanding_codes: z.array(z.string()),
    })
  ),
});

/**
 * Normalize an AI discovery candidate into the Learning Engine input shape.
 */
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

/**
 * Job ownership protocol for the SSE inline generation path.
 *
 * This is the ONLY way the SSE route acquires a job — it never processes a job
 * it found merely by SELECT-ing a row. It either (a) atomically claims an
 * existing *pending* job via the claim_next_job RPC, or (b) inserts a new job
 * already in 'running' state with a real claim_token. Both paths produce a
 * valid, exclusive claim before ANY pipeline work begins.
 *
 * Guest generation is supported: the INSERT uses created_by = NULL (no
 * authenticated user exists). This is secure because:
 *   - The service-role client bypasses RLS (existing pattern for ingestion routes).
 *   - _validate_owner is NOT involved — we bypass create_curriculum_and_job
 *     RPC entirely for the guest path, inserting directly as 'running'.
 *   - The job is immediately 'running' with a real claim_token, so
 *     claim_next_job (cron) NEVER sees it as 'pending' — no double-processing.
 *
 * Concurrency safety:
 *   - claim_next_job uses FOR UPDATE SKIP LOCKED (atomic claim).
 *   - The INSERT's status='running' + uq_aj_active_generation unique index
 *     guarantees at most one active job per curriculum. A collision
 *     (unique violation) means another process owns the job → we retry
 *     claim_next_job, then if still no job, report "already in progress".
 *
 * @param curriculumId The curriculum this job will generate resources for.
 * @param inputData The generation parameters (mirrored from curriculum notes).
 * @returns The claimed/registered job, or null if ownership could not be obtained
 *          (e.g., another process already owns a running job).
 */
/**
 * Result of claimOrRegisterJob - either a new/claimed job, or an observer
 * attached to an existing running job.
 */
type ClaimResult =
  | {
      // New or claimed job - we own the claim_token and can do work
      mode: "owner";
      id: string;
      claim_token: string;
      claim_version: number;
    }
  | {
      // Observer attached to an existing running job - read-only
      mode: "observer";
      jobId: string;
      curriculumStatus: "draft" | "published";
      checkpoints: {
        completedTopicIds: string[];
        batchCompletedTopicIds: string[];
      };
    }
  | null; // Could not obtain job (should not happen with current logic)

/**
 * Claim or register a job, or attach as observer to an existing running job.
 */
export async function claimOrRegisterJob(
  curriculumId: string,
  inputData: Record<string, unknown>
): Promise<ClaimResult> {
  // 1. Atomically claim any existing *pending* job for this curriculum.
  //    claim_next_job only claims status='pending' (never 'running'),
  //    so this is race-free against other SSE/claim attempts.
  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_next_job",
    {
      p_job_type: "curriculum_generation",
      p_curriculum_id: curriculumId,
    }
  );

  if (claimError) {
    console.error("[stream] claim_next_job RPC error:", claimError.message);
  }

  if (claimed && typeof claimed === "object" && "id" in claimed && claimed.id) {
    console.log(
      `[stream] Atomically claimed existing job ${claimed.id} for curriculum ${curriculumId}`
    );
    return {
      mode: "owner",
      id: claimed.id,
      claim_token: claimed.claim_token,
      claim_version: claimed.claim_version,
    };
  }

  // 2. No pending job — atomically INSERT a new job as 'running' with a real
  //    claim token. INSERT is a single atomic statement; the
  //    uq_aj_active_generation unique index on (curriculum_id, job_type)
  //    WHERE status IN ('pending','running') prevents any concurrent insert
  //    from creating a second active job for the same curriculum.
  const claimToken = crypto.randomUUID();
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60_000).toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from("acquisition_jobs")
    .insert({
      curriculum_id: curriculumId,
      job_type: "curriculum_generation",
      status: "running",
      claim_token: claimToken,
      claim_version: 1,
      claim_expires_at: fiveMinutesFromNow,
      started_at: new Date().toISOString(),
      input_data: inputData,
      budget_limits: DEFAULT_BUDGET_LIMITS,
      created_by: null,
    })
    .select("id, claim_token, claim_version")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      // Unique constraint violation on uq_aj_active_generation.
      // Another SSE request (or cron worker) already created a job for
      // this curriculum. Retry claim_next_job — it may find the job in
      // pending state (if the other path created pending, not running).
      const { data: retryClaimed } = await supabase.rpc("claim_next_job", {
        p_job_type: "curriculum_generation",
        p_curriculum_id: curriculumId,
      });

      if (
        retryClaimed &&
        typeof retryClaimed === "object" &&
        "id" in retryClaimed &&
        retryClaimed.id
      ) {
        console.log(
          `[stream] Claimed job on retry after unique violation: ${retryClaimed.id}`
        );
        return {
          mode: "owner",
          id: retryClaimed.id,
          claim_token: retryClaimed.claim_token,
          claim_version: retryClaimed.claim_version,
        };
      }

      // Another SSE request owns a running job — attach as observer.
      console.log(
        `[stream] Attaching as observer to running job for curriculum ${curriculumId}`
      );
      return await attachAsObserver(curriculumId);
    }

    // Some other insert error
    console.error("[stream] Failed to register job:", insertError.message);
    return null;
  }

  if (!inserted) {
    console.error("[stream] Job INSERT returned no data");
    return null;
  }

  console.log(`[stream] Registered new job ${inserted.id} for curriculum ${curriculumId}`);
  return {
    mode: "owner",
    id: inserted.id,
    claim_token: inserted.claim_token,
    claim_version: inserted.claim_version,
  };
}

/**
 * Attach as read-only observer to an existing running job.
 * Returns the job's checkpoints so the SSE stream can report progress.
 */
async function attachAsObserver(curriculumId: string): Promise<ClaimResult> {
  // Find the running job for this curriculum
  const { data: runningJob } = await supabase
    .from("acquisition_jobs")
    .select("id, result_data, curriculum_id, curricula!inner(status)")
    .eq("curriculum_id", curriculumId)
    .eq("job_type", "curriculum_generation")
    .eq("status", "running")
    .single();

  if (!runningJob) {
    console.error(`[stream] No running job found for curriculum ${curriculumId}`);
    return null;
  }

  const resultData = runningJob.result_data as
    | {
        checkpoint?: { completedTopicIds: string[] };
        batchCheckpoint?: { completedTopicIds: string[] };
      }
    | null
    | undefined;

  const curriculumRelation = (runningJob as {
    curricula?: { status: string } | { status: string }[] | null;
  }).curricula;
  const curriculumStatus = (
    Array.isArray(curriculumRelation)
      ? curriculumRelation[0]?.status
      : curriculumRelation?.status
  ) ?? "draft";

  return {
    mode: "observer",
    jobId: runningJob.id,
    curriculumStatus: curriculumStatus === "published" ? "published" : "draft",
    checkpoints: {
      completedTopicIds: resultData?.checkpoint?.completedTopicIds ?? [],
      batchCompletedTopicIds: resultData?.batchCheckpoint?.completedTopicIds ?? [],
    },
  };
}

/**
 * Renew the lease on the owned job. Returns true if the lease was still valid
 * and renewed; false if ownership was lost (lease expired or claim replaced).
 */
export async function renewLease(jobId: string, claimToken: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("renew_lease", {
    p_job_id: jobId,
    p_claim_token: claimToken,
  });

  if (error) {
    console.error(`[stream] renew_lease RPC error: job_id=${jobId}, error=${error.message}`);
    return false;
  }

  const renewed = data === true;
  if (!renewed) {
    console.error(`[stream] Lease renewal failed: job_id=${jobId}, reason=not_found_or_expired`);
  }
  return renewed;
}

/**
 * Advance the checkpoint for a completed topic. Returns true on success.
 * A false return means ownership was lost (lease expired or claim replaced)
 * — the caller should stop processing.
 */
export async function advanceCheckpoint(
  jobId: string,
  claimToken: string,
  claimVersion: number,
  completedTopicId: string,
  resourcesFound: number
): Promise<boolean> {
  const { data, error } = await supabase.rpc("advance_checkpoint", {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: claimVersion,
    p_completed_topic_id: completedTopicId,
    p_resources_found: resourcesFound,
  });

  if (error) {
    console.error("[stream] advance_checkpoint RPC error:", error.message);
    return false;
  }

  if (!data) {
    console.error(
      `[stream] advance_checkpoint returned false — ownership lost for job ${jobId}`
    );
    return false;
  }

  return true;
}

/**
 * Advance the BATCH-phase checkpoint for a completed topic.
 *
 * Uses a separate scope ('batchCheckpoint') from the topic-level checkpoint
 * so that per-understanding batch discovery progress is tracked independently.
 * Sharing one scope would let a completed batch write mark a topic as
 * topic-level-complete, causing a resumed worker to skip topic discovery that
 * never actually ran.
 */
export async function advanceBatchCheckpoint(
  jobId: string,
  claimToken: string,
  claimVersion: number,
  completedTopicId: string,
  resourcesFound: number
): Promise<boolean> {
  const { data, error } = await supabase.rpc("advance_batch_checkpoint", {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: claimVersion,
    p_completed_topic_id: completedTopicId,
    p_resources_found: resourcesFound,
  });

  if (error) {
    console.error("[stream] advance_batch_checkpoint RPC error:", error.message);
    return false;
  }

  if (!data) {
    console.error(
      `[stream] advance_batch_checkpoint returned false — ownership lost for job ${jobId}`
    );
    return false;
  }

  return true;
}

/**
 * Mark the job as completed. Returns true on success.
 * MUST only be called after ALL required work (including background batch)
 * is fully persisted. A false return means the claim is no longer valid.
 */
export async function completeJob(
  jobId: string,
  claimToken: string,
  claimVersion: number,
  hasProgress: boolean
): Promise<boolean> {
  const { data, error } = await supabase.rpc("complete_job", {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: claimVersion,
    p_has_progress: hasProgress,
  });

  if (error) {
    console.error("[stream] complete_job RPC error:", error.message);
    return false;
  }

  if (!data) {
    console.error(
      `[stream] complete_job returned false — ownership lost for job ${jobId}`
    );
    return false;
  }

  return true;
}

/**
 * Mark the job as failed. Returns true on success.
 */
export async function failJob(
  jobId: string,
  claimToken: string,
  claimVersion: number,
  errorMsg: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("fail_job", {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: claimVersion,
    p_error: errorMsg,
  });

  if (error) {
    console.error("[stream] fail_job RPC error:", error.message);
    return false;
  }

  if (!data) {
    console.error(
      `[stream] fail_job returned false — ownership lost for job ${jobId}`
    );
    return false;
  }

  return true;
}

const OBSERVER_POLL_MS = 10_000;
const OBSERVER_WINDOW_MS = 3.5 * 60_000;

/**
 * The browser connection only observes durable state. The scheduled processor
 * is the sole owner of discovery work; this stream yields before Vercel's
 * request limit so the client can reconnect without starting another job.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const encoder = new TextEncoder();
  let closed = false;
  let cancelPoll: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed || request.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* client disconnected */ }
      };

      try {
        const { data: curriculum, error: curriculumError } = await supabase
          .from("curricula")
          .select("title, notes")
          .eq("id", id)
          .single();
        if (curriculumError) {
          send("status", { message: "Checking saved generation status…", step: "status_unavailable" });
          send("continue", {});
          close();
          return;
        }
        if (!curriculum) {
          send("error", { message: "Curriculum not found." });
          close();
          return;
        }

        const notes = curriculum.notes ? JSON.parse(curriculum.notes) as Record<string, unknown> : {};
        const inputData = {
          topic: curriculum.title,
          grade_level: notes.grade_level ?? "high school",
          difficulty: notes.difficulty ?? "standard",
          existing_knowledge: notes.existing_knowledge ?? "",
          learning_goal: notes.learning_goal ?? "understand the subject",
          time_available: notes.time_available ?? "no time pressure",
          added_context: notes.added_context ?? "",
        };

        // A reconnect to a terminal job must observe it, never create a second job.
        const { data: latestJob, error: latestError } = await supabase
          .from("acquisition_jobs")
          .select("id, status, error, result_data")
          .eq("curriculum_id", id)
          .eq("job_type", "curriculum_generation")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestError) {
          send("status", { message: "Generation is saved; checking its latest status…", step: "status_unavailable" });
          send("continue", {});
          close();
          return;
        }

        if (latestJob?.status === "completed") {
          send("complete", { curriculum_id: id, phase: "background" });
          close();
          return;
        }
        if (latestJob?.status === "failed") {
          send("error", { message: latestJob.error || "Generation failed." });
          close();
          return;
        }

        let jobId = latestJob?.id as string | undefined;
        if (!jobId) {
          const { data: inserted, error: insertError } = await supabase
            .from("acquisition_jobs")
            .insert({
              curriculum_id: id,
              job_type: "curriculum_generation",
              status: "pending",
              input_data: inputData,
              budget_limits: DEFAULT_BUDGET_LIMITS,
              created_by: null,
            })
            .select("id")
            .single();

          if (insertError?.code === "23505") {
            // Another browser request or processor created the active job.
            // Re-read it instead of inserting a duplicate or claiming it.
            const { data: activeJob, error: activeError } = await supabase
              .from("acquisition_jobs")
              .select("id, status, error, result_data")
              .eq("curriculum_id", id)
              .eq("job_type", "curriculum_generation")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (activeError) throw new Error(`Could not observe active generation job: ${activeError.message}`);
            if (activeJob?.status === "completed") {
              send("complete", { curriculum_id: id, phase: "background" });
              close();
              return;
            }
            if (activeJob?.status === "failed") {
              send("error", { message: activeJob.error || "Generation failed." });
              close();
              return;
            }
            jobId = activeJob?.id;
          } else if (insertError) {
            throw new Error(`Could not create durable generation job: ${insertError.message}`);
          } else {
            jobId = inserted?.id;
          }
        }
        if (!jobId) throw new Error("Could not register or observe the durable generation job.");

        send("status", { message: "Connected to saved generation progress.", step: "reconnect", job_id: jobId, is_reconnect: true });
        const startedAt = Date.now();
        while (!closed && !request.signal.aborted && Date.now() - startedAt < OBSERVER_WINDOW_MS) {
          const { data: current, error } = await supabase
            .from("acquisition_jobs")
            .select("status, error, result_data")
            .eq("id", jobId)
            .single();

          if (error || !current) {
            // A temporary status read failure is not a failed generation.
            send("status", { message: "Generation is saved; checking its latest status…", step: "status_unavailable", job_id: jobId });
          } else if (current.status === "completed") {
            send("complete", { curriculum_id: id, phase: "background" });
            close();
            return;
          } else if (current.status === "failed") {
            send("error", { message: current.error || "Generation failed." });
            close();
            return;
          } else {
            const resultData = current.result_data as {
              checkpoint?: { completedTopicIds?: unknown[] };
              batchCheckpoint?: { completedTopicIds?: unknown[] };
            } | null;
            const topicCount = resultData?.checkpoint?.completedTopicIds?.length ?? 0;
            const batchCount = resultData?.batchCheckpoint?.completedTopicIds?.length ?? 0;
            const pending = current.status === "pending";
            send("status", {
              message: pending
                ? "Generation is queued and will resume from its saved checkpoints."
                : `Generation is running. ${topicCount} topic(s) and ${batchCount} understanding batch(es) are checkpointed.`,
              step: pending ? "pending" : "running",
              current: topicCount + batchCount,
              total: -1,
              job_id: jobId,
            });
          }

          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              cancelPoll = null;
              resolve();
            }, OBSERVER_POLL_MS);
            cancelPoll = () => {
              clearTimeout(timer);
              cancelPoll = null;
              resolve();
            };
          });
        }

        if (!closed && !request.signal.aborted) {
          send("continue", { job_id: jobId });
          close();
        }
      } catch (error) {
        console.error("[stream] Durable job observation failed:", error);
        send("error", { message: "Could not read the saved generation status. Please reconnect." });
        close();
      }
    },
    cancel() {
      // Closing the browser stream stops observation only; it never fails the job.
      closed = true;
      cancelPoll?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// Kept for focused regression coverage of the previous inline generation
// implementation while the durable worker owns production requests.
export async function legacyGenerationGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const streamId = crypto.randomUUID();
  console.info(`[stream] Request opened: stream_id=${streamId}, curriculum_id=${id}`);

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
      let jobRecord: {
        mode: "owner";
        id: string;
        claim_token: string;
        claim_version: number;
      } | {
        mode: "observer";
        jobId: string;
        curriculumStatus: "draft" | "published";
        checkpoints: {
          completedTopicIds: string[];
          batchCompletedTopicIds: string[];
        };
      } | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      let ownershipLost = false;

      const clearHeartbeat = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
      };

      try {
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

        jobRecord = await claimOrRegisterJob(id, {
          topic: curriculum.title,
          grade_level: notes.grade_level ?? "high school",
          difficulty: notes.difficulty ?? "standard",
          existing_knowledge: notes.existing_knowledge ?? "",
          learning_goal: notes.learning_goal ?? "understand the subject",
          time_available: notes.time_available ?? "no time pressure",
          added_context: notes.added_context ?? "",
        });

        if (!jobRecord) {
          send(controller, "error", {
            message: "Could not obtain generation job. Please try again.",
          });
          controller.close();
          return;
        }
        console.info(`[stream] Job attached: stream_id=${streamId}, mode=${jobRecord.mode}, job_id=${jobRecord.mode === "owner" ? jobRecord.id : jobRecord.jobId}`);

        // Handle observer mode - attach to existing running job
        if (jobRecord.mode === "observer") {
          console.log(`[stream] Observer mode: attached to job ${jobRecord.jobId}`);

          send(controller, "status", {
            message: "Reconnected to existing generation…",
            step: "reconnect",
            job_id: jobRecord.jobId,
            is_reconnect: true,
          });

          // Send skeleton event if we have topic checkpoints (means skeleton was already generated)
          if (jobRecord.checkpoints.completedTopicIds.length > 0) {
            // We can't know the exact title, but we can report progress
            send(controller, "status", {
              message: `Resuming… ${jobRecord.checkpoints.completedTopicIds.length} topic(s) already processed`,
              step: "resume",
              current: jobRecord.checkpoints.completedTopicIds.length,
              total: -1, // Unknown total until skeleton is parsed by owner
            });
          }

          // In observer mode, we just wait and periodically report status
          // The owner stream will do the actual work and send events
          // We close after sending initial status - the client will reconnect
          // and eventually the owner will complete and send 'complete' event
          send(controller, "status", {
            message: "Waiting for generation to complete…",
            step: "waiting",
            job_id: jobRecord.jobId,
          });

          // Close the stream - the client will reconnect via EventSource
          // and eventually receive events from the owner stream
          controller.close();
          return;
        }

        // Owner mode - normal generation flow
        // TypeScript narrowing: observer mode returns early above
        const ownerJobRecord = jobRecord as { mode: "owner"; id: string; claim_token: string; claim_version: number };
        let lastProgressTime = Date.now();
        // Start lease renewal heartbeat
        heartbeatInterval = setInterval(() => {
          void renewLease(ownerJobRecord.id, ownerJobRecord.claim_token).then((ok) => {
            if (!ok) {
              console.error(
                `[stream] Lease renewal failed: job_id=${ownerJobRecord.id}, reason=not_found_or_expired`
              );
              ownershipLost = true;
              clearHeartbeat();
            } else {
              console.debug(`[stream] Lease renewed: job_id=${ownerJobRecord.id}`);
            }
          });
        }, 60_000);

        send(controller, "status", {
          message: "Generation job active.",
          step: "init",
          job_id: ownerJobRecord.id,
        });

        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost before skeleton generation — failing job ${ownerJobRecord.id}`
          );
          clearHeartbeat();
          void failJob(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            "Ownership lost before skeleton generation"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        // Step 1: Load the persisted skeleton or generate it once.
        let skeletonParsed: Skeleton | null = null;
        let updatedCurriculumTitle = curriculum.title;
        const nodeIds: Array<{ nodeId: string; node: SkeletonNode }> = [];
        const { data: existingNodes } = await supabase
          .from("nodes")
          .select("id, title, order_index")
          .eq("curriculum_id", id)
          .order("order_index", { ascending: true });

        const resumingSkeleton = Boolean(existingNodes && existingNodes.length > 0);
        send(controller, "status", {
          message: resumingSkeleton ? "Loading the saved curriculum structure…" : "Finding the best curriculum structure…",
          step: "skeleton",
        });

        if (existingNodes && existingNodes.length > 0) {
          const existingNodeIds = existingNodes.map((node: { id: string }) => node.id);
          const { data: existingMus } = await supabase
            .from("major_understandings")
            .select("id, node_id, code, description, order_index")
            .in("node_id", existingNodeIds);

          const persistedNodes: SkeletonNode[] = existingNodes.map((node: { id: string; title: string; order_index: number }) => ({
            title: node.title,
            order_index: node.order_index,
            major_understandings: (existingMus ?? [])
              .filter((mu: { node_id: string }) => mu.node_id === node.id)
              .sort((a: { order_index: number }, b: { order_index: number }) => a.order_index - b.order_index)
              .map((mu: { code: string | null; description: string }) => ({
                code: mu.code,
                description: mu.description,
              })),
          }));
          skeletonParsed = {
            title: curriculum.title,
            source_type: curriculum.source_type === "adapted" ? "adapted" : "ai_organized",
            source_attribution: curriculum.source_attribution ?? null,
            source_url: curriculum.source_url ?? null,
            nodes: persistedNodes,
          };
          existingNodes.forEach((node: { id: string }, index: number) => {
            nodeIds.push({ nodeId: node.id, node: persistedNodes[index] });
          });
          console.info(`[stream] Resuming persisted skeleton: stream_id=${streamId}, job_id=${ownerJobRecord.id}, topic_count=${nodeIds.length}, operation=skeleton_resume`);
        } else {
          const skeletonPrompt = buildSkeletonPrompt(
            curriculum.title,
            notes.grade_level ?? "high school",
            notes.difficulty ?? "standard",
            notes.existing_knowledge ?? "",
            notes.learning_goal ?? "understand the subject",
            notes.time_available ?? "no time pressure",
            notes.added_context ?? ""
          );

          // Reserve AI call for skeleton generation
          const skeletonReservation = await reserveAICall(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            DEFAULT_BUDGET_LIMITS.max_ai_calls,
            crypto.randomUUID()
          );
          if (!skeletonReservation.reserved) {
            console.error(
              `[stream] AI budget exhausted for skeleton: ${skeletonReservation.reason}`
            );
            clearHeartbeat();
            await failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              `AI budget exhausted: ${skeletonReservation.reason}`
            );
            send(controller, "error", {
              message: "AI generation budget exhausted. Please try again later.",
            });
            controller.close();
            return;
          }

          try {
          // Use structured output for guaranteed valid JSON (Priority 1 fix)
          console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=skeleton_ai`);
          skeletonParsed = await callAIStructured(skeletonPrompt, SkeletonSchema, true, "skeleton_ai");
          console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=skeleton_ai, topic_count=${skeletonParsed.nodes.length}`);
        } catch (err) {
          if (err instanceof AITimeoutError) throw err;
          // If structured output fails, fall back to text completion with robust extraction
          // This handles providers that don't support structured output well (e.g., Anthropic)
          console.warn(
            `[stream] Structured output failed, falling back to text extraction: ${err instanceof Error ? err.message : String(err)}`
          );

          const fallbackPrompt = `${skeletonPrompt}\n\nFallback instructions: Create an original, logically ordered curriculum skeleton from the student's request alone. Do not claim it is adapted from a source. Set source_type to "ai_organized", source_attribution to null, and source_url to null. Do not invent citations, URLs, or claims of verification. Return only the JSON object matching the schema above.`;
          const skeletonText = await callAI(fallbackPrompt, false, "skeleton_fallback");

          // Check ownership after AI call — if lost, fail the job
          if (ownershipLost) {
            console.log(
              `[stream] Ownership lost during skeleton generation (fallback) — aborting`
            );
            clearHeartbeat();
            void failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              "Ownership lost during skeleton generation"
            );
            send(controller, "error", {
              message:
                "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
            });
            controller.close();
            return;
          }

          // Parse with existing robust extraction
          const skeletonParseStartTime = Date.now();
          const parsed = extractSkeletonJson(skeletonText);
          let parseDurationMs = Date.now() - skeletonParseStartTime;
          skeletonParsed = parsed;

          // If initial parse failed, attempt one bounded corrective retry
          if (!parsed) {
            console.error(
              `[stream] Skeleton parse failed: job_id=${ownerJobRecord.id}, category=NO_JSON_FOUND_OR_SCHEMA_MISMATCH, response_chars=${skeletonText.length}, response_preview=${skeletonText.slice(0, 200)}, parse_duration_ms=${parseDurationMs}`
            );

            // Check budget and ownership before retry
            if (ownershipLost) {
              console.log(
                `[stream] Ownership lost before skeleton retry — aborting`
              );
              clearHeartbeat();
              void failJob(
                ownerJobRecord.id,
                ownerJobRecord.claim_token,
                ownerJobRecord.claim_version,
                "Ownership lost before skeleton retry"
              );
              send(controller, "error", {
                message:
                  "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
              });
              controller.close();
              return;
            }

            // Check AI budget for retry
            const retryReservation = await reserveAICall(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              DEFAULT_BUDGET_LIMITS.max_ai_calls,
              crypto.randomUUID()
            );
            if (!retryReservation.reserved) {
              console.error(
                `[stream] AI budget exhausted for skeleton retry: ${retryReservation.reason}`
              );
            clearHeartbeat();
            await failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              `AI budget exhausted: ${retryReservation.reason}`
            );
            send(controller, "error", {
              message: "AI generation budget exhausted. Please try again later.",
            });
            controller.close();
            return;
          }

          // Retry with explicit instruction to return valid JSON only
          const retryPrompt = `${fallbackPrompt}\n\nYour previous fallback response was invalid or did not match the schema. Correct it and return ONLY the required JSON structure. Do not include markdown, explanation, citations, URLs, or any text outside the JSON object. Ensure every required field and nested field matches the schema exactly.`;
          const skeletonRetry = await callAI(retryPrompt, false, "skeleton_retry");

          // Check ownership after retry AI call
          if (ownershipLost) {
            console.log(
              `[stream] Ownership lost during skeleton retry — aborting`
            );
            clearHeartbeat();
            void failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              "Ownership lost during skeleton retry"
            );
            send(controller, "error", {
              message:
                "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
            });
            controller.close();
            return;
          }

          // Try parsing retry response
          const retryParseStartTime = Date.now();
          skeletonParsed = extractSkeletonJson(skeletonRetry);
          const retryParseDurationMs = Date.now() - retryParseStartTime;
          if (!skeletonParsed) {
            console.error(
              `[stream] Skeleton retry parse failed: job_id=${ownerJobRecord.id}, category=RETRY_PARSE_FAILED, response_chars=${skeletonRetry.length}, response_preview=${skeletonRetry.slice(0, 200)}, parse_duration_ms=${retryParseDurationMs}`
            );
            send(controller, "error", {
              message: "Failed to generate curriculum structure",
            });
            controller.close();

            clearHeartbeat();
            if (ownerJobRecord) {
              void failJob(
                ownerJobRecord.id,
                ownerJobRecord.claim_token,
                ownerJobRecord.claim_version,
                "Failed to parse skeleton JSON after retry"
              );
            }
            return;
          }
          parseDurationMs = Date.now() - skeletonParseStartTime;
        } else {
          parseDurationMs = Date.now() - skeletonParseStartTime;
        }
          }

        // Update curriculum with real title and attribution
        if (!skeletonParsed) {
          // This should not happen as we would have returned earlier
          send(controller, "error", { message: "Failed to parse skeleton JSON after retry" });
          controller.close();
          return;
        }
        if (!existingNodes || existingNodes.length === 0) {
          console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=curriculum_skeleton_update`);
          await supabase
            .from("curricula")
            .update({
              title: skeletonParsed.title,
              source_type: skeletonParsed.source_type,
              source_attribution: skeletonParsed.source_attribution,
              source_url: skeletonParsed.source_url,
            })
            .eq("id", id);
          console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=curriculum_skeleton_update`);
        }

        updatedCurriculumTitle = skeletonParsed.title;

        send(controller, "skeleton", {
          title: skeletonParsed.title,
          topic_count: skeletonParsed.nodes.length,
          resumed: resumingSkeleton,
        });

        // Check ownership before node insertion (no AI calls here, but safe to check)
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost after skeleton — failing job ${ownerJobRecord.id}`
          );
          clearHeartbeat();
          void failJob(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            "Ownership lost after skeleton generation"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        // Step 2: Insert nodes and major understandings only for a fresh skeleton.
        // Existing nodes are the persisted source of truth on a resumed job.
        if (!existingNodes || existingNodes.length === 0) for (const node of skeletonParsed.nodes) {
          const topicExternalKey = `topic-${node.order_index}`;
          console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=node_upsert, external_key=${topicExternalKey}`);
          const { data: nodeRow } = await supabase
            .from("nodes")
            .upsert({
              curriculum_id: id,
              title: node.title,
              order_index: node.order_index,
              external_key: topicExternalKey,
            }, { onConflict: "curriculum_id,external_key" })
            .select("id")
            .single();

          console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=node_upsert, persisted=${Boolean(nodeRow)}`);
          if (!nodeRow) continue;

          const mus = node.major_understandings.map((mu, i) => ({
            node_id: nodeRow.id,
            external_key: mu.code ?? `${node.order_index}.${i + 1}`,
            code: mu.code,
            description: mu.description,
            order_index: i,
          }));

          console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=understanding_upsert, topic_id=${nodeRow.id}`);
          await supabase
            .from("major_understandings")
            .upsert(mus, { onConflict: "node_id,external_key" });
          console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=understanding_upsert, topic_id=${nodeRow.id}, count=${mus.length}`);
          nodeIds.push({ nodeId: nodeRow.id, node });
        }
        console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=skeleton_persist, topic_count=${nodeIds.length}`);
        }

        // Step 3: Discover best sources for this subject/difficulty
        type DiscoveredSource = {
          domain: string;
          name: string;
          why: string;
          best_for: string;
        };

        const { getJobById } = await import("@/lib/acquisition/jobService");
        const resumeJobData = await getJobById(ownerJobRecord.id);
        const rawPersistedSources = (resumeJobData?.result_data as { discoveredSources?: unknown })?.discoveredSources;
        const hasPersistedSources = Array.isArray(rawPersistedSources);
        let discoveredSources: DiscoveredSource[] = Array.isArray(rawPersistedSources)
          ? rawPersistedSources.filter(
              (source): source is DiscoveredSource =>
                typeof source === "object" && source !== null && typeof (source as DiscoveredSource).domain === "string"
            )
          : [];

        if (!hasPersistedSources) {
          send(controller, "status", {
            message: "Finding the best sources for this subject…",
            step: "sources",
          });
        }

        // Check ownership before source discovery (AI call)
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost before source discovery — failing job ${ownerJobRecord.id}`
          );
          clearHeartbeat();
          void failJob(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            "Ownership lost before source discovery"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        if (hasPersistedSources) {
          console.info(`[stream] Reusing persisted sources: stream_id=${streamId}, job_id=${ownerJobRecord.id}, source_count=${discoveredSources.length}, operation=source_resume`);
        } else try {
          const sourcesPrompt = buildSourceDiscoveryPrompt(
            updatedCurriculumTitle,
            notes.difficulty ?? "standard",
            notes.learning_goal ?? "understand the subject"
          );

          // Reserve AI call for source discovery
          const sourcesReservation = await reserveAICall(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            DEFAULT_BUDGET_LIMITS.max_ai_calls,
            crypto.randomUUID()
          );
          if (!sourcesReservation.reserved) {
            console.error(
              `[stream] AI budget exhausted for sources: ${sourcesReservation.reason}`
            );
            clearHeartbeat();
            await failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              `AI budget exhausted: ${sourcesReservation.reason}`
            );
            send(controller, "error", {
              message: "AI generation budget exhausted. Please try again later.",
            });
            controller.close();
            return;
          }

          // No web search needed — use structured output for guaranteed valid JSON
          console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=source_discovery_ai`);
          const sources = await callAIStructured(sourcesPrompt, SourcesArraySchema, false, "source_discovery_ai");
          console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=source_discovery_ai, source_count=${sources.length}`);

          // Check ownership after AI call
          if (ownershipLost) {
            console.log(
              `[stream] Ownership lost during source discovery — aborting`
            );
            clearHeartbeat();
            void failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              "Ownership lost during source discovery"
            );
            send(controller, "error", {
              message:
                "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
            });
            controller.close();
            return;
          } else {
            discoveredSources = sources;
            console.log(
              `Discovered ${discoveredSources.length} sources:`,
              discoveredSources.map((s) => s.domain).join(", ")
            );
          }
        } catch (err) {
          if (err instanceof AITimeoutError) throw err;
          console.log("Source discovery failed, continuing without prioritized sources:", err);
        }

        // Persist discovered sources so a resumed SSE invocation can skip the source-discovery AI call
        try {
          const { saveJobSources } = await import("@/lib/acquisition/jobService");
          await saveJobSources(ownerJobRecord.id, ownerJobRecord.claim_token, ownerJobRecord.claim_version, discoveredSources);
        } catch (err) {
          console.log("Failed to persist sources:", err);
        }

        // Step 4: Discover topic-level resources during generation.
        //
        // Phase 12: candidates are routed through the Learning Engine
        // (acquire → evidence → verify → persist) via discoverVerifiedResource(),
        // not inserted directly. This writes every resource as status='draft'
        // (pending admin approval) with content_type_verified derived from the
        // deterministic verification gate — never hardcoded.
        //
        // A scoped cache spans the topic loop AND the later background batch.
        // URL/content deduplication is scoped to each topic because the same
        // educational page may legitimately need a separate persisted link
        // for multiple topics.
        const cache = createCache({ enabled: true, maxEntries: 200 });
        const acquisitionJobId = ownerJobRecord.id;

        // Resume detection: read checkpoint to skip already-completed topics.
        // This allows the SSE route to yield and resume like the durable worker.
        const jobData = resumeJobData ?? await getJobById(ownerJobRecord.id);
        const rawCompletedTopics =
          (jobData?.result_data as { checkpoint?: { completedTopicIds: unknown } })?.checkpoint
            ?.completedTopicIds;
        const completedTopics = new Set(
          Array.isArray(rawCompletedTopics)
            ? rawCompletedTopics.filter((id): id is string => typeof id === "string")
            : []
        );

        let topicsProcessedThisInvocation = 0;

        for (let i = 0; i < nodeIds.length; i++) {
          if (ownershipLost) {
            console.log(
              "[stream] Ownership lost — aborting topic-level discovery"
            );
            clearHeartbeat();
            void failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              "Ownership lost during topic-level discovery"
            );
            send(controller, "error", {
              message:
                "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
            });
            controller.close();
            return;
          }
          const { nodeId, node } = nodeIds[i];
          console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=topic_discovery, topic_id=${nodeId}`);

          // Skip already-completed topics (resume from checkpoint)
          if (completedTopics.has(nodeId)) {
            console.log(`[stream] Skipping topic ${nodeId} - already completed (checkpoint)`);
            continue;
          }

          // Bounded work: yield when quota exhausted.
          // releaseJobClaim sets status='pending' without consuming a retry,
          // so the next SSE reconnect (or cron worker) can claim and resume.
          if (topicsProcessedThisInvocation >= MAX_TOPICS_PER_SSE_INVOCATION) {
            console.log(
              `[stream] Topic quota (${MAX_TOPICS_PER_SSE_INVOCATION}) reached, releasing claim for next invocation`
            );
            const released = await releaseJobClaim(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version
            );
            if (!released) {
              console.log(
                `[stream] release_job_claim returned false — ownership lost or yield refused; stopping`
              );
              // Re-read job state to determine why release failed
              const jobState = await getJobById(ownerJobRecord.id);
              if (!jobState || jobState.status !== 'pending') {
                // Ownership lost to another worker or job terminal — do not yield
                console.error(
                  `[stream] Job ${ownerJobRecord.id} is no longer in pending state (status: ${jobState?.status}), not sending yielded`
                );
                return;
              }
              // If still pending but release failed (yield cap), we can try again on reconnect
            }
            clearHeartbeat();
            // Send yielded event so client knows to reconnect
            send(controller, "yielded", {
              message: "Processing quota reached. Resuming…",
              topicsCompleted: topicsProcessedThisInvocation,
              totalTopics: nodeIds.length,
            });
            controller.close();
            return;
          }
          topicsProcessedThisInvocation++;

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
              updatedCurriculumTitle,
              discoveredSources.map((s) => s.domain)
            );

            const topicOutcome = await runBoundedCoverageAttempts({
              maxAttempts: MAX_COVERAGE_ATTEMPTS,
              threshold: 3,
              attempt: async () => {
                const reservation = await reserveAICall(
                  ownerJobRecord.id, ownerJobRecord.claim_token, ownerJobRecord.claim_version,
                  DEFAULT_BUDGET_LIMITS.max_ai_calls, crypto.randomUUID()
                );
                if (!reservation.reserved) {
                  return reservation.reason === "budget_exhausted" ? "budget_exhausted" : "ownership_lost";
                }
                const dedupTracker = new AcquisitionDedupTracker();
                let candidates: z.infer<typeof CandidateArraySchema>;
                try {
                  candidates = await callAIStructured(topicPrompt, CandidateArraySchema, true, "topic_discovery_ai", {
                    curriculumId: id, jobId: ownerJobRecord.id, streamId, topicId: nodeId,
                  });
                } catch (discoveryError) {
                  if (discoveryError instanceof AITimeoutError) throw discoveryError;
                  console.warn(`[stream] Discovery attempt returned no usable result for ${node.title}`, discoveryError);
                  return "attempted";
                }
                if (ownershipLost) return "ownership_lost";
                console.info(`[stream] Operation completed: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=topic_discovery_ai, topic_id=${nodeId}, candidate_count=${candidates.length}`);
                for (const candidate of (Array.isArray(candidates) ? candidates : []).filter((item) => item.url && item.title)) {
                  try {
                    await discoverVerifiedResource(toLearnParams(
                      candidate as Record<string, unknown>, { nodeId }, acquisitionJobId, candidate.ai_note ?? null
                    ), { cache, dedupTracker, jobId: ownerJobRecord.id, claimToken: ownerJobRecord.claim_token });
                  } catch (candidateError) {
                    if (candidateError instanceof PersistenceError) throw candidateError;
                    console.warn(`[stream] Candidate acquisition failed for ${candidate.url}`, candidateError);
                  }
                }
                return "attempted";
              },
              measureEligibleResources: async () => {
                const { data, error } = await supabase.from("resources").select("id")
                  .eq("node_id", nodeId).eq("status", "approved").eq("content_type_verified", true);
                if (error) throw new Error(`Topic coverage query failed: ${error.message}`);
                return data?.length ?? 0;
              },
              record: async ({ resourcesFound, sufficient, budgetExhausted, attemptId }) => recordResourceCoverageAttempt({
                jobId: ownerJobRecord.id, claimToken: ownerJobRecord.claim_token,
                claimVersion: ownerJobRecord.claim_version, phase: "topic", targetId: nodeId, attemptId,
                resourcesFound, sufficient, maxAttempts: MAX_COVERAGE_ATTEMPTS, budgetExhausted,
              }),
            });
            if (topicOutcome === "ownership_lost") {
              clearHeartbeat();
              send(controller, "error", { message: "Generation was interrupted because the job lease could not be confirmed." });
              controller.close();
              return;
            }
            if (topicOutcome === "insufficient") {
              console.warn(`[stream] Topic ${nodeId} has insufficient coverage after ${MAX_COVERAGE_ATTEMPTS} attempts`);
            }
            lastProgressTime = Date.now();
          } catch (err) {
            if (err instanceof PersistenceError) {
              clearHeartbeat();
              await failJob(
                ownerJobRecord.id, ownerJobRecord.claim_token, ownerJobRecord.claim_version,
                `Resource persistence failed: ${err.message}`
              );
              send(controller, "error", { message: "A resource could not be saved. Generation stopped without recording it as a coverage shortfall." });
              controller.close();
              return;
            }
            if (err instanceof AITimeoutError) throw err;
            const errorCode = err && typeof err === "object" && "code" in err
              ? String((err as { code: unknown }).code)
              : undefined;
            const errorProvider = err && typeof err === "object" && "provider" in err
              ? String((err as { provider: unknown }).provider)
              : "unknown";
            const errorCategory = errorCode === "MODEL_ERROR"
              ? (err instanceof Error && err.message.includes("without source citations") ? "missing_citations" : "model_error")
              : errorCode === "INVALID_REQUEST"
                ? "invalid_structured_output"
                : errorCode?.toLowerCase() ?? "unexpected_error";
            console.error("[stream] Topic discovery failed", {
              provider: errorProvider,
              curriculum_id: id,
              job_id: ownerJobRecord.id,
              stream_id: streamId,
              operation: "topic_discovery_ai",
              topic_id: nodeId,
              error_category: errorCategory,
              retryable: true,
            });
            // A failed discovery is not a successful empty result. Keep this
            // topic uncheckpointed and release the claim so a later invocation
            // retries from the persisted skeleton and prior topic checkpoints.
            clearHeartbeat();
            const released = await releaseJobClaim(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version
            );
            if (!released) {
              console.error(`[stream] Could not release job after topic discovery failure: job_id=${ownerJobRecord.id}`);
              send(controller, "error", {
                message: "Resource discovery failed, and the job could not be safely paused. Return to the curriculum and check its status before retrying.",
              });
            } else {
              const citationFailure = err instanceof Error &&
                err.message.includes("Azure web search completed without source citations");
              send(controller, "paused", {
                message: citationFailure
                  ? `Source citations were unavailable for ${node.title}. Progress is saved and this topic can be retried.`
                  : `Resource discovery could not be completed for ${node.title}. Progress is saved and this topic can be retried.`,
              });
            }
            controller.close();
            return;
          }

          // Stall detection: check if we've made no progress for too long
          if (Date.now() - lastProgressTime > STALL_TIMEOUT_MS) {
            console.error(
              `[stream] STALL DETECTED: job=${ownerJobRecord.id}, no progress for ${STALL_TIMEOUT_MS / 1000}s, failing job`
            );
            clearHeartbeat();
            await failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              `Stalled: no progress for ${STALL_TIMEOUT_MS / 1000}s`
            );
            send(controller, "error", {
              message: "Generation stalled — no progress for an extended period. Please refresh to retry.",
            });
            controller.close();
            return;
          }

          if (i < nodeIds.length - 1) {
            await new Promise((r) => setTimeout(r, 15000));
          }
        }

        // If ownership was lost during topic-level discovery, fail the job
        // rather than publishing a partially-complete curriculum under a
        // stale claim token. The cron worker (or a retried SSE stream) can
        // reclaim and resume via recover_stale_jobs -> claim_next_job.
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost before publication — failing job ${ownerJobRecord.id}`
          );
          clearHeartbeat();
          void failJob(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            "Ownership lost during topic-level discovery"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        // Topic-level work is complete; the per-understanding batch continues below.
        send(controller, "complete", { curriculum_id: id, phase: "topics" });

        // Background per-understanding discovery — one batch call per topic.
        // Runs after topic-level resources are done. We keep the stream open
        // so the student receives the final `complete` event with phase="background".
        let backgroundYielded = false;
        async function runBackgroundBatch() {
          const { data: curriculumRow } = await supabase
            .from("curricula")
            .select("title")
            .eq("id", id)
            .single();

          const bgCurriculumTitle = curriculumRow?.title ?? updatedCurriculumTitle;

          // Resume detection: read batch checkpoint to skip already-completed topics.
          const batchJobData = await getJobById(ownerJobRecord.id);
          const rawCompletedBatchTopics =
            (batchJobData?.result_data as { batchCheckpoint?: { completedTopicIds: unknown } })
              ?.batchCheckpoint?.completedTopicIds;
          const completedBatchTopics = new Set(
            Array.isArray(rawCompletedBatchTopics)
              ? rawCompletedBatchTopics.filter((id): id is string => typeof id === "string")
              : []
          );

          let batchTopicsProcessedThisInvocation = 0;

          for (let i = 0; i < nodeIds.length; i++) {
            if (ownershipLost) {
              console.error(
                "[stream] Ownership lost — aborting background batch"
              );
              return;
            }
            const { nodeId, node } = nodeIds[i];
            console.info(`[stream] Operation started: stream_id=${streamId}, job_id=${ownerJobRecord.id}, operation=batch_discovery, topic_id=${nodeId}`);

            // Skip topics whose batch discovery already completed (resume).
            if (completedBatchTopics.has(nodeId)) {
              console.log(`[stream] Skipping batch for topic ${nodeId} - already completed (batch checkpoint)`);
              continue;
            }

            const { data: muRows } = await supabase
              .from("major_understandings")
              .select("id, code, description, external_key")
              .eq("node_id", nodeId);

            if (!muRows || muRows.length === 0) continue;

            // Bounded work: release the claim and yield to the next invocation
            // once this invocation's batch quota is exhausted. releaseJobClaim sets
            // status='pending' without consuming a retry, so the next SSE reconnect
            // (or cron worker) can claim and resume.
            if (batchTopicsProcessedThisInvocation >= MAX_TOPICS_PER_SSE_INVOCATION) {
              console.log(
                `[stream] Batch quota (${MAX_TOPICS_PER_SSE_INVOCATION}) reached, releasing claim for next invocation`
              );
              const released = await releaseJobClaim(
                ownerJobRecord.id,
                ownerJobRecord.claim_token,
                ownerJobRecord.claim_version
              );
              if (!released) {
                console.log(
                  `[stream] release_job_claim returned false — ownership lost or yield refused; stopping background batch`
                );
                // Re-read job state to determine why release failed
                const jobState = await getJobById(ownerJobRecord.id);
                if (!jobState || jobState.status !== 'pending') {
                  // Ownership lost to another worker or job terminal — do not yield
                  console.error(
                    `[stream] Job ${ownerJobRecord.id} is no longer in pending state (status: ${jobState?.status}), not sending yielded`
                  );
                  return;
                }
                // If still pending but release failed (yield cap), we can try again on reconnect
              }
              clearHeartbeat();
              // Send yielded event so client knows to reconnect
              send(controller, "yielded", {
                message: "Background batch quota reached. Resuming…",
                topicsCompleted: batchTopicsProcessedThisInvocation,
                totalTopics: nodeIds.length,
              });
              backgroundYielded = true;
              controller.close();
              return;
            }
            batchTopicsProcessedThisInvocation++;

            const batchNode = {
              id: nodeId, curriculum_id: id, external_key: null, title: node.title,
              order_index: node.order_index, exam_weight_pct: null, claim_statement: null,
              major_understandings: muRows.map((m) => ({
                id: m.id, node_id: nodeId, external_key: m.external_key ?? m.code ?? null,
                code: m.code ?? null, description: m.description, order_index: 0,
              })),
            } as NodeWithChildren;
            const prompt = buildTopicBatchPrompt(batchNode, bgCurriculumTitle, discoveredSources.map((s) => s.domain));
            const muIds = muRows.map((mu) => mu.id);
            const batchOutcome = await runBoundedCoverageAttempts({
              maxAttempts: MAX_COVERAGE_ATTEMPTS,
              threshold: 2,
              attempt: async () => {
                const reservation = await reserveAICall(
                  ownerJobRecord.id, ownerJobRecord.claim_token, ownerJobRecord.claim_version,
                  DEFAULT_BUDGET_LIMITS.max_ai_calls, crypto.randomUUID()
                );
                if (!reservation.reserved) {
                  return reservation.reason === "budget_exhausted" ? "budget_exhausted" : "ownership_lost";
                }
                let batchResult: z.infer<typeof BatchResponseSchema>;
                try {
                  batchResult = await callAIStructured(prompt, BatchResponseSchema, true, "topic_batch_ai");
                } catch (discoveryError) {
                  if (discoveryError instanceof AITimeoutError) throw discoveryError;
                  console.warn(`[stream] Batch discovery attempt returned no usable result for ${node.title}`, discoveryError);
                  return "attempted";
                }
                if (ownershipLost) return "ownership_lost";
                for (const candidate of batchResult.topic_resources) {
                  const targetMuIds = mapUnderstandingCodesToIds(
                    candidate.understanding_codes,
                    muRows.map((mu) => ({ id: mu.id, code: mu.code ?? null, external_key: mu.external_key ?? null }))
                  );
                  if (!candidate.url || !candidate.title || targetMuIds.length === 0) continue;
                  for (const muId of targetMuIds) {
                    try {
                      await discoverVerifiedResource(toLearnParams(
                        candidate as Record<string, unknown>, { understandingId: muId },
                        acquisitionJobId, candidate.ai_note ?? null
                      ), { cache, jobId: ownerJobRecord.id, claimToken: ownerJobRecord.claim_token });
                    } catch (candidateError) {
                      if (candidateError instanceof PersistenceError) throw candidateError;
                      console.warn(`[stream] Batch candidate failed for ${candidate.url}`, candidateError);
                    }
                  }
                }
                return "attempted";
              },
              measureEligibleResources: async () => {
                const { data, error } = await supabase.from("resources").select("major_understanding_id")
                  .in("major_understanding_id", muIds).eq("status", "approved").eq("content_type_verified", true);
                if (error) throw new Error(`Understanding coverage query failed: ${error.message}`);
                const rows = data ?? [];
                return Math.min(...muIds.map((muId) => rows.filter((row) => row.major_understanding_id === muId).length));
              },
              record: async ({ resourcesFound, sufficient, budgetExhausted, attemptId }) => recordResourceCoverageAttempt({
                jobId: ownerJobRecord.id, claimToken: ownerJobRecord.claim_token,
                claimVersion: ownerJobRecord.claim_version, phase: "batch", targetId: nodeId, attemptId,
                resourcesFound, sufficient, maxAttempts: MAX_COVERAGE_ATTEMPTS, budgetExhausted,
              }),
            });
            if (batchOutcome === "ownership_lost") {
              ownershipLost = true;
              return;
            }
            if (batchOutcome === "insufficient") {
              console.warn(`[stream] Understanding coverage in topic ${nodeId} is insufficient after ${MAX_COVERAGE_ATTEMPTS} attempts`);
            }

            if (i < nodeIds.length - 1) {
              await new Promise((r) => setTimeout(r, 15000));
            }
          }
        }
        const backgroundBatch = runBackgroundBatch();
        backgroundBatch.catch((bgErr) => {
          console.error("[stream] Background batch error:", bgErr);
        });

        // --- Job Lifecycle: Finalize after background batch ---
        // Wait for background batch to complete, then emit final event and close stream.
        try {
          await backgroundBatch;
          if (backgroundYielded) return;
          if (ownershipLost) {
            console.error(
              `[stream] Ownership lost before job completion — failing job ${ownerJobRecord.id}`
            );
            await failJob(
              ownerJobRecord.id,
              ownerJobRecord.claim_token,
              ownerJobRecord.claim_version,
              "Ownership lost during background batch"
            );
            send(controller, "error", {
              message:
                "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
            });
            controller.close();
            return;
          }
          const ok = await completeJob(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            true
          );
          if (!ok) {
            console.error(
              `[stream] complete_job returned false — job ${ownerJobRecord.id} may have been reclaimed by cron worker during background batch`
            );
            // Do not send background complete event if job finalization failed
            send(controller, "error", {
              message:
                "Generation completed but job finalization failed. Please refresh to check status.",
            });
            controller.close();
            return;
          }
          // Job is terminally completed. Now publish the curriculum.
          await supabase
            .from("curricula")
            .update({ status: "published" })
            .eq("id", id);
          // Emit background_complete: all generation done AND job finalized
          send(controller, "complete", { curriculum_id: id, phase: "background" });
        } catch (bgErr) {
          console.error("[stream] Background batch failed:", bgErr);
          // If background fails, mark the job as failed so the cron worker
          // can retry the remaining MUs from checkpoint.
          const failed = await failJob(
            ownerJobRecord.id,
            ownerJobRecord.claim_token,
            ownerJobRecord.claim_version,
            `Background batch: ${bgErr instanceof Error ? bgErr.message : String(bgErr)}`
          );
          if (!failed) {
            console.error(
              `[stream] fail_job returned false — could not mark job ${ownerJobRecord.id} as failed`
            );
          }
          send(controller, "error", {
            message:
              "Generation was interrupted — an error occurred during background resource generation.",
          });
        } finally {
          controller.close();
        }
        // No outer catch needed - inner try/catch handles errors
    } catch (err) {
      // This catch is for the outer try block (line 492)
      // Should not be reached since inner try has its own catch/finally
      send(controller, "error", {
        message:
          err instanceof Error ? err.message : "Something went wrong",
      });
      controller.close();

      // Type guard: jobRecord could be owner or observer mode
      const isOwner = jobRecord && jobRecord.mode === "owner";
      if (isOwner) {
        const ownerRecord = jobRecord as { mode: "owner"; id: string; claim_token: string; claim_version: number };
        const failed = await failJob(
          ownerRecord.id,
          ownerRecord.claim_token,
          ownerRecord.claim_version,
          err instanceof Error ? err.message : "Unknown error"
        );
        if (!failed) {
          console.error(
            `[stream] fail_job returned false — could not mark job ${ownerRecord.id} as failed`
          );
        }
      }
      clearHeartbeat();
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
