/**
 * Phase 9 Durable Job Types
 * TypeScript contracts for the durable acquisition job system.
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AcquisitionJob {
  id: string;
  curriculum_id: string | null;
  unit_id: string | null;
  understanding_id: string | null;
  job_type: string;
  status: JobStatus;
  input_data: JobInputData | null;
  result_data: JobResultData | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  budget_limits: JobBudgetLimits | null;
  claim_token: string | null;
  claim_version: number;
  claim_expires_at: string | null;
  created_by: string | null;
  checkpoint_version: number;
  budget_version: number;
  last_reservation_id: string | null;
}

export interface JobInputData {
  topic: string;
  grade_level: string;
  difficulty: string;
  existing_knowledge: string;
  learning_goal: string;
  time_available: string;
  added_context: string;
  totalTopics?: number;
}

export interface JobResultData {
  aiCallsUsed?: number;
  candidatesProcessed?: number;
  totalCandidatesProcessed?: number;
  topicsCompleted?: string[];
  resourcesFound?: number;
  checkpoint?: {
    completedTopicIds: string[];
    updatedAt: string;
  };
  batchCheckpoint?: {
    completedTopicIds: string[];
    updatedAt: string;
  };
  [key: string]: unknown;
}

export interface JobBudgetLimits {
  max_ai_calls: number;
  max_total_candidates_per_job: number;
  max_candidates_per_understanding: number;
  max_fetch_attempts: number;
  max_retries: number;
}

export interface CreateJobRequest {
  topic: string;
  grade_level: string;
  difficulty: string;
  existing_knowledge: string;
  learning_goal: string;
  time_available: string;
  added_context: string;
}

export interface CreateJobResponse {
  curriculum_id: string;
  job_id: string;
}

export interface JobClaimResult {
  id: string;
  curriculum_id: string | null;
  unit_id: string | null;
  understanding_id: string | null;
  job_type: string;
  status: JobStatus;
  input_data: JobInputData | null;
  result_data: JobResultData | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  budget_limits: JobBudgetLimits | null;
  claim_token: string;
  claim_version: number;
  claim_expires_at: string;
  created_by: string | null;
  checkpoint_version: number;
  budget_version: number;
  last_reservation_id: string | null;
}

export interface AIReservation {
  id: string;
  job_id: string;
  claim_token: string;
  claim_version: number;
  reservation_id: string;
  outcome: {
    reserved: boolean;
    used?: number;
    remaining?: number;
    reason?: string;
    idempotent?: boolean;
  };
  created_at: string;
}

export interface ReserveAICallRequest {
  job_id: string;
  claim_token: string;
  expected_claim_version: number;
  max_ai_calls: number;
  reservation_id: string;
}

export interface ReserveAICallResponse {
  reserved: boolean;
  used?: number;
  remaining?: number;
  reason?: string;
  idempotent?: boolean;
}

export interface PersistWithFenceRequest {
  job_id: string;
  claim_token: string;
  input: {
    acquiredPage: {
      finalUrl: string;
      canonicalUrl: { url: string };
      contentHash: string;
      statusCode: number;
      acquiredAt: string;
    };
    structuredContent: {
      metadata: {
        title?: string | null;
        description?: string | null;
        author?: string | null;
        datePublished?: string | null;
        language?: string | null;
      };
    };
    educationalEvidence: {
      interpreted: unknown;
    };
    verificationResult: {
      status: 'verified' | 'failed';
      deterministicChecks: { cleanedContentNonEmpty: boolean };
      advisorySignals: {
        titlePresent: boolean;
        educationalEvidencePresent: boolean;
        wordCount: number;
        headingCount: number;
        paragraphCount: number;
      };
      verifiedAt: string;
    };
    target: {
      nodeId?: string;
      understandingId?: string;
    };
    acquisitionJobId?: string;
    callerMetadata?: {
      resourceType?: string;
      licenseStatus?: 'cc_open' | 'link_only' | 'unknown_review_needed';
      aiNote?: string | null;
    };
  };
}

export interface PersistWithFenceResponse {
  resource_id: string;
  vr_id: string;
  mapping_id: string | null;
  is_exact_retry: boolean;
  error?: string;
}

export interface AdvanceCheckpointRequest {
  job_id: string;
  claim_token: string;
  expected_claim_version: number;
  completed_topic_id: string;
  resources_found: number;
}

export interface AdvanceCheckpointResponse {
  success: boolean;
}

export interface ClaimNextJobRequest {
  job_type: string;
  curriculum_id?: string;
}

export interface RenewLeaseRequest {
  job_id: string;
  claim_token: string;
}

export interface RenewLeaseResponse {
  success: boolean;
}

export interface CompleteJobRequest {
  job_id: string;
  claim_token: string;
  expected_claim_version: number;
  has_progress: boolean;
}

export interface FailJobRequest {
  job_id: string;
  claim_token: string;
  expected_claim_version: number;
  error: string;
}

export interface RecoverStaleJobsResponse {
  recovered_jobs: Array<{
    id: string;
    status: JobStatus;
    retry_count: number;
  }>;
}

export interface CreateJobAndCurriculumRequest {
  topic: string;
  grade_level: string;
  difficulty: string;
  existing_knowledge: string;
  learning_goal: string;
  time_available: string;
  added_context: string;
}

export interface CreateJobAndCurriculumResponse {
  curriculum_id: string;
  job_id: string;
  error?: string;
}

export const DEFAULT_BUDGET_LIMITS: JobBudgetLimits = {
  max_ai_calls: 32,
  max_total_candidates_per_job: 50,
  max_candidates_per_understanding: 5,
  max_fetch_attempts: 3,
  max_retries: 3,
};

export const LEASE_DURATION_MINUTES = 5;
export const LEASE_RENEWAL_INTERVAL_MS = 60_000; // 60 seconds