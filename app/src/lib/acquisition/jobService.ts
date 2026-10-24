/**
 * Phase 9 Durable Job Service
 * TypeScript service layer for durable acquisition job processing.
 */

import { createClient as createServiceClient } from '@supabase/supabase-js';
import type {
  AcquisitionJob,
  JobInputData,
  JobBudgetLimits,
  CreateJobRequest,
  CreateJobResponse,
  JobClaimResult,
  AIReservation,
  ReserveAICallRequest,
  ReserveAICallResponse,
  PersistWithFenceRequest,
  PersistWithFenceResponse,
  AdvanceCheckpointRequest,
  AdvanceCheckpointResponse,
  ClaimNextJobRequest,
  RenewLeaseRequest,
  RenewLeaseResponse,
  CompleteJobRequest,
  FailJobRequest,
  RecoverStaleJobsResponse,
  CreateJobAndCurriculumRequest,
  CreateJobAndCurriculumResponse,
} from '@/lib/acquisition/jobTypes';

import {
  DEFAULT_BUDGET_LIMITS,
  LEASE_DURATION_MINUTES,
  LEASE_RENEWAL_INTERVAL_MS,
} from '@/lib/acquisition/jobTypes';

// Export as values (not just type) so other modules can import them
export { DEFAULT_BUDGET_LIMITS, LEASE_DURATION_MINUTES, LEASE_RENEWAL_INTERVAL_MS };

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function getServiceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

/**
 * Create a curriculum and acquisition job atomically.
 * Called from authenticated user session (POST /api/jobs/create).
 */
export async function createJobAndCurriculum(
  userId: string,
  request: CreateJobAndCurriculumRequest
): Promise<CreateJobAndCurriculumResponse> {
  const supabase = getServiceClient();

  const input: Record<string, unknown> = {
    grade_level: request.grade_level,
    difficulty: request.difficulty,
    existing_knowledge: request.existing_knowledge,
    learning_goal: request.learning_goal,
    time_available: request.time_available,
    added_context: request.added_context,
  };

  const budgets = {
    max_ai_calls: 32,
    max_total_candidates_per_job: 50,
    max_candidates_per_understanding: 5,
    max_fetch_attempts: 3,
    max_retries: 3,
  };

  const { data, error } = await getServiceClient().rpc('create_curriculum_and_job', {
    p_topic: request.topic,
    p_input: input,
    p_budgets: budgets,
    p_owner: userId,
  });

  if (error) {
    return { curriculum_id: '', job_id: '', error: error.message };
  }

  if (data?.error) {
    return { curriculum_id: '', job_id: '', error: data.error };
  }

  return {
    curriculum_id: data.curriculum_id,
    job_id: data.job_id,
  };
}

/**
 * Claim the next pending job for processing.
 * Called by the scheduled processor (POST /api/jobs/process).
 */
export async function claimNextJob(jobType: string = 'curriculum_generation', curriculumId?: string): Promise<JobClaimResult | null> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('claim_next_job', {
    p_job_type: jobType,
    p_curriculum_id: curriculumId ?? null,
  });

  if (error || !data) {
    return null;
  }

  return data as JobClaimResult;
}

/**
 * Renew the lease for a job (heartbeat).
 */
export async function renewLease(jobId: string, claimToken: string): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('renew_lease', {
    p_job_id: jobId,
    p_claim_token: claimToken,
  });

  if (error) {
    console.error('Renew lease error:', error);
    return false;
  }

  return data as boolean;
}

/**
 * Reserve an AI call slot with durable idempotency.
 */
export async function reserveAICall(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number,
  maxAiCalls: number,
  reservationId: string
): Promise<ReserveAICallResponse> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('reserve_ai_call', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
    p_max_ai_calls: maxAiCalls,
    p_reservation_id: reservationId,
  });

  if (error) {
    console.error('Reserve AI call error:', error);
    return { reserved: false, reason: 'rpc_error' };
  }

  return data as ReserveAICallResponse;
}

/**
 * Persist a verified resource with fencing and exact-retry idempotency.
 */
export async function persistWithFence(
  jobId: string,
  claimToken: string,
  input: PersistWithFenceRequest['input']
): Promise<PersistWithFenceResponse> {
  const supabase = getServiceClient();
  // Exact-retry detection is keyed by acquisition_job_id + content hash in
  // persist_with_fence. Scope that key to the association target so reusing
  // the same verified page for another topic/concept still writes its link.
  const targetScope = input.target.nodeId
    ? `node:${input.target.nodeId}`
    : input.target.understandingId
      ? `understanding:${input.target.understandingId}`
      : "unscoped";
  // Send only fields consumed by persist_with_fence. Runtime AcquisitionPage
  // and StructuredContent objects also carry raw page bodies and extracted
  // blocks/links; those are not needed by this RPC and may contain characters
  // PostgreSQL cannot represent in jsonb (for example U+0000).
  const rpcInput = {
    acquiredPage: {
      finalUrl: input.acquiredPage.finalUrl,
      canonicalUrl: { url: input.acquiredPage.canonicalUrl.url },
      contentHash: input.acquiredPage.contentHash,
      statusCode: input.acquiredPage.statusCode,
      acquiredAt: input.acquiredPage.acquiredAt,
    },
    structuredContent: {
      metadata: {
        title: input.structuredContent.metadata.title ?? null,
        description: input.structuredContent.metadata.description ?? null,
        author: input.structuredContent.metadata.author ?? null,
        datePublished: input.structuredContent.metadata.datePublished ?? null,
        language: input.structuredContent.metadata.language ?? null,
      },
    },
    educationalEvidence: { interpreted: input.educationalEvidence.interpreted },
    verificationResult: {
      status: input.verificationResult.status,
      deterministicChecks: {
        cleanedContentNonEmpty: input.verificationResult.deterministicChecks.cleanedContentNonEmpty,
      },
      advisorySignals: {
        titlePresent: input.verificationResult.advisorySignals.titlePresent,
        educationalEvidencePresent: input.verificationResult.advisorySignals.educationalEvidencePresent,
        wordCount: input.verificationResult.advisorySignals.wordCount,
        headingCount: input.verificationResult.advisorySignals.headingCount,
        paragraphCount: input.verificationResult.advisorySignals.paragraphCount,
      },
      verifiedAt: input.verificationResult.verifiedAt,
    },
    target: { ...input.target },
    acquisitionJobId: input.acquisitionJobId
      ? `${input.acquisitionJobId}:${targetScope}`
      : null,
    callerMetadata: {
      resourceType: input.callerMetadata?.resourceType ?? null,
      licenseStatus: input.callerMetadata?.licenseStatus ?? null,
      aiNote: input.callerMetadata?.aiNote ?? null,
    },
  };

  const { data, error } = await supabase.rpc('persist_with_fence', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_input: rpcInput,
  });

  if (error) {
    console.error('Persist with fence error:', error);
    if (/unicode|escape sequence/i.test(error.message)) {
      const fields = findUnsupportedJsonbUnicode(rpcInput);
      console.error('[persistence] JSONB Unicode input diagnostic:', {
        job_id: jobId,
        fields,
      });
    }
    return { resource_id: '', vr_id: '', mapping_id: null, is_exact_retry: false, error: error.message };
  }

  return data as PersistWithFenceResponse;
}

/** Report only paths and code-point counts; never include persisted text values. */
function findUnsupportedJsonbUnicode(value: unknown, path = 'p_input'): Array<{
  path: string;
  nul_count: number;
  unpaired_surrogate_count: number;
}> {
  const fields: Array<{ path: string; nul_count: number; unpaired_surrogate_count: number }> = [];
  const visit = (current: unknown, currentPath: string): void => {
    if (typeof current === 'string') {
      let nulCount = 0;
      let unpairedSurrogateCount = 0;
      for (let index = 0; index < current.length; index++) {
        const code = current.charCodeAt(index);
        if (code === 0) {
          nulCount++;
        } else if (code >= 0xd800 && code <= 0xdbff) {
          const next = current.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) index++;
          else unpairedSurrogateCount++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          unpairedSurrogateCount++;
        }
      }
      if (nulCount > 0 || unpairedSurrogateCount > 0) {
        fields.push({ path: currentPath, nul_count: nulCount, unpaired_surrogate_count: unpairedSurrogateCount });
      }
    } else if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
    } else if (current && typeof current === 'object') {
      Object.entries(current).forEach(([key, child]) => visit(child, `${currentPath}.${key}`));
    }
  };
  visit(value, path);
  return fields;
}

/**
 * Advance the checkpoint for a job (idempotent).
 */
export async function advanceCheckpoint(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number,
  completedTopicId: string,
  resourcesFound: number
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('advance_checkpoint', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
    p_completed_topic_id: completedTopicId,
    p_resources_found: resourcesFound,
  });

  if (error) {
    console.error('Advance checkpoint error:', error);
    return false;
  }

  return data as boolean;
}

/**
 * Complete a job (partial or full).
 */
export async function completeJob(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number,
  hasProgress: boolean
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('complete_job', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
    p_has_progress: hasProgress,
  });

  if (error) {
    console.error('Complete job error:', error);
    return false;
  }

  return data as boolean;
}

/**
 * Fail a job with an error.
 */
export async function failJob(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number,
  error: string
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error: rpcError } = await supabase.rpc('fail_job', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
    p_error: error,
  });

  if (rpcError) {
    console.error('Fail job error:', rpcError);
    return false;
  }

  return data as boolean;
}

/**
 * Release a job claim back to 'pending' without consuming a retry count.
 * The caller holds a valid claim_token and claim_version; the WHERE clause
 * guards against stale claims. After this call the job is in 'pending' state
 * and can be claimed again by the cron processor.
 */
export async function releaseJobClaim(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('release_job_claim', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
  });

  if (error) {
    console.error('Release job claim error:', error);
    return false;
  }

  return data as boolean;
}

/**
 * Persist discovered sources so a resumed invocation can skip the
 * source-discovery AI call.
 */
export async function saveJobSources(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number,
  sources: Array<{ domain: string; name: string; why: string; best_for: string }>
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('save_job_sources', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
    p_sources: sources,
  });

  if (error) {
    console.error('Save job sources error:', error);
    return false;
  }

  return data as boolean;
}

/**
 * Advance the batch-phase checkpoint for per-understanding discovery.
 * Uses a separate scope ('batchCheckpoint') from advance_checkpoint so that
 * topic-level and batch-phase progress are tracked independently and can resume
 * independently.
 */
export async function advanceBatchCheckpoint(
  jobId: string,
  claimToken: string,
  expectedClaimVersion: number,
  completedTopicId: string,
  resourcesFound: number
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('advance_batch_checkpoint', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_expected_claim_version: expectedClaimVersion,
    p_completed_topic_id: completedTopicId,
    p_resources_found: resourcesFound,
  });

  if (error) {
    console.error('Advance batch checkpoint error:', error);
    return false;
  }

  return data as boolean;
}

export class CoverageAttemptRpcError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoverageAttemptRpcError";
  }
}

export type RecordResourceCoverageAttemptResult =
  | { status: "retrying"; retry: true; attempts: number }
  | { status: "complete" | "insufficient"; retry: false; attempts: number }
  | { status: "ownership_lost"; retry: false };

/** Atomically records a target's bounded coverage attempt and final checkpoint. */
export async function recordResourceCoverageAttempt(input: {
  jobId: string;
  claimToken: string;
  claimVersion: number;
  phase: "topic" | "batch";
  targetId: string;
  attemptId: string;
  resourcesFound: number;
  sufficient: boolean;
  maxAttempts?: number;
  budgetExhausted?: boolean;
}): Promise<RecordResourceCoverageAttemptResult> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("record_resource_coverage_attempt", {
    p_job_id: input.jobId,
    p_claim_token: input.claimToken,
    p_expected_claim_version: input.claimVersion,
    p_phase: input.phase,
    p_target_id: input.targetId,
    p_attempt_id: input.attemptId,
    p_resources_found: input.resourcesFound,
    p_sufficient: input.sufficient,
    p_max_attempts: input.maxAttempts ?? 2,
    p_budget_exhausted: input.budgetExhausted ?? false,
  });
  if (error) {
    throw new CoverageAttemptRpcError(
      `Coverage attempt RPC failed: ${error.message ?? "database client error"}`,
      "DATABASE_ERROR",
      { cause: error }
    );
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new CoverageAttemptRpcError("Coverage attempt RPC returned an empty or malformed response", "INVALID_RESPONSE");
  }

  const response = data as Record<string, unknown>;
  if ("error" in response) {
    if (response.error === "ownership_lost_or_expired") {
      return { status: "ownership_lost", retry: false };
    }
    const code = typeof response.error === "string" ? response.error : "UNKNOWN_RPC_ERROR";
    throw new CoverageAttemptRpcError(`Coverage attempt RPC rejected the request: ${code}`, code);
  }

  const validStatuses = ["retrying", "complete", "insufficient"];
  const expectedRetry = response.status === "retrying";
  if (!validStatuses.includes(String(response.status)) ||
      typeof response.retry !== "boolean" || response.retry !== expectedRetry ||
      !Number.isSafeInteger(response.attempts) || (response.attempts as number) < 0) {
    throw new CoverageAttemptRpcError("Coverage attempt RPC returned an invalid response shape", "INVALID_RESPONSE");
  }
  return response as RecordResourceCoverageAttemptResult;
}

export async function recoverStaleJobs(): Promise<Array<{ id: string; status: string; retry_count: number }>> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc('recover_stale_jobs');

  if (error) {
    console.error('Recover stale jobs error:', error);
    return [];
  }

  return (data as Array<{ id: string; status: string; retry_count: number }>) || [];
}

/**
 * Get a job by ID (for status polling).
 */
export async function getJobById(jobId: string): Promise<AcquisitionJob | null> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('acquisition_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as AcquisitionJob;
}

/**
 * Get jobs by curriculum ID.
 */
export async function getJobsByCurriculum(curriculumId: string): Promise<AcquisitionJob[]> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('acquisition_jobs')
    .select('*')
    .eq('curriculum_id', curriculumId)
    .order('created_at', { ascending: false });

  if (error) {
    return [];
  }

  return (data as AcquisitionJob[]) || [];
}

