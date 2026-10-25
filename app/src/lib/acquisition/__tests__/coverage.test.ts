import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getCoverageStatus, getStoredCoverageStatus, mapUnderstandingCodesToIds, runBoundedCoverageAttempts } from "../coverage";
import type { CoverageAttemptDecision } from "../coverage";

describe("resource coverage status", () => {
  it("keeps SQL attempt UUID replay idempotent before incrementing attempts", () => {
    const migration = readFileSync(
      new URL("../../../../../supabase/migrations/0013_resource_coverage_attempts.sql", import.meta.url),
      "utf8"
    );
    const replayCheck = migration.indexOf("IF v_attempt_ids ? p_attempt_id::text THEN");
    const increment = migration.indexOf("v_attempts := v_attempts + 1;");
    expect(replayCheck).toBeGreaterThan(-1);
    expect(increment).toBeGreaterThan(replayCheck);
    expect(migration).toContain("v_attempt_ids || jsonb_build_array(p_attempt_id::text)");
  });

  it("keeps an empty topic pending while discovery is running", () => {
    expect(getCoverageStatus({ jobStatus: "running", topicCounts: [0], understandingCounts: [0] })).toBe("pending");
  });

  it("reports terminal zero-resource topics as insufficient", () => {
    expect(getCoverageStatus({ jobStatus: "completed", topicCounts: [0], understandingCounts: [2] })).toBe("insufficient");
  });

  it("requires multiple topic and understanding resources", () => {
    expect(getCoverageStatus({ jobStatus: "completed", topicCounts: [3], understandingCounts: [2, 1] })).toBe("insufficient");
    expect(getCoverageStatus({ jobStatus: "completed", topicCounts: [3], understandingCounts: [2, 0] })).toBe("insufficient");
    expect(getCoverageStatus({ jobStatus: "completed", topicCounts: [3], understandingCounts: [2, 2] })).toBe("complete");
  });

  it("does not call failed discovery complete even with partial resources", () => {
    expect(getCoverageStatus({ jobStatus: "failed", topicCounts: [5], understandingCounts: [3] })).toBe("failed");
  });

  it("keeps job coverage pending during work and insufficient when terminal records are missing", () => {
    expect(getStoredCoverageStatus({ jobStatus: "running", coverage: {}, expectedTargets: 2 })).toBe("pending");
    expect(getStoredCoverageStatus({ jobStatus: "completed", coverage: {}, expectedTargets: 2 })).toBe("insufficient");
    expect(getStoredCoverageStatus({
      jobStatus: "completed", coverage: { "topic:a": { status: "complete" }, "batch:a": { status: "complete" } }, expectedTargets: 2,
    })).toBe("complete");
    expect(getStoredCoverageStatus({ jobStatus: "failed", coverage: {}, expectedTargets: 2 })).toBe("failed");
  });

  it("preserves only explicitly named understanding associations", () => {
    const understandings = [
      { id: "a", code: "1.1", external_key: "one" },
      { id: "b", code: "1.2", external_key: "two" },
    ];
    expect(mapUnderstandingCodesToIds(["1.2"], understandings)).toEqual(["b"]);
    expect(mapUnderstandingCodesToIds(undefined, understandings)).toEqual([]);
    expect(mapUnderstandingCodesToIds(["unknown"], understandings)).toEqual([]);
  });

  it("retries empty discovery and checkpoints only after a later eligible association exists", async () => {
    let persisted = 0;
    let attempts = 0;
    const checkpointCounts: number[] = [];
    const outcome = await runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => { attempts++; if (attempts === 2) persisted = 3; return "attempted"; },
      measureEligibleResources: async () => persisted,
      record: async ({ resourcesFound, sufficient }) => {
        checkpointCounts.push(resourcesFound);
        return { attempts, status: sufficient ? "complete" : "retrying", retry: !sufficient } as const;
      },
    });
    expect(outcome).toBe("complete");
    expect(attempts).toBe(2);
    expect(checkpointCounts).toEqual([0, 3]);
  });

  it("resumes at the next persisted retry using its deterministic attempt ID", async () => {
    const attemptIndices: number[] = [];
    const recordedIds: string[] = [];
    const outcome = await runBoundedCoverageAttempts({
      maxAttempts: 2,
      initialAttempts: 1,
      attemptIdFor: (index) => `attempt-${index}`,
      attempt: async (index) => { attemptIndices.push(index); return 'attempted'; },
      measureEligibleResources: async () => 3,
      record: async (result) => {
        recordedIds.push(result.attemptId);
        return { attempts: 2, status: 'complete', retry: false };
      },
    });
    expect(attemptIndices).toEqual([1]);
    expect(recordedIds).toEqual(['attempt-1']);
    expect(outcome).toBe('complete');
  });

  it("reuses the same attempt ID when an invocation is interrupted before its attempt checkpoint", async () => {
    const ids: string[] = [];
    let interrupt = true;
    const config = {
      maxAttempts: 2,
      attemptIdFor: (index: number) => `attempt-${index}`,
      attempt: async (index: number) => {
        ids.push(`reserved-${index}`);
        if (interrupt) { interrupt = false; throw new Error('deadline'); }
        return 'attempted' as const;
      },
      measureEligibleResources: async () => 0,
      record: async ({ attemptId }: { attemptId: string }) => {
        ids.push(attemptId);
        return { attempts: 1, status: 'insufficient', retry: false } as const;
      },
    };
    await expect(runBoundedCoverageAttempts(config)).rejects.toThrow('deadline');
    await expect(runBoundedCoverageAttempts(config)).resolves.toBe('insufficient');
    expect(ids).toEqual(['reserved-0', 'reserved-0', 'attempt-0']);
  });

  it("bounds repeated empty or malformed results and records insufficient", async () => {
    let attempts = 0;
    const statuses: string[] = [];
    const outcome = await runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => { attempts++; return "attempted"; },
      measureEligibleResources: async () => 0,
      record: async () => {
        const result = attempts === 2
          ? { attempts, status: "insufficient", retry: false } as const
          : { attempts, status: "retrying", retry: true } as const;
        statuses.push(result.status);
        return result;
      },
    });
    expect(attempts).toBe(2);
    expect(statuses).toEqual(["retrying", "insufficient"]);
    expect(outcome).toBe("insufficient");
  });

  it("does not count candidate failures as success and propagates persistence failures", async () => {
    let attempts = 0;
    const outcome = await runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => { attempts++; return "attempted"; }, // fetch/extract/verify all rejected
      measureEligibleResources: async () => 0,
      record: async ({ sufficient }) => {
        const decision: CoverageAttemptDecision = sufficient
          ? { attempts, status: "complete", retry: false }
          : { attempts, status: "retrying", retry: true };
        return decision;
      },
    });
    expect(outcome).toBe("insufficient");
    expect(attempts).toBe(2);

    await expect(runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => { throw new Error("persistence failed"); },
      measureEligibleResources: async () => 0,
      record: async () => ({ status: "ownership_lost", retry: false }),
    })).rejects.toThrow("persistence failed");
  });

  it("reports budget exhaustion as insufficient and stops on lost lease ownership", async () => {
    const statuses: string[] = [];
    await runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => "budget_exhausted",
      measureEligibleResources: async () => 0,
      record: async ({ budgetExhausted }) => {
        statuses.push(budgetExhausted ? "insufficient" : "retrying");
        return { status: "insufficient", retry: false };
      },
    });
    expect(statuses).toEqual(["insufficient"]);
    const lost = await runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => "ownership_lost",
      measureEligibleResources: async () => 0,
      record: async () => null,
    });
    expect(lost).toBe("ownership_lost");
  });

  it("propagates an unexpected coverage RPC failure instead of reporting a shortfall", async () => {
    await expect(runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => "attempted",
      measureEligibleResources: async () => 0,
      record: async () => { throw new Error("Coverage RPC contract failure"); },
    })).rejects.toThrow("Coverage RPC contract failure");
  });

  it("records a terminal shortfall when budget runs out midway through retries", async () => {
    let discoveryCalls = 0;
    const recorded: Array<{ resourcesFound: number; sufficient: boolean; budgetExhausted: boolean }> = [];
    const outcome = await runBoundedCoverageAttempts({
      maxAttempts: 2,
      threshold: 3,
      attempt: async () => ++discoveryCalls === 1 ? "attempted" : "budget_exhausted",
      measureEligibleResources: async () => 1,
      record: async (result) => {
        recorded.push(result);
        return result.budgetExhausted
          ? { attempts: discoveryCalls, status: "insufficient", retry: false } as const
          : { attempts: discoveryCalls, status: "retrying", retry: true } as const;
      },
    });

    expect(discoveryCalls).toBe(2);
    expect(recorded).toHaveLength(2);
    expect(recorded[0].budgetExhausted).toBe(false);
    expect(recorded[1]).toMatchObject({ resourcesFound: 1, sufficient: false, budgetExhausted: true });
    expect(outcome).toBe("insufficient");
  });
});
