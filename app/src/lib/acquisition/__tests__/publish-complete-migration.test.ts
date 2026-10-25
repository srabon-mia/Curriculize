import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../../../supabase/migrations/0015_atomic_publish_and_complete.sql', import.meta.url),
  'utf8'
);

describe('atomic publication migration contract', () => {
  it('locks and fences the running job before publishing', () => {
    expect(migration).toMatch(/FROM public\.acquisition_jobs[\s\S]*?WHERE id = p_job_id[\s\S]*?FOR UPDATE/);
    expect(migration).toContain('v_job.claim_token IS DISTINCT FROM p_claim_token');
    expect(migration).toContain('v_job.claim_version IS DISTINCT FROM p_expected_claim_version');
    expect(migration).toContain("v_job.status <> 'running'");
    expect(migration).toContain('v_job.claim_expires_at <= pg_catalog.clock_timestamp()');
  });

  it('publishes and completes in one database function and rolls back on completion mismatch', () => {
    const publishAt = migration.indexOf("SET status = 'published'");
    const completeAt = migration.indexOf("SET status = 'completed'");
    expect(publishAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(publishAt);
    expect(migration).toContain("RAISE EXCEPTION 'fenced job completion update did not match the locked job'");
    expect(migration).toContain("status = 'published'");
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'already_completed')");
  });

  it('uses a fixed search path and grants execution only to service_role', () => {
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
  });
});
