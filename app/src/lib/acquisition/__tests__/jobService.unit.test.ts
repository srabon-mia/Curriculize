/**
 * Unit tests for the acquisition job service layer.
 *
 * These tests mock the Supabase client's RPC mechanism to verify:
 *   - Correct RPC method calls with proper parameters
 *   - Error handling and return value mapping
 *   - Service-layer logic (idempotency, budget enforcement, etc.)
 *
 * NO NETWORK CALLS ARE MADE. NO DATABASE IS ACCESSED.
 * NO AI CREDITS ARE CONSUMED. NO TEST DATA IS CREATED.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the entire @supabase/supabase-js module BEFORE importing anything that uses it
// Use a shared singleton so getServiceClient() returns the same instance tests assert against
let _sharedMockSupabase: { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn>; auth: { getUser: ReturnType<typeof vi.fn> } } | null = null;
vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: () => {
      if (!_sharedMockSupabase) {
        _sharedMockSupabase = {
          rpc: vi.fn(),
          from: vi.fn(),
          auth: {
            getUser: vi.fn(),
          },
        };
      }
      return _sharedMockSupabase;
    },
  };
});

// Also mock the server supabase client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    rpc: vi.fn(),
    from: vi.fn(),
    auth: {
      getUser: vi.fn(),
    },
  })),
}));

// Now import the job service - it will use our mocked supabase client
import {
  claimNextJob,
  renewLease,
  reserveAICall,
  persistWithFence,
  advanceCheckpoint,
  completeJob,
  failJob,
  recoverStaleJobs,
  getJobById,
  DEFAULT_BUDGET_LIMITS,
} from "@/lib/acquisition/jobService";
import type {
  JobClaimResult,
  ReserveAICallResponse,
  PersistWithFenceResponse,
  AdvanceCheckpointResponse,
  CompleteJobResponse,
  FailJobResponse,
  RecoverStaleJobsResponse,
  JobBudgetLimits,
} from "@/lib/acquisition/jobTypes";

// Get access to the mocked supabase client instance
import { createClient } from "@supabase/supabase-js";

describe("Job Service Layer - RPC Contract Verification", () => {
  let mockSupabase: ReturnType<typeof createClient>;

  beforeEach(() => {
    // Get the mocked supabase client instance
    mockSupabase = createClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("claimNextJob", () => {
    it("calls claim_next_job RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          id: "test-job",
          curriculum_id: "test-curriculum",
          unit_id: null,
          understanding_id: null,
          job_type: "curriculum_generation",
          status: "pending",
          input_data: { topic: "test", grade_level: "high school", difficulty: "standard", existing_knowledge: "", learning_goal: "learn", time_available: "no time pressure", added_context: "" },
          result_data: null,
          error: null,
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          retry_count: 0,
          budget_limits: DEFAULT_BUDGET_LIMITS,
          claim_token: "test-token",
          claim_version: 1,
          claim_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          created_by: null,
          checkpoint_version: 0,
          budget_version: 0,
          last_reservation_id: null,
        },
        error: null,
      });

      const result = await claimNextJob("curriculum_generation", "test-curriculum");

      expect(mockSupabase.rpc).toHaveBeenCalledWith("claim_next_job", {
        p_job_type: "curriculum_generation",
        p_curriculum_id: "test-curriculum",
      });
    });

    it("returns job data when RPC succeeds", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          id: "test-job",
          curriculum_id: "test-curriculum",
          job_type: "curriculum_generation",
          status: "pending",
          input_data: null,
          result_data: null,
          error: null,
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          retry_count: 0,
          budget_limits: DEFAULT_BUDGET_LIMITS,
          claim_token: "token",
          claim_version: 1,
          claim_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          created_by: null,
          checkpoint_version: 0,
          budget_version: 0,
          last_reservation_id: null,
        },
        error: null,
      });

      const result = await claimNextJob();

      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-job");
    });

    it("returns null when RPC returns null data", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: null,
      });

      const result = await claimNextJob();

      expect(result).toBeNull();
    });

    it("returns null when RPC returns an error", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: new Error("DB error"),
      });

      const result = await claimNextJob();

      expect(result).toBeNull();
    });
  });

  describe("renewLease", () => {
    it("calls renew_lease RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: true,
        error: null,
      });

      const result = await renewLease("test-job", "test-token");

      expect(mockSupabase.rpc).toHaveBeenCalledWith("renew_lease", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
      });
      expect(result).toBe(true);
    });

    it("returns false when RPC returns false", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: false,
        error: null,
      });

      const result = await renewLease("test-job", "test-token");

      expect(result).toBe(false);
    });
  });

  describe("reserveAICall", () => {
    it("calls reserve_ai_call RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { reserved: true, used: 1, remaining: 11 },
        error: null,
      });

      const result = await reserveAICall("test-job", "test-token", 1, 12, "test-reservation-id");

      expect(mockSupabase.rpc).toHaveBeenCalledWith("reserve_ai_call", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
        p_expected_claim_version: 1,
        p_max_ai_calls: 12,
        p_reservation_id: "test-reservation-id",
      });
      expect(result.reserved).toBe(true);
    });

    it("returns idempotent=true when called twice with same reservation_id", async () => {
      // First call: succeeds
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { reserved: true, used: 1, remaining: 11 },
        error: null,
      });
      // Second call with same reservation_id: also succeeds, idempotent=true
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { reserved: true, used: 2, remaining: 10, idempotent: true },
        error: null,
      });

      const result1 = await reserveAICall("test-job", "test-token", 1, 12, "test-reservation-id");
      const result2 = await reserveAICall("test-job", "test-token", 2, 12, "test-reservation-id");

      expect(result2.idempotent).toBe(true);
      expect(result2.used).toBe(2);
    });

    it("returns budget_exhausted when max_ai_calls exceeded", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { reserved: false, reason: "budget_exhausted" },
        error: null,
      });

      const result = await reserveAICall("test-job", "test-token", 13, 12, "test-reservation-id");

      expect(result.reserved).toBe(false);
      expect(result.reason).toBe("budget_exhausted");
    });
  });

  describe("persistWithFence", () => {
    it("calls persist_with_fence RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { resource_id: "test-resource", vr_id: "test-vr", mapping_id: "test-mapping", is_exact_retry: false },
        error: null,
      });

      const mockInput = {
        acquiredPage: {
          finalUrl: "https://example.com",
          canonicalUrl: { url: "https://example.com" },
          contentHash: "abc123",
          statusCode: 200,
          acquiredAt: new Date().toISOString(),
          contentType: "text/html",
        },
        structuredContent: {
          metadata: {
            title: "Test Resource",
            description: "Test Description",
            author: "Test Author",
            datePublished: "2023-01-01",
            language: "en",
          },
        },
        educationalEvidence: {
          interpreted: { explicitLearningObjectives: [], explicitDefinitions: [], explicitExercises: [] },
        },
        verificationResult: {
          status: "verified",
          deterministicChecks: { cleanedContentNonEmpty: true },
          advisorySignals: {
            titlePresent: true,
            educationalEvidencePresent: true,
            wordCount: 100,
            headingCount: 2,
            paragraphCount: 5,
          },
          verifiedAt: new Date().toISOString(),
        },
        target: { nodeId: "test-node-id" },
        acquisitionJobId: "test-job-id",
        callerMetadata: {
          resourceType: "video",
          licenseStatus: "cc_open",
          aiNote: "Test note",
        },
      };

      const result = await persistWithFence("test-job", "test-token", mockInput);

      expect(mockSupabase.rpc).toHaveBeenCalledWith("persist_with_fence", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
        p_input: mockInput,
      });
      expect(result.resource_id).toBe("test-resource");
    });

    it("returns error when ownership is lost", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: new Error("ownership_lost_or_expired"),
      });

      const mockInput = {
        acquiredPage: {
          finalUrl: "https://example.com",
          canonicalUrl: { url: "https://example.com" },
          contentHash: "abc123",
          statusCode: 200,
          acquiredAt: new Date().toISOString(),
          contentType: "text/html",
        },
        structuredContent: { metadata: {} },
        educationalEvidence: { interpreted: {} },
        verificationResult: { status: "verified", deterministicChecks: {}, advisorySignals: {}, verifiedAt: new Date().toISOString() },
        target: { nodeId: "test-node-id" },
        acquisitionJobId: "test-job-id",
        callerMetadata: { resourceType: "video", licenseStatus: "cc_open", aiNote: null },
      };

      const result = await persistWithFence("test-job", "wrong-token", mockInput);

      expect(result.error).toBe("ownership_lost_or_expired");
      expect(result.resource_id).toBe("");
      expect(result.vr_id).toBe("");
      expect(result.mapping_id).toBeNull();
    });
  });

  describe("advanceCheckpoint", () => {
    it("calls advance_checkpoint RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: true,
        error: null,
      });

      const result = await advanceCheckpoint("test-job", "test-token", 1, "test-topic-id", 5);

      expect(mockSupabase.rpc).toHaveBeenCalledWith("advance_checkpoint", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
        p_expected_claim_version: 1,
        p_completed_topic_id: "test-topic-id",
        p_resources_found: 5,
      });
      expect(result).toBe(true);
    });

    it("returns false when RPC returns an error", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: false,
        error: new Error("version mismatch"),
      });

      const result = await advanceCheckpoint("test-job", "test-token", 1, "test-topic-id", 5);

      expect(result).toBe(false);
    });
  });

  describe("completeJob", () => {
    it("calls complete_job RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: true,
        error: null,
      });

      const result = await completeJob("test-job", "test-token", 1, true);

      expect(mockSupabase.rpc).toHaveBeenCalledWith("complete_job", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
        p_expected_claim_version: 1,
        p_has_progress: true,
      });
      expect(result).toBe(true);
    });
  });

  describe("failJob", () => {
    it("calls fail_job RPC with correct parameters", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: true,
        error: null,
      });

      const result = await failJob("test-job", "test-token", 1, "Test error");

      expect(mockSupabase.rpc).toHaveBeenCalledWith("fail_job", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
        p_expected_claim_version: 1,
        p_error: "Test error",
      });
      expect(result).toBe(true);
    });
  });

  describe("recoverStaleJobs", () => {
    it("calls recover_stale_jobs RPC", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [{ id: "test-job", status: "pending", retry_count: 1 } as const],
        error: null,
      });

      const result = await recoverStaleJobs();

      expect(mockSupabase.rpc).toHaveBeenCalledWith("recover_stale_jobs");
      expect(result).toEqual([{ id: "test-job", status: "pending", retry_count: 1 }]);
    });

    it("returns empty array when RPC returns an error", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: new Error("DB error"),
      });

      const result = await recoverStaleJobs();

      expect(result).toEqual([]);
    });
  });

  describe("getJobById", () => {
    it("queries acquisition_jobs table with correct parameters", async () => {
      const mockJob = {
        id: "test-job",
        curriculum_id: "test-curriculum",
        job_type: "curriculum_generation",
        status: "completed" as const,
        input_data: { topic: "test", grade_level: "high school", difficulty: "standard", existing_knowledge: "", learning_goal: "learn", time_available: "no time pressure", added_context: "" },
        result_data: { aiCallsUsed: 5, topicsCompleted: ["topic-1"] },
        error: null,
        created_at: new Date().toISOString(),
        started_at: new Date(Date.now() - 60 * 1000).toISOString(),
        completed_at: new Date().toISOString(),
        retry_count: 0,
        budget_limits: DEFAULT_BUDGET_LIMITS,
        claim_token: null,
        claim_version: 0,
        claim_expires_at: null,
        created_by: null,
        checkpoint_version: 1,
        budget_version: 0,
        last_reservation_id: null,
      } as AcquisitionJob;

      (mockSupabase.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: mockJob, error: null }),
      });

      const result = await getJobById("test-job");

      expect(mockSupabase.from).toHaveBeenCalledWith("acquisition_jobs");
      expect(result).toEqual(mockJob);
    });
  });
});
