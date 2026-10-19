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
import { reserveAICall } from "@/lib/acquisition/jobService";

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
 * Call AI provider for source discovery (no search, smaller max tokens).
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
export async function claimOrRegisterJob(
  curriculumId: string,
  inputData: Record<string, unknown>
): Promise<{
  id: string;
  claim_token: string;
  claim_version: number;
} | null> {
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
          id: retryClaimed.id,
          claim_token: retryClaimed.claim_token,
          claim_version: retryClaimed.claim_version,
        };
      }

      // Another SSE request owns a running job — we cannot proceed.
      console.log(
        `[stream] Another process owns the active job for curriculum ${curriculumId}`
      );
      return null;
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
    id: inserted.id,
    claim_token: inserted.claim_token,
    claim_version: inserted.claim_version,
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
    console.error("[stream] renew_lease RPC error:", error.message);
    return false;
  }

  return data === true;
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
      let jobRecord: {
        id: string;
        claim_token: string;
        claim_version: number;
      } | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      // Set to true when renewLease fails — the process must stop processing
      // immediately to prevent stale writes after ownership is lost.
      let ownershipLost = false;

      // Clear interval helper — safe to call multiple times.
      const clearHeartbeat = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
      };

      try {
        // --- Job Lifecycle: Claim ---
        // Atomically claim an existing pending job or register a new running job.
        // The cron worker's claim_next_job will skip this job (it only claims
        // 'pending' status), preventing double-processing.

        // Load the curriculum first to get notes for the job's input_data.
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
          // Another process owns the active job for this curriculum.
          send(controller, "status", {
            message:
              "Another generation is already in progress for this curriculum. Please wait or refresh to check progress.",
            step: "already_claimed",
            job_id: null,
          });
          controller.close();
          return;
        }

        // Start lease renewal heartbeat — keeps the job from being recovered
        // by the cron worker's recover_stale_jobs() while we're actively working.
        heartbeatInterval = setInterval(() => {
          void renewLease(jobRecord!.id, jobRecord!.claim_token).then((ok) => {
            if (!ok) {
              console.error(
                `[stream] Lease renewal failed — job ${jobRecord!.id} may have been reclaimed`
              );
              ownershipLost = true;
              clearHeartbeat();
            }
          });
        }, 60_000); // Every 60 seconds

        send(controller, "status", {
          message: "Generation job registered.",
          step: "init",
          job_id: jobRecord.id,
        });

        // Check ownership before starting any AI work
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost before skeleton generation — failing job ${jobRecord!.id}`
          );
          clearHeartbeat();
          void failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            "Ownership lost before skeleton generation"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

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

        // Reserve AI call for skeleton generation
        const skeletonReservation = await reserveAICall(
          jobRecord!.id,
          jobRecord!.claim_token,
          jobRecord!.claim_version,
          DEFAULT_BUDGET_LIMITS.max_ai_calls,
          crypto.randomUUID()
        );
        if (!skeletonReservation.reserved) {
          console.error(
            `[stream] AI budget exhausted for skeleton: ${skeletonReservation.reason}`
          );
          clearHeartbeat();
          await failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            `AI budget exhausted: ${skeletonReservation.reason}`
          );
          send(controller, "error", {
            message: "AI generation budget exhausted. Please try again later.",
          });
          controller.close();
          return;
        }

        const skeleton = await callAI(skeletonPrompt, true);

        // Check ownership after AI call — if lost, fail the job
        if (ownershipLost) {
          console.log(
            `[stream] Ownership lost during skeleton generation — aborting`
          );
          clearHeartbeat();
          void failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            "Ownership lost during skeleton generation"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

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

          // Mark the job as failed so the cron worker can retry later.
          clearHeartbeat();
          if (jobRecord) {
            void failJob(
              jobRecord.id,
              jobRecord.claim_token,
              jobRecord.claim_version,
              "Failed to parse skeleton JSON"
            );
          }
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

        const updatedCurriculumTitle = skeletonParsed.title;

        send(controller, "skeleton", {
          title: skeletonParsed.title,
          topic_count: skeletonParsed.nodes.length,
        });

        // Check ownership before node insertion (no AI calls here, but safe to check)
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost after skeleton — failing job ${jobRecord!.id}`
          );
          clearHeartbeat();
          void failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            "Ownership lost after skeleton generation"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        // Step 2: Insert nodes and major understandings
        // Use stable external_key for idempotent retries: "topic-N" from skeleton order_index
        const nodeIds: Array<{
          nodeId: string;
          node: SkeletonNode;
        }> = [];

        for (const node of skeletonParsed.nodes) {
          const topicExternalKey = `topic-${node.order_index}`;
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

          if (!nodeRow) continue;

          const mus = node.major_understandings.map((mu, i) => ({
            node_id: nodeRow.id,
            external_key: mu.code ?? `${node.order_index}.${i + 1}`,
            code: mu.code,
            description: mu.description,
            order_index: i,
          }));

          await supabase
            .from("major_understandings")
            .upsert(mus, { onConflict: "node_id,external_key" });
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

        // Check ownership before source discovery (AI call)
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost before source discovery — failing job ${jobRecord!.id}`
          );
          clearHeartbeat();
          void failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            "Ownership lost before source discovery"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        try {
          const sourcesPrompt = buildSourceDiscoveryPrompt(
            updatedCurriculumTitle,
            notes.difficulty ?? "standard",
            notes.learning_goal ?? "understand the subject"
          );

          // Reserve AI call for source discovery
          const sourcesReservation = await reserveAICall(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            DEFAULT_BUDGET_LIMITS.max_ai_calls,
            crypto.randomUUID()
          );
          if (!sourcesReservation.reserved) {
            console.error(
              `[stream] AI budget exhausted for sources: ${sourcesReservation.reason}`
            );
            clearHeartbeat();
            await failJob(
              jobRecord!.id,
              jobRecord!.claim_token,
              jobRecord!.claim_version,
              `AI budget exhausted: ${sourcesReservation.reason}`
            );
            send(controller, "error", {
              message: "AI generation budget exhausted. Please try again later.",
            });
            controller.close();
            return;
          }

          // No web search needed — Claude already knows which sites are good
          const sourcesText = await callAISources(sourcesPrompt);

          // Check ownership after AI call
          if (ownershipLost) {
            console.log(
              `[stream] Ownership lost during source discovery — aborting`
            );
            clearHeartbeat();
            void failJob(
              jobRecord!.id,
              jobRecord!.claim_token,
              jobRecord!.claim_version,
              "Ownership lost during source discovery"
            );
            send(controller, "error", {
              message:
                "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
            });
            controller.close();
            return;
          } else {
            const jsonMatch = sourcesText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              discoveredSources = JSON.parse(jsonMatch[0]) as DiscoveredSource[];
              console.log(
                `Discovered ${discoveredSources.length} sources:`,
                discoveredSources.map((s) => s.domain).join(", ")
              );
            }
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
        const acquisitionJobId = jobRecord.id;

        for (let i = 0; i < nodeIds.length; i++) {
          if (ownershipLost) {
            console.log(
              "[stream] Ownership lost — aborting topic-level discovery"
            );
            clearHeartbeat();
            void failJob(
              jobRecord!.id,
              jobRecord!.claim_token,
              jobRecord!.claim_version,
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

            // Reserve AI call for topic discovery
            const topicReservation = await reserveAICall(
              jobRecord!.id,
              jobRecord!.claim_token,
              jobRecord!.claim_version,
              DEFAULT_BUDGET_LIMITS.max_ai_calls,
              crypto.randomUUID()
            );
            if (!topicReservation.reserved) {
              console.error(
                `[stream] AI budget exhausted for topic ${node.title}: ${topicReservation.reason}`
              );
              clearHeartbeat();
              await failJob(
                jobRecord!.id,
                jobRecord!.claim_token,
                jobRecord!.claim_version,
                `AI budget exhausted: ${topicReservation.reason}`
              );
              send(controller, "error", {
                message: "AI generation budget exhausted. Please try again later.",
              });
              controller.close();
              return;
            }

            const topicText = await callAI(topicPrompt, true);

            // Check ownership after AI call — if lost mid-call, fail the job
            if (ownershipLost) {
              console.log(
                `[stream] Ownership lost during topic AI call — aborting topic ${node.title}`
              );
              clearHeartbeat();
              void failJob(
                jobRecord!.id,
                jobRecord!.claim_token,
                jobRecord!.claim_version,
                "Ownership lost during topic discovery"
              );
              send(controller, "error", {
                message:
                  "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
              });
              controller.close();
              return;
            }

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
                  jobId: jobRecord!.id,
                  claimToken: jobRecord!.claim_token,
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

        // If ownership was lost during topic-level discovery, fail the job
        // rather than publishing a partially-complete curriculum under a
        // stale claim token. The cron worker (or a retried SSE stream) can
        // reclaim and resume via recover_stale_jobs -> claim_next_job.
        if (ownershipLost) {
          console.error(
            `[stream] Ownership lost before publication — failing job ${jobRecord!.id}`
          );
          clearHeartbeat();
          void failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            "Ownership lost during topic-level discovery"
          );
          send(controller, "error", {
            message:
              "Generation was interrupted — ownership of the job was lost. Please refresh to check for updates.",
          });
          controller.close();
          return;
        }

        // Publish the curriculum
        await supabase
          .from("curricula")
          .update({ status: "published" })
          .eq("id", id);

        // Emit topics_complete: topic-level resources done, background batch starting
        send(controller, "complete", { curriculum_id: id, phase: "topics" });

        // Background per-understanding discovery — one batch call per topic.
        // Runs after topic-level resources are done. We keep the stream open
        // so the student receives the final `complete` event with phase="background".
        const backgroundBatch = (async () => {
          const { data: curriculumRow } = await supabase
            .from("curricula")
            .select("title")
            .eq("id", id)
            .single();

          const bgCurriculumTitle = curriculumRow?.title ?? updatedCurriculumTitle;

          for (let i = 0; i < nodeIds.length; i++) {
            if (ownershipLost) {
              console.error(
                "[stream] Ownership lost — aborting background batch"
              );
              return;
            }
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

              // Reserve AI call for background batch topic
              const batchReservation = await reserveAICall(
                jobRecord!.id,
                jobRecord!.claim_token,
                jobRecord!.claim_version,
                DEFAULT_BUDGET_LIMITS.max_ai_calls,
                crypto.randomUUID()
              );
              if (!batchReservation.reserved) {
                console.error(
                  `[stream] AI budget exhausted for background batch topic ${node.title}: ${batchReservation.reason}`
                );
                clearHeartbeat();
                await failJob(
                  jobRecord!.id,
                  jobRecord!.claim_token,
                  jobRecord!.claim_version,
                  `AI budget exhausted: ${batchReservation.reason}`
                );
                return;
              }

              const text = await callAI(prompt, true);

              // Check ownership after AI call — if lost mid-call, fail the job
              if (ownershipLost) {
                console.error(
                  `[stream] Ownership lost during background batch AI call — aborting`
                );
                clearHeartbeat();
                void failJob(
                  jobRecord!.id,
                  jobRecord!.claim_token,
                  jobRecord!.claim_version,
                  "Ownership lost during background batch"
                );
                return;
              }

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
                    const out = await discoverVerifiedResource(params, {
                      cache,
                      jobId: jobRecord!.id,
                      claimToken: jobRecord!.claim_token,
                    });
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

            // Checkpoint: track this topic's background MU completion for recovery.
            // Uses the real claim token — this call succeeds (not a no-op)
            // because the job was claimed/registered with a valid claim token
            // and status='running'. If the process dies after this checkpoint,
            // recover_stale_jobs will reclaim the job and a future claim_next_job
            // caller (cron worker or retried SSE) can resume from the checkpoint.
            try {
              const checkpointOk = await advanceCheckpoint(
                jobRecord!.id,
                jobRecord!.claim_token,
                jobRecord!.claim_version,
                nodeId,
                muRows ? muRows.length : 0
              );
              if (!checkpointOk) {
                console.error(
                  `[stream] advance_checkpoint returned false — ownership lost, stopping background batch`
                );
                return;
              }
            } catch (ckptErr) {
              console.error("[stream] advance_checkpoint threw:", ckptErr);
            }

            if (i < nodeIds.length - 1) {
              await new Promise((r) => setTimeout(r, 15000));
            }
          }
        })()
        .catch((bgErr) => {
          console.error("[stream] Background batch error:", bgErr);
        });

        // --- Job Lifecycle: Finalize after background batch ---
        // Wait for background batch to complete, then emit final event and close stream.
        try {
          await backgroundBatch;
          if (ownershipLost) {
            console.error(
              `[stream] Ownership lost before job completion — failing job ${jobRecord!.id}`
            );
            await failJob(
              jobRecord!.id,
              jobRecord!.claim_token,
              jobRecord!.claim_version,
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
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            true
          );
          if (!ok) {
            console.error(
              `[stream] complete_job returned false — job ${jobRecord!.id} may have been reclaimed by cron worker during background batch`
            );
            // Do not send background complete event if job finalization failed
            send(controller, "error", {
              message:
                "Generation completed but job finalization failed. Please refresh to check status.",
            });
            controller.close();
            return;
          }
          // Emit background_complete: all generation done AND job finalized
          send(controller, "complete", { curriculum_id: id, phase: "background" });
        } catch (bgErr) {
          console.error("[stream] Background batch failed:", bgErr);
          // If background fails, mark the job as failed so the cron worker
          // can retry the remaining MUs from checkpoint.
          const failed = await failJob(
            jobRecord!.id,
            jobRecord!.claim_token,
            jobRecord!.claim_version,
            `Background batch: ${bgErr instanceof Error ? bgErr.message : String(bgErr)}`
          );
          if (!failed) {
            console.error(
              `[stream] fail_job returned false — could not mark job ${jobRecord!.id} as failed`
            );
          }
          send(controller, "error", {
            message:
              "Generation was interrupted — an error occurred during background resource generation.",
          });
        } finally {
          controller.close();
        }
      } catch (err) {
        send(controller, "error", {
          message:
            err instanceof Error ? err.message : "Something went wrong",
        });
        controller.close();

        // --- Job Lifecycle: Fail ---
        // Mark the job as failed so the cron worker can retry it later
        // (recover_stale_jobs will return it to 'pending' if retries remain).
        if (jobRecord) {
          const failed = await failJob(
            jobRecord.id,
            jobRecord.claim_token,
            jobRecord.claim_version,
            err instanceof Error ? err.message : "Unknown error"
          );
          if (!failed) {
            console.error(
              `[stream] fail_job returned false — could not mark job ${jobRecord.id} as failed`
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
