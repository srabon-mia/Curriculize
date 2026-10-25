import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../../../supabase/migrations/0016_fair_pending_job_claims.sql', import.meta.url),
  'utf8'
);

describe('fair pending-job claim migration contract', () => {
  it('prefers never-claimed jobs, then the least recently claimed with stable ties', () => {
    expect(migration).toMatch(/ORDER BY candidate\.started_at ASC NULLS FIRST,\s*candidate\.created_at ASC,\s*candidate\.id ASC/);
    expect(migration).toMatch(/candidate\.status = 'pending'/);
    expect(migration).toMatch(/candidate\.job_type = p_job_type/);
    expect(migration).toContain('(p_curriculum_id IS NULL OR candidate.curriculum_id = p_curriculum_id)');

    const jobs = [
      { id: 'old-yielded', startedAt: '2026-10-24T20:30:00Z', createdAt: '2026-10-24T19:00:00Z' },
      { id: 'new-unclaimed', startedAt: null, createdAt: '2026-10-24T20:00:00Z' },
      { id: 'recently-claimed', startedAt: '2026-10-24T20:35:00Z', createdAt: '2026-10-24T18:00:00Z' },
    ].sort((a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
    expect(jobs.map((job) => job.id)).toEqual(['new-unclaimed', 'old-yielded', 'recently-claimed']);
  });

  it('retains atomic skip-locked claims, lease/token/version assignment, and return type', () => {
    expect(migration).toContain('p_job_type text');
    expect(migration).toContain('p_curriculum_id uuid DEFAULT NULL');
    expect(migration).toContain('RETURNS public.acquisition_jobs');
    expect(migration).toContain('claim_token = pg_catalog.gen_random_uuid()');
    expect(migration).toContain('claim_version = 1');
    expect(migration).toContain("claim_expires_at = pg_catalog.now() + interval '15 minutes'");
    expect(migration).toContain('started_at = pg_catalog.now()');
    expect(migration).toMatch(/FOR UPDATE SKIP LOCKED\s+LIMIT 1/);
    expect(migration).toContain('RETURNING claimed.* INTO v_job');
  });

  it('keeps the definer function restricted to the service role and does not alter yield semantics', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration).not.toMatch(/SET[^;]*yield_count/is);
  });
});
