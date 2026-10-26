import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const coverageMigration = readFileSync(
  new URL("../../../../../supabase/migrations/0017_reset_yield_count_on_coverage_progress.sql", import.meta.url),
  "utf8"
);
const releaseMigration = readFileSync(
  new URL("../../../../../supabase/migrations/0011_worker_yield_and_batch_checkpoint.sql", import.meta.url),
  "utf8"
);
const claimMigration = readFileSync(
  new URL("../../../../../supabase/migrations/0016_fair_pending_job_claims.sql", import.meta.url),
  "utf8"
);

describe("coverage progress yield-counter migration source contract", () => {
  it("rejects null phase and attempt-limit arguments explicitly", () => {
    const validation = coverageMigration.slice(0, coverageMigration.indexOf("SELECT * INTO v_job"));

    expect(validation).toContain("p_phase IS NULL OR p_phase NOT IN ('topic', 'batch')");
    expect(validation).toContain("p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 2");
  });

  it("resets only in the same fenced write that persists a new checkpoint", () => {
    const replayCheck = coverageMigration.indexOf("IF v_attempt_ids ? p_attempt_id::text THEN");
    const replayEnd = coverageMigration.indexOf("END IF;", replayCheck);
    const updateStart = coverageMigration.indexOf("UPDATE public.acquisition_jobs", replayEnd);
    const reset = coverageMigration.indexOf("yield_count = 0", updateStart);
    const updateNotFound = coverageMigration.indexOf("IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired')", updateStart);

    expect(replayCheck).toBeGreaterThan(-1);
    expect(replayEnd).toBeGreaterThan(replayCheck);
    expect(updateStart).toBeGreaterThan(replayEnd);
    expect(reset).toBeGreaterThan(updateStart);
    expect(reset).toBeLessThan(updateNotFound);
    expect(coverageMigration.slice(updateStart, updateNotFound)).toMatch(/SET result_data = v_data,[\s\S]*checkpoint_version = checkpoint_version \+ 1,[\s\S]*yield_count = 0/);
    expect(coverageMigration.slice(updateStart, updateNotFound)).toMatch(/WHERE id = p_job_id AND claim_token = p_claim_token\s+AND claim_version = p_expected_claim_version AND status = 'running'\s+AND claim_expires_at > pg_catalog\.now\(\)/);
  });

  it("returns an identical attempt replay before any write or yield reset", () => {
    const replayCheck = coverageMigration.indexOf("IF v_attempt_ids ? p_attempt_id::text THEN");
    const replayEnd = coverageMigration.indexOf("END IF;", replayCheck);
    const firstWrite = coverageMigration.indexOf("UPDATE public.acquisition_jobs", replayEnd);
    const replayBlock = coverageMigration.slice(replayCheck, replayEnd);

    expect(replayBlock).toContain("RETURN jsonb_build_object(");
    expect(replayBlock).toContain("'attempts', v_attempts");
    expect(firstWrite).toBeGreaterThan(replayEnd);
    expect(replayBlock).not.toContain("yield_count");
    expect(replayBlock).not.toContain("checkpoint_version");
  });

  it("does not let fresh UUIDs bypass the two-attempt limit or reset terminal targets", () => {
    const replayCheck = coverageMigration.indexOf("IF v_attempt_ids ? p_attempt_id::text THEN");
    const replayEnd = coverageMigration.indexOf("END IF;", replayCheck);
    const terminalGuard = coverageMigration.indexOf("IF v_status IN ('complete', 'insufficient') THEN", replayEnd);
    const attemptLimitGuard = coverageMigration.indexOf("IF v_attempts >= p_max_attempts THEN", terminalGuard);
    const update = coverageMigration.indexOf("UPDATE public.acquisition_jobs", attemptLimitGuard);

    expect(coverageMigration).toContain("p_max_attempts > 2");
    expect(terminalGuard).toBeGreaterThan(replayEnd);
    expect(attemptLimitGuard).toBeGreaterThan(terminalGuard);
    expect(update).toBeGreaterThan(attemptLimitGuard);
    expect(coverageMigration.slice(terminalGuard, update)).toContain("RETURN jsonb_build_object(");
    expect(coverageMigration.slice(terminalGuard, update)).not.toContain("yield_count = 0");
  });

  it("preserves the nine-topic route's 17 ordinary releases when each follows new progress", () => {
    const topicCount = 9;
    const topicPhaseReleases = topicCount; // one target boundary each, including the phase handoff
    const conceptPhaseReleases = topicCount - 1; // between concept batches
    const expectedReleases = topicPhaseReleases + conceptPhaseReleases;
    expect(expectedReleases).toBe(17);

    // Model the SQL order: a new fenced attempt checkpoint resets the count,
    // then release_job_claim increments it. This is a control-flow model, not
    // execution of the PostgreSQL function.
    let yieldCount = 0;
    let releases = 0;
    for (let i = 0; i < expectedReleases; i++) {
      yieldCount = 0;
      if (yieldCount >= 10) break;
      yieldCount++;
      releases++;
    }
    expect(releases).toBe(17);
    expect(yieldCount).toBe(1);
  });

  it("keeps the release cap for yields that have no new durable checkpoint", () => {
    expect(releaseMigration).toContain("yield_count = yield_count + 1");
    expect(releaseMigration).toContain("AND yield_count < 10");

    let yieldCount = 0;
    const release = () => {
      if (yieldCount >= 10) return false;
      yieldCount++;
      return true;
    };

    for (let i = 0; i < 10; i++) expect(release()).toBe(true);
    expect(yieldCount).toBe(10);
    expect(release()).toBe(false);
  });

  it("does not reset the counter on claim; stale or expired checkpoints are fenced out", () => {
    expect(claimMigration).not.toMatch(/SET[^;]*yield_count/is);
    expect(coverageMigration).toMatch(/WHERE id = p_job_id AND claim_token = p_claim_token\s+AND claim_version = p_expected_claim_version\s+AND status = 'running' AND claim_expires_at > pg_catalog\.now\(\)\s+FOR NO KEY UPDATE/);
    expect(coverageMigration).toMatch(/IF NOT FOUND THEN RETURN jsonb_build_object\('error', 'ownership_lost_or_expired'\); END IF;/);
    expect(coverageMigration).toMatch(/checkpoint_version = checkpoint_version \+ 1,[\s\S]*yield_count = 0[\s\S]*WHERE id = p_job_id AND claim_token = p_claim_token\s+AND claim_version = p_expected_claim_version AND status = 'running'\s+AND claim_expires_at > pg_catalog\.now\(\);\s+IF NOT FOUND THEN RETURN jsonb_build_object\('error', 'ownership_lost_or_expired'\)/);
  });
});
