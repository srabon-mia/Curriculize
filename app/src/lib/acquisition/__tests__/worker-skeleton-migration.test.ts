import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/0014_durable_job_skeleton.sql'),
  'utf8'
);

describe('durable skeleton RPC migration contract', () => {
  it('fences writes by claim identity, version, running status, and live lease', () => {
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('v_job.claim_token IS DISTINCT FROM p_claim_token');
    expect(migration).toContain('v_job.claim_version IS DISTINCT FROM p_expected_claim_version');
    expect(migration).toContain("v_job.status <> 'running'");
    expect(migration).toContain('v_job.claim_expires_at <= pg_catalog.clock_timestamp()');
    expect(migration).toContain('claim_expires_at > pg_catalog.clock_timestamp()');
  });

  it('preserves existing result_data, makes identical writes idempotent, and rejects conflicts', () => {
    expect(migration).toContain("COALESCE(v_job.result_data, '{}'::jsonb)");
    expect(migration).toContain("jsonb_set(v_data, '{skeleton}', p_skeleton, true)");
    expect(migration).toContain("'already_saved'");
    expect(migration).toContain("'skeleton_conflict'");
  });

  it('uses a fixed search path and grants execution only to service_role', () => {
    expect(migration).toContain('SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION save_job_skeleton(uuid, uuid, int, jsonb) FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION save_job_skeleton(uuid, uuid, int, jsonb) TO service_role');
  });
});
