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

  const { data, error } = await supabase.rpc('persist_with_fence', {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_input: {
      acquiredPage: input.acquiredPage,
      structuredContent: input.structuredContent,
      educationalEvidence: input.educationalEvidence,
      verificationResult: input.verificationResult,
      target: input.target,
      acquisitionJobId: input.acquisitionJobId,
      callerMetadata: input.callerMetadata,
    },
  });

  if (error) {
    console.error('Persist with fence error:', error);
    return { resource_id: '', vr_id: '', mapping_id: null, is_exact_retry: false, error: error.message };
  }

  return data as PersistWithFenceResponse;
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

