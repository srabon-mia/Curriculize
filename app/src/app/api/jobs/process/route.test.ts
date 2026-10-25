/**
 * HTTP-level tests for the Phase 9 job processor endpoint (/api/jobs/process).
 *
 * All Supabase, AI, and worker dependencies are mocked so these tests:
 *   - make no network calls
 *   - consume no AI credits
 *   - touch no production database
 *   - create or modify no data
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================
// Mock Supabase client - prevents any real database access
// ============================================================

const mockRpc = vi.fn().mockResolvedValue(null);

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  })),
}));

// ============================================================
// Mock acquisition job service - controls claim/recover behavior
// ============================================================

vi.mock("@/lib/acquisition/jobService", () => ({
  claimNextJob: vi.fn(),
  recoverStaleJobs: vi.fn().mockResolvedValue([]),
}));

// ============================================================
// Mock AI provider - prevents any AI provider initialization
// ============================================================

vi.mock("@/lib/ai", () => ({
  getAIProvider: vi.fn(() => ({
    complete: vi.fn().mockResolvedValue({ text: "{}" }),
  })),
}));

// ============================================================
// Mock worker - processJob is never called in these tests,
// but mocked for safety in case a code path reaches it.
// ============================================================

vi.mock("@/lib/acquisition/worker", () => ({
  processJob: vi.fn().mockResolvedValue('completed'),
}));

// Import after mocks are registered
import { POST } from "./route";
import { claimNextJob, recoverStaleJobs } from "@/lib/acquisition/jobService";
import { processJob } from "@/lib/acquisition/worker";

const TEST_CRON_SECRET = "test-cron-secret-do-not-use-in-production";

function createRequest(authorization?: string) {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) {
    headers["Authorization"] = authorization;
  }
  return new Request("http://localhost/api/jobs/process", {
    method: "POST",
    headers,
  });
}

describe("POST /api/jobs/process", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = TEST_CRON_SECRET;
    vi.clearAllMocks();
    mockRpc.mockResolvedValue(null);
    (recoverStaleJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.CURRICULIZE_PROCESSOR_WORK_BUDGET_MS;
    vi.clearAllMocks();
  });

  it("returns HTTP 401 when the Authorization header is missing", async () => {
    const request = createRequest();
    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");

    // No job service functions should be invoked when auth fails
    expect(recoverStaleJobs).not.toHaveBeenCalled();
    expect(claimNextJob).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(createRequest(`Bearer ${TEST_CRON_SECRET}`));
    expect(response.status).toBe(401);
    expect(recoverStaleJobs).not.toHaveBeenCalled();
    expect(claimNextJob).not.toHaveBeenCalled();
  });

  it.each(["Basic test", `Bearer  ${TEST_CRON_SECRET}`, `bearer ${TEST_CRON_SECRET}`, "Bearer"]) (
    "rejects malformed Authorization format: %s",
    async (authorization) => {
      const response = await POST(createRequest(authorization));
      expect(response.status).toBe(401);
      expect(claimNextJob).not.toHaveBeenCalled();
    }
  );

  it("returns HTTP 401 when the bearer token is incorrect", async () => {
    const request = createRequest("Bearer wrong-token");
    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");

    expect(recoverStaleJobs).not.toHaveBeenCalled();
    expect(claimNextJob).not.toHaveBeenCalled();
  });

  it("returns HTTP 200 with processed: 0 when the queue is empty", async () => {
    (claimNextJob as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (recoverStaleJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const request = createRequest(`Bearer ${TEST_CRON_SECRET}`);
    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.processed).toBe(0);
    expect(json.message).toBe("No pending jobs");

    expect(recoverStaleJobs).toHaveBeenCalledTimes(1);
    expect(claimNextJob).toHaveBeenCalledTimes(1);
    expect(claimNextJob).toHaveBeenCalledWith("curriculum_generation", undefined, expect.any(AbortSignal));
  });

  it("reports a durable worker yield as HTTP 202 for the next cron invocation", async () => {
    (claimNextJob as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-yield", claim_token: "token" });
    (processJob as ReturnType<typeof vi.fn>).mockResolvedValue("yielded");
    const response = await POST(createRequest(`Bearer ${TEST_CRON_SECRET}`));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "yielded", jobId: "job-yield" });
  });

  it("passes a claimed checkpointed job to the durable worker so it can resume", async () => {
    const resumableJob = {
      id: "hydroponics-job",
      curriculum_id: "hydroponics-curriculum",
      status: "running",
      claim_token: "fresh-claim-token",
      claim_version: 1,
      result_data: {
        checkpoint: { completedTopicIds: Array.from({ length: 8 }, (_, i) => `topic-${i + 1}`) },
        batchCheckpoint: { completedTopicIds: ["topic-1"] },
      },
      checkpoint_version: 18,
    };
    (claimNextJob as ReturnType<typeof vi.fn>).mockResolvedValue(resumableJob);
    (processJob as ReturnType<typeof vi.fn>).mockResolvedValue("yielded");

    const response = await POST(createRequest(`Bearer ${TEST_CRON_SECRET}`));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "yielded", jobId: "hydroponics-job" });
    expect(processJob).toHaveBeenCalledWith(resumableJob, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("does not report a failed fenced release as a successful job completion", async () => {
    (claimNextJob as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "job-lost", claim_token: "token" });
    (processJob as ReturnType<typeof vi.fn>).mockResolvedValue("ownership_lost");
    const response = await POST(createRequest(`Bearer ${TEST_CRON_SECRET}`));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "ownership_lost", processed: 0 });
  });

  it("returns a retryable non-success response when the claim RPC fails", async () => {
    (claimNextJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("database details must not be returned"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(createRequest(`Bearer ${TEST_CRON_SECRET}`));
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("Job claim temporarily unavailable");
    expect(JSON.stringify(json)).not.toContain("database details");
    expect(errorLog).toHaveBeenCalledWith("[jobs/process] Job claim failed", {
      operation: "claim_next_job",
      error_name: "Error",
    });
    errorLog.mockRestore();
  });

  it.each(['recovery', 'claim'] as const)("returns promptly when the %s RPC reaches the invocation deadline", async (phase) => {
    process.env.CURRICULIZE_PROCESSOR_WORK_BUDGET_MS = '1000';
    vi.useFakeTimers();
    const waitUntilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    if (phase === 'recovery') {
      (recoverStaleJobs as ReturnType<typeof vi.fn>).mockImplementation((signal: AbortSignal) => waitUntilAborted(signal));
    } else {
      (claimNextJob as ReturnType<typeof vi.fn>).mockImplementation((_type: string, _curriculum: string | undefined, signal: AbortSignal) => waitUntilAborted(signal));
    }

    const responsePromise = POST(createRequest(`Bearer ${TEST_CRON_SECRET}`));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'yielded', phase: phase === 'claim' ? 'claim_outcome_unknown' : phase });
    vi.useRealTimers();
  });
});
