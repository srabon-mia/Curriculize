-- 0011_worker_yield_and_batch_checkpoint.sql
--
-- Adds three new RPCs for resumable, bounded worker invocations:
--   1. release_job_claim         — yield a running job without consuming a retry
--   2. advance_batch_checkpoint  — batch-phase progress (separate from topics)
--   3. save_job_sources          — persist discovered sources for resume
--   4. yield_count column        — prevents infinite yield loops (cap = 10 per claim cycle)
--
-- NOTE: migration 0009 defines and fixes advance_checkpoint; 0011 redefines
-- _checkpoint_merge with an IDENTICAL body so that 0011 remains self-contained.
-- Apply 0009 before 0011 so that advance_checkpoint already exists. PostgreSQL
-- has no function "re-export" mechanism — this migration does not redefine
-- advance_checkpoint.
--
-- FIX: This migration also redefines recover_stale_jobs and claim_next_job
-- to reset yield_count = 0 on recovery/claim, so the yield cap applies
-- per claim cycle (not per job lifetime). This allows long curricula to
-- complete across multiple invocations while still preventing infinite
-- yield loops within a single claim.

-- ---------------------------------------------------------------------------
-- 1. Add yield_count column to acquisition_jobs
-- ---------------------------------------------------------------------------
-- Default 0 for new rows. Existing rows get 0 via default.
-- The column tracks how many times a job has yielded its claim via
-- release_job_claim within the CURRENT claim cycle.
-- When yield_count reaches 10, the job cannot yield further and will be
-- recovered by recover_stale_jobs after lease expiry.
-- yield_count is reset to 0 by recover_stale_jobs and claim_next_job.
ALTER TABLE acquisition_jobs
  ADD COLUMN IF NOT EXISTS yield_count int DEFAULT 0;

-- ---------------------------------------------------------------------------
-- _checkpoint_merge: internal helper used by both 0009 and 0011
-- ---------------------------------------------------------------------------
-- BYTE-IDENTICAL to the definition in 0009_fix_checkpoint_persistence.sql.
-- Must remain identical to ensure consistent append semantics for both
-- 'checkpoint' and 'batchCheckpoint' scopes.
CREATE OR REPLACE FUNCTION _checkpoint_merge(
  p_result_data jsonb, p_scope text, p_topic_id text
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  WITH parts AS (
    SELECT
      COALESCE(p_result_data, '{}'::jsonb)                AS rd,
      COALESCE(p_result_data #> ARRAY[p_scope], '{}'::jsonb) AS scope_obj,
      COALESCE(p_result_data #> ARRAY[p_scope, 'completedTopicIds'], '[]'::jsonb) AS ids,
      jsonb_typeof(p_result_data #> ARRAY[p_scope, 'completedTopicIds']) AS ids_type
  )
  SELECT jsonb_build_object(
    'result_data',
      parts.rd || jsonb_build_object(
        p_scope,
        CASE WHEN jsonb_typeof(parts.scope_obj) = 'object'
              THEN parts.scope_obj
              ELSE '{}'::jsonb
        END
        || jsonb_build_object(
             'completedTopicIds',
             CASE
               WHEN parts.ids_type = 'array'
                 AND parts.ids @> jsonb_build_array(p_topic_id)
                 THEN parts.ids                       -- already present: leave as-is
               WHEN parts.ids_type = 'array'
                 THEN parts.ids || to_jsonb(p_topic_id)
               ELSE jsonb_build_array(p_topic_id)      -- parent missing or malformed
             END
           )
      ),
    'changed',
      NOT (
        parts.ids_type = 'array'
        AND parts.ids @> jsonb_build_array(p_topic_id)
      )
  FROM parts;
$$;

REVOKE ALL ON FUNCTION _checkpoint_merge(jsonb, text, text) FROM PUBLIC;
-- The helper is only ever invoked from inside the SECURITY DEFINER functions
-- below (which execute as the owner), so no client role needs EXECUTE on it.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION _checkpoint_merge(jsonb, text, text) FROM %I', r);
    END IF;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- release_job_claim: explicit yield without consuming a retry count
-- ---------------------------------------------------------------------------
-- Yields the job back to 'pending' so the next cron invocation can claim it.
-- Does NOT increment retry_count. Does NOT change claim_version.
-- Increments yield_count atomically. Enforces a hard cap of 10 yields
-- PER CLAIM CYCLE (yield_count is reset on recovery/claim).
-- When cap is reached within a claim cycle:
--   - UPDATE affects 0 rows (WHERE yield_count < 10 fails)
--   - Function returns false
--   - Caller (worker) exits without completing; job remains 'running'
--   - Lease eventually expires; recover_stale_jobs reclaims the job
--   - yield_count is reset to 0 on recovery, allowing fresh yields
CREATE OR REPLACE FUNCTION release_job_claim(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE acquisition_jobs
  SET status = 'pending',
      claim_token = NULL,
      claim_expires_at = NULL,
      error = NULL,
      yield_count = yield_count + 1
  WHERE id = p_job_id
    AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running'
    AND yield_count < 10;  -- Hard cap: max 10 yields per claim cycle
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION release_job_claim(uuid, uuid, int) FROM PUBLIC;
-- REVOKE ... FROM PUBLIC does not remove EXPLICIT grants to individual roles
-- (Supabase's anon/authenticated). Without this, a browser client could call
-- this SECURITY DEFINER function and release a job it does not own
-- (SECURITY DEFINER runs as the owner and bypasses the table's RLS).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION release_job_claim(uuid, uuid, int) FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION release_job_claim(uuid, uuid, int) TO service_role;

-- ---------------------------------------------------------------------------
-- recover_stale_jobs: reclaim stale jobs and reset yield_count
-- ---------------------------------------------------------------------------
-- Reclaims jobs whose lease has expired. Resets yield_count = 0 so that
-- a recovered job gets a fresh yield budget for its new claim cycle.
-- This replaces the 0006 definition.
CREATE OR REPLACE FUNCTION recover_stale_jobs()
RETURNS SETOF acquisition_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job acquisition_jobs%ROWTYPE;
BEGIN
  FOR v_job IN
    UPDATE acquisition_jobs
    SET status = CASE
        WHEN retry_count < (budget_limits->>'max_retries')::int THEN 'pending'
        ELSE 'failed'
      END,
      claim_token = NULL,
      claim_expires_at = NULL,
      claim_version = claim_version + 1,
      error = 'recovered: lease expired',
      retry_count = CASE
        WHEN retry_count < (budget_limits->>'max_retries')::int THEN retry_count + 1
        ELSE retry_count
      END,
      yield_count = 0  -- Reset yield budget for new claim cycle
    WHERE status = 'running'
      AND claim_expires_at < now()
      AND claim_expires_at IS NOT NULL
    RETURNING *
  LOOP
    RETURN NEXT v_job;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION recover_stale_jobs() FROM PUBLIC;
-- REVOKE ... FROM PUBLIC does not remove EXPLICIT grants that were made to
-- individual roles (Supabase's anon/authenticated). Those grants must be
-- revoked explicitly, otherwise a browser client could call this
-- SECURITY DEFINER function and mutate acquisition_jobs rows directly
-- (SECURITY DEFINER runs as the owner and bypasses the table's RLS).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION recover_stale_jobs() FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION recover_stale_jobs() TO service_role;

-- ---------------------------------------------------------------------------
-- claim_next_job: claim next pending job and reset yield_count
-- ---------------------------------------------------------------------------
-- Claims the next pending job for processing. Resets yield_count = 0 so that
-- a newly claimed job gets a fresh yield budget for its new claim cycle.
-- This replaces the 0006 definition.
CREATE OR REPLACE FUNCTION claim_next_job(p_job_type text, p_curriculum_id uuid DEFAULT NULL)
RETURNS acquisition_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job acquisition_jobs%ROWTYPE;
BEGIN
  UPDATE acquisition_jobs
  SET status = 'running',
      claim_token = gen_random_uuid(),
      claim_version = 1,
      claim_expires_at = now() + interval '5 minutes',
      started_at = now(),
      yield_count = 0  -- Reset yield budget for new claim cycle
  WHERE id = (
    SELECT id FROM acquisition_jobs
    WHERE status = 'pending' AND job_type = p_job_type
      AND (p_curriculum_id IS NULL OR curriculum_id = p_curriculum_id)
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  )
  RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION claim_next_job(text, uuid) FROM PUBLIC;
-- REVOKE ... FROM PUBLIC does not remove EXPLICIT grants that were made to
-- individual roles (Supabase's anon/authenticated). Those grants must be
-- revoked explicitly, otherwise a browser client could call this
-- SECURITY DEFINER function and mutate acquisition_jobs rows directly
-- (SECURITY DEFINER runs as the owner and bypasses the table's RLS).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION claim_next_job(text, uuid) FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION claim_next_job(text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- advance_batch_checkpoint: separate durable progress for per-understanding
--   discovery (batch phase). Uses a distinct scope so it does not interfere
--   with the topic-level checkpoint maintained by advance_checkpoint.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION advance_batch_checkpoint(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_completed_topic_id uuid, p_resources_found int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_topic_id_str text := p_completed_topic_id::text;
  v_rows int;
BEGIN
  UPDATE acquisition_jobs
  SET result_data = _checkpoint_merge(result_data, 'batchCheckpoint', v_topic_id_str)->'result_data',
      checkpoint_version = checkpoint_version + CASE
        WHEN (_checkpoint_merge(result_data, 'batchCheckpoint', v_topic_id_str)->>'changed')::boolean
          THEN 1
        ELSE 0
      END
  WHERE id = p_job_id
    AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION advance_batch_checkpoint(uuid, uuid, int, uuid, int) FROM PUBLIC;
-- Same explicit-role revocation rationale as release_job_claim above.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION advance_batch_checkpoint(uuid, uuid, int, uuid, int) FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION advance_batch_checkpoint(uuid, uuid, int, uuid, int) TO service_role;

-- ---------------------------------------------------------------------------
-- save_job_sources: persist discovered sources so a resumed worker can skip
--   the source-discovery AI call instead of repeating it every invocation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_job_sources(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_sources jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE acquisition_jobs
  SET result_data = jsonb_set(
        COALESCE(result_data, '{}'::jsonb),
        '{discoveredSources}',
        COALESCE(p_sources, '[]'::jsonb)
      )
  WHERE id = p_job_id
    AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION save_job_sources(uuid, uuid, int, jsonb) FROM PUBLIC;
-- Same explicit-role revocation rationale as release_job_claim above.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION save_job_sources(uuid, uuid, int, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION save_job_sources(uuid, uuid, int, jsonb) TO service_role;