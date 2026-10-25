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
  recordResourceCoverageAttempt,
  CoverageAttemptRpcError,
  saveJobSkeleton,
  saveJobSources,
  SaveJobSkeletonError,
  completeJob,
  publishAndCompleteJob,
  PublishAndCompleteError,
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

  describe("saveJobSkeleton", () => {
    const input = {
      jobId: "job-1", claimToken: "claim-1", claimVersion: 2,
      skeleton: { title: "Math", source_type: "adapted", source_attribution: null, source_url: null,
        nodes: [{ title: "Algebra", order_index: 0, major_understandings: [{ code: "A.1", description: "Expressions" }] }] },
    };

    it("persists under the exact fenced RPC arguments and accepts saved", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { status: "saved" }, error: null });
      await expect(saveJobSkeleton(input)).resolves.toBe("saved");
      expect(mockSupabase.rpc).toHaveBeenCalledWith("save_job_skeleton", {
        p_job_id: input.jobId, p_claim_token: input.claimToken,
        p_expected_claim_version: input.claimVersion, p_skeleton: input.skeleton,
      });
    });

    it("accepts an identical replay and distinguishes lease loss", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: { status: "already_saved" }, error: null })
        .mockResolvedValueOnce({ data: { status: "ownership_lost_or_expired" }, error: null });
      await expect(saveJobSkeleton(input)).resolves.toBe("already_saved");
      await expect(saveJobSkeleton(input)).resolves.toBe("ownership_lost");
    });

    it.each(["invalid_skeleton", "skeleton_conflict", "unknown"])("surfaces RPC status %s as an error", async (status) => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { status }, error: null });
      await expect(saveJobSkeleton(input)).rejects.toBeInstanceOf(SaveJobSkeletonError);
    });

    it("surfaces database errors instead of reporting a shortfall", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: null, error: new Error("db") });
      await expect(saveJobSkeleton(input)).rejects.toMatchObject({ code: "DATABASE_ERROR" });
    });

    it("rejects empty and malformed RPC responses", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: { status: 12 }, error: null });
      await expect(saveJobSkeleton(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
      await expect(saveJobSkeleton(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });
  });

  describe("saveJobSources lease fencing", () => {
    const sources = [{ domain: "example.org", name: "Example", why: "test", best_for: "test" }];

    it("renews a live lease before writing the token/version-fenced source cache", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: true, error: null })
        .mockResolvedValueOnce({ data: true, error: null });

      await expect(saveJobSources("job-1", "claim-1", 7, sources)).resolves.toBe(true);
      expect(mockSupabase.rpc.mock.calls).toEqual([
        ["renew_lease", { p_job_id: "job-1", p_claim_token: "claim-1" }],
        ["save_job_sources", {
          p_job_id: "job-1", p_claim_token: "claim-1", p_expected_claim_version: 7, p_sources: sources,
        }],
      ]);
    });

    it("refuses an expired/stale lease without attempting the cache write", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: false, error: null });

      await expect(saveJobSources("job-1", "expired-claim", 7, sources)).resolves.toBe(false);
      expect(mockSupabase.rpc).toHaveBeenCalledTimes(1);
      expect(mockSupabase.rpc).toHaveBeenCalledWith("renew_lease", {
        p_job_id: "job-1", p_claim_token: "expired-claim",
      });
    });
  });

  describe("publishAndCompleteJob", () => {
    const input = { jobId: "job-1", claimToken: "claim-1", claimVersion: 2 };

    it("calls the atomic fenced publication RPC and accepts success", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { status: "completed" }, error: null });
      await expect(publishAndCompleteJob(input)).resolves.toBe("completed");
      expect(mockSupabase.rpc).toHaveBeenCalledWith("publish_and_complete_job", {
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_expected_claim_version: input.claimVersion,
      });
    });

    it("accepts a replay after the transaction committed but its response was lost", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { status: "already_completed" }, error: null });
      await expect(publishAndCompleteJob(input)).resolves.toBe("completed");
    });

    it("distinguishes stale ownership and a missing curriculum", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: { status: "ownership_lost_or_expired" }, error: null })
        .mockResolvedValueOnce({ data: { status: "curriculum_not_found" }, error: null });
      await expect(publishAndCompleteJob(input)).resolves.toBe("ownership_lost");
      await expect(publishAndCompleteJob(input)).rejects.toMatchObject({ code: "curriculum_not_found" });
    });

    it("surfaces database and malformed-response failures", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: null, error: new Error("db") })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: { status: 7 }, error: null });
      await expect(publishAndCompleteJob(input)).rejects.toBeInstanceOf(PublishAndCompleteError);
      await expect(publishAndCompleteJob(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
      await expect(publishAndCompleteJob(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    });
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

    it("throws a typed error when the claim RPC fails", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: new Error("DB error"),
      });

      await expect(claimNextJob()).rejects.toMatchObject({ name: "JobClaimRpcError" });
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

      const mockInput: Parameters<typeof persistWithFence>[2] = {
        acquiredPage: {
          finalUrl: "https://example.com",
          canonicalUrl: { url: "https://example.com" },
          contentHash: "abc123",
          statusCode: 200,
          acquiredAt: new Date().toISOString(),
        },
        structuredContent: {
          metadata: {
            title: "Café and Unicode 😀",
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
          aiNote: "literal \\u0000 remains text",
        },
      };
      Object.assign(mockInput.acquiredPage, { body: "unused page body with a NUL: \u0000", contentType: "text/html" });
      Object.assign(mockInput.structuredContent, { blocks: [{ text: "unused extracted text with a NUL: \u0000" }] });

      const result = await persistWithFence("test-job", "test-token", mockInput);

      expect(mockSupabase.rpc).toHaveBeenCalledWith("persist_with_fence", {
        p_job_id: "test-job",
        p_claim_token: "test-token",
        p_input: {
          acquiredPage: {
            finalUrl: "https://example.com",
            canonicalUrl: { url: "https://example.com" },
            contentHash: "abc123",
            statusCode: 200,
            acquiredAt: mockInput.acquiredPage.acquiredAt,
          },
          structuredContent: { metadata: mockInput.structuredContent.metadata },
          educationalEvidence: mockInput.educationalEvidence,
          verificationResult: mockInput.verificationResult,
          target: mockInput.target,
          acquisitionJobId: "test-job-id:node:test-node-id",
          callerMetadata: mockInput.callerMetadata,
        },
      });
      const rpcInput = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_input;
      expect(rpcInput.acquiredPage).not.toHaveProperty("body");
      expect(rpcInput.structuredContent).not.toHaveProperty("blocks");
      expect(rpcInput.structuredContent.metadata.title).toBe("Café and Unicode 😀");
      expect(rpcInput.callerMetadata.aiNote).toBe("literal \\u0000 remains text");
      expect(result.resource_id).toBe("test-resource");

      mockInput.target = { understandingId: "test-mu-id" };
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { resource_id: "test-resource", vr_id: "test-vr", is_exact_retry: false }, error: null });
      await persistWithFence("test-job", "test-token", mockInput);
      const secondRpcInput = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls[1][1].p_input;
      expect(secondRpcInput.acquisitionJobId).toBe("test-job-id:understanding:test-mu-id");
      expect(secondRpcInput.target).toEqual({ understandingId: "test-mu-id" });
    });

    it("reports only field paths and counts for unsupported Unicode in a jsonb error", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: { message: "unsupported Unicode escape sequence" },
      });
      const input: Parameters<typeof persistWithFence>[2] = {
        acquiredPage: {
          finalUrl: "https://example.com",
          canonicalUrl: { url: "https://example.com" },
          contentHash: "abc123",
          statusCode: 200,
          acquiredAt: new Date().toISOString(),
        },
        structuredContent: { metadata: { title: "Valid café 😀" } },
        educationalEvidence: { interpreted: { example: "bad\u0000value", literal: "\\u0000" } },
        verificationResult: {
          status: "verified" as const,
          deterministicChecks: { cleanedContentNonEmpty: true },
          advisorySignals: { titlePresent: true, educationalEvidencePresent: true, wordCount: 1, headingCount: 0, paragraphCount: 1 },
          verifiedAt: new Date().toISOString(),
        },
        target: { nodeId: "test-node-id" },
        acquisitionJobId: "test-job-id",
        callerMetadata: { aiNote: "valid backslash \\u0041 text" },
      };

      try {
        const result = await persistWithFence("test-job", "test-token", input);
        expect(result.error).toBe("unsupported Unicode escape sequence");
        expect(consoleError).toHaveBeenCalledWith("[persistence] JSONB Unicode input diagnostic:", {
          job_id: "test-job",
          fields: [{ path: "p_input.educationalEvidence.interpreted.example", nul_count: 1, unpaired_surrogate_count: 0 }],
        });
        expect(consoleError.mock.calls.flat().join(" ")).not.toContain("bad");
        expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Valid café");
      } finally {
        consoleError.mockRestore();
      }
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

  describe("recordResourceCoverageAttempt", () => {
    it("writes a fenced target attempt with a bounded retry limit", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { attempts: 1, status: "retrying", retry: true },
        error: null,
      });
      const result = await recordResourceCoverageAttempt({
        jobId: "job", claimToken: "token", claimVersion: 4,
        phase: "topic", targetId: "topic", attemptId: "attempt-uuid", resourcesFound: 0,
        sufficient: false, maxAttempts: 2,
      });
      expect(mockSupabase.rpc).toHaveBeenCalledWith("record_resource_coverage_attempt", {
        p_job_id: "job", p_claim_token: "token", p_expected_claim_version: 4,
        p_phase: "topic", p_target_id: "topic", p_attempt_id: "attempt-uuid", p_resources_found: 0,
        p_sufficient: false, p_max_attempts: 2, p_budget_exhausted: false,
      });
      expect(result).toEqual({ attempts: 1, status: "retrying", retry: true });
    });

    it("distinguishes explicit lease loss from contract and database failures", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { error: "ownership_lost_or_expired" }, error: null,
      });
      await expect(recordResourceCoverageAttempt({
        jobId: "job", claimToken: "token", claimVersion: 4, phase: "topic", targetId: "topic",
        attemptId: "attempt-uuid", resourcesFound: 0, sufficient: false,
      })).resolves.toEqual({ status: "ownership_lost", retry: false });

      for (const response of [
        { data: { error: "invalid_coverage_request" }, error: null },
        { data: { error: "some_unknown_error" }, error: null },
        { data: null, error: null },
        { data: { status: "complete", retry: false }, error: null },
        { data: { attempts: 1, status: "complete", retry: true }, error: null },
        { data: { attempts: 1, status: "unknown", retry: false }, error: null },
        { data: null, error: { message: "database unavailable" } },
      ]) {
        (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
        await expect(recordResourceCoverageAttempt({
          jobId: "job", claimToken: "token", claimVersion: 4, phase: "topic", targetId: "topic",
          attemptId: "attempt-uuid", resourcesFound: 0, sufficient: false,
        })).rejects.toBeInstanceOf(CoverageAttemptRpcError);
      }
    });

    it("forwards the same attempt UUID unchanged when a request is replayed", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: { attempts: 1, status: "retrying", retry: true }, error: null })
        .mockResolvedValueOnce({ data: { attempts: 1, status: "retrying", retry: true }, error: null });
      const request = {
        jobId: "job", claimToken: "token", claimVersion: 4, phase: "topic" as const,
        targetId: "topic", attemptId: "stable-attempt-id", resourcesFound: 0, sufficient: false,
      };
      await recordResourceCoverageAttempt(request);
      await recordResourceCoverageAttempt(request);
      expect(mockSupabase.rpc.mock.calls.map((call) => call[1].p_attempt_id)).toEqual([
        "stable-attempt-id", "stable-attempt-id",
      ]);
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

    it("propagates an RPC error instead of treating recovery failure as no stale jobs", async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: new Error("DB error"),
      });

      await expect(recoverStaleJobs()).rejects.toThrow("Recover stale jobs RPC failed");
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
