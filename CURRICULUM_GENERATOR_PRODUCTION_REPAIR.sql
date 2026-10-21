
-- =====================================================================
-- CURRICULUM GENERATOR: CONSOLIDATED PRODUCTION REPAIR
-- Built from the uploaded 0009, 0010, and 0011 migration sources plus
-- confirmed production schema observations supplied in this conversation.
--
-- IMPORTANT:
-- 1. This script has NOT been run against production.
-- 2. Run during a quiet window. It takes DDL locks and updates NULL yield_count
--    values if the column already exists from a partial application.
-- 3. The transaction makes DDL/data changes atomic if the SQL editor preserves
--    the explicit transaction. If any preflight assertion fails, stop.
-- 4. This does NOT reset/requeue any job, change retry_count, or replenish budgets.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Preflight: abort before changes if production differs from expectations.
-- ---------------------------------------------------------------------
DO $preflight$
BEGIN
  IF to_regclass('public.acquisition_jobs') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: public.acquisition_jobs is missing';
  END IF;
  IF to_regclass('public.resources') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: public.resources is missing';
  END IF;
  IF to_regclass('public.verification_records') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: public.verification_records is missing';
  END IF;
  IF to_regclass('public.resource_mappings') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: public.resource_mappings is missing';
  END IF;
  IF to_regclass('public.domain_scores') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: public.domain_scores is missing';
  END IF;

  IF to_regprocedure('public.persist_with_fence(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected persist_with_fence(uuid,uuid,jsonb) signature is missing';
  END IF;
  IF to_regprocedure('public.advance_checkpoint(uuid,uuid,integer,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected advance_checkpoint signature is missing';
  END IF;
  IF to_regprocedure('public.claim_next_job(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected claim_next_job(text,uuid) signature is missing';
  END IF;
  IF to_regprocedure('public.recover_stale_jobs()') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected recover_stale_jobs() signature is missing';
  END IF;
  IF to_regprocedure('public.complete_job(uuid,uuid,integer,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected complete_job signature is missing';
  END IF;
  IF to_regprocedure('public.fail_job(uuid,uuid,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected fail_job signature is missing';
  END IF;
  IF to_regprocedure('public.renew_lease(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected renew_lease(uuid,uuid) signature is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification_records'
      AND column_name = 'fetched_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: verification_records.fetched_at is not timestamptz';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification_records'
      AND column_name = 'verified_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: verification_records.verified_at is not timestamptz';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification_records'
      AND column_name = 'content_evidence' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: verification_records.content_evidence is not text';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification_records'
      AND column_name = 'notes' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: verification_records.notes is not text';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'verification_records'
      AND column_name = 'acquisition_job_id' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: verification_records.acquisition_job_id is not text';
  END IF;

  IF to_regclass('public.uq_resource_mu_target') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected unique index public.uq_resource_mu_target is missing';
  END IF;
  IF to_regclass('public.uq_resource_node_target') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected unique index public.uq_resource_node_target is missing';
  END IF;
  IF to_regclass('public.uq_vr_exact_retry') IS NULL THEN
    RAISE EXCEPTION 'Preflight failed: expected unique index public.uq_vr_exact_retry is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'Preflight failed: Supabase service_role is missing';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------
-- 1. Fix persist_with_fence:
--    timestamp parsing + JSON-to-text casts required by live column types.
-- ---------------------------------------------------------------------


CREATE OR REPLACE FUNCTION public.persist_with_fence(
  p_job_id uuid, p_claim_token uuid, p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.acquisition_jobs%ROWTYPE;
  v_resource_id uuid; v_vr_id uuid; v_mapping_id uuid;
  v_canonical_url text := p_input->'acquiredPage'->'canonicalUrl'->>'url';
  v_content_hash text := p_input->'acquiredPage'->>'contentHash';
  v_acquisition_job_id text := p_input->>'acquisitionJobId';
  v_target_node_id uuid := nullif(p_input->'target'->>'nodeId', '')::uuid;
  v_target_mu_id uuid := nullif(p_input->'target'->>'understandingId', '')::uuid;
  v_verification_status text := p_input->'verificationResult'->>'status';
  v_final_url text := p_input->'acquiredPage'->>'finalUrl';
  v_status_code int := (p_input->'acquiredPage'->>'statusCode')::int;
  -- FIX: Parse ISO text to timestamptz at declaration (single well-defined point).
  -- NULLIF guards against empty string -> NULL instead of cast error.
  -- Malformed ISO (e.g., 'not-a-date') -> PostgreSQL throws invalid input syntax ->
  -- function aborts -> caller treats as persistence failure (candidate skipped, safe).
  -- The application (acquisition engine http.ts) emits new Date().toISOString() -- guaranteed format.
  v_acquired_at timestamptz := NULLIF(p_input->'acquiredPage'->>'acquiredAt', '')::timestamptz;
  v_verified_at timestamptz := NULLIF(p_input->'verificationResult'->>'verifiedAt', '')::timestamptz;
  v_structured_title text := p_input->'structuredContent'->'metadata'->>'title';
  v_domain text := lower(regexp_replace(v_final_url, '^https?://([^/]+).*$', '\1'));
  v_domain_score int := COALESCE((SELECT score FROM public.domain_scores WHERE domain = v_domain), 2);
  v_license_status text := COALESCE(p_input->'callerMetadata'->>'licenseStatus', 'link_only');
  v_resource_type text := COALESCE(p_input->'callerMetadata'->>'resourceType', 'other');
  v_ai_note text := p_input->'callerMetadata'->>'aiNote';
  v_embed_allowed boolean := (v_license_status = 'cc_open' AND v_domain_score >= 4);
  v_structured_metadata jsonb := p_input->'structuredContent'->'metadata';
  v_educational_evidence jsonb := p_input->'educationalEvidence'->'interpreted';
  v_deterministic_checks jsonb := p_input->'verificationResult'->'deterministicChecks';
  v_advisory_signals jsonb := p_input->'verificationResult'->'advisorySignals';
  -- Auto-approval gate: verified + educational evidence present
  v_auto_approve boolean := (
    v_verification_status = 'verified' AND
    (v_advisory_signals->>'educationalEvidencePresent')::boolean = true
  );
BEGIN
  -- Atomic ownership + lease validation
  SELECT * INTO v_job
  FROM public.acquisition_jobs
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND status = 'running' AND claim_expires_at > now()
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  -- Exact-retry check (same job + same content hash).
  -- Uses the dedicated acquisition_job_id column (notes is text, not jsonb).
  IF p_input->>'acquisitionJobId' IS NOT NULL THEN
    SELECT vr.id, vr.resource_id INTO v_vr_id, v_resource_id
    FROM public.verification_records vr
    WHERE vr.acquisition_job_id = p_input->>'acquisitionJobId'
      AND vr.content_hash = (p_input->'acquiredPage'->>'contentHash')
    ORDER BY vr.created_at DESC LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('resource_id', v_resource_id, 'vr_id', v_vr_id, 'is_exact_retry', true); END IF;
  END IF;

  -- UPSERT resource (target-aware) with auto-approval
  IF (p_input->'target'->>'nodeId') IS NOT NULL THEN
    INSERT INTO public.resources (node_id, canonical_url, url, title, source_domain, resource_type, license_status, embed_allowed, content_type_verified, ai_note, status)
    VALUES (
      (p_input->'target'->>'nodeId')::uuid, v_canonical_url,
      (p_input->'acquiredPage'->>'finalUrl'),
      COALESCE(p_input->'structuredContent'->'metadata'->>'title', v_domain, 'Untitled Resource'),
      v_domain,
      COALESCE(p_input->'callerMetadata'->>'resourceType', 'other'),
      COALESCE(p_input->'callerMetadata'->>'licenseStatus', 'link_only'),
      v_embed_allowed,
      (v_verification_status = 'verified'),
      p_input->'callerMetadata'->>'aiNote',
      CASE WHEN v_auto_approve THEN 'approved' ELSE 'draft' END
    )
    ON CONFLICT (canonical_url, node_id) WHERE node_id IS NOT NULL
    DO UPDATE SET
      url = EXCLUDED.url,
      title = EXCLUDED.title,
      source_domain = EXCLUDED.source_domain,
      resource_type = EXCLUDED.resource_type,
      license_status = EXCLUDED.license_status,
      embed_allowed = EXCLUDED.embed_allowed,
      content_type_verified = EXCLUDED.content_type_verified,
      ai_note = EXCLUDED.ai_note,
      status = CASE WHEN v_auto_approve THEN 'approved' ELSE resources.status END
    RETURNING id INTO v_resource_id;
  ELSIF (p_input->'target'->>'understandingId') IS NOT NULL THEN
    INSERT INTO public.resources (major_understanding_id, canonical_url, url, title, source_domain, resource_type, license_status, embed_allowed, content_type_verified, ai_note, status)
    VALUES (
      (p_input->'target'->>'understandingId')::uuid, v_canonical_url,
      (p_input->'acquiredPage'->>'finalUrl'),
      COALESCE(p_input->'structuredContent'->'metadata'->>'title', v_domain, 'Untitled Resource'),
      v_domain,
      COALESCE(p_input->'callerMetadata'->>'resourceType', 'other'),
      COALESCE(p_input->'callerMetadata'->>'licenseStatus', 'link_only'),
      v_embed_allowed,
      (v_verification_status = 'verified'),
      p_input->'callerMetadata'->>'aiNote',
      CASE WHEN v_auto_approve THEN 'approved' ELSE 'draft' END
    )
    ON CONFLICT (canonical_url, major_understanding_id) WHERE major_understanding_id IS NOT NULL
    DO UPDATE SET
      url = EXCLUDED.url,
      title = EXCLUDED.title,
      source_domain = EXCLUDED.source_domain,
      resource_type = EXCLUDED.resource_type,
      license_status = EXCLUDED.license_status,
      embed_allowed = EXCLUDED.embed_allowed,
      content_type_verified = EXCLUDED.content_type_verified,
      ai_note = EXCLUDED.ai_note,
      status = CASE WHEN v_auto_approve THEN 'approved' ELSE resources.status END
    RETURNING id INTO v_resource_id;
  ELSE
    RETURN jsonb_build_object('error', 'invalid_target');
  END IF;

  -- INSERT verification_record (atomic exact-retry)
  -- v_acquired_at and v_verified_at are already timestamptz (no cast needed at INSERT)
  INSERT INTO public.verification_records (
    resource_id, url, canonical_url, content_hash, http_status,
    page_title, page_metadata, content_evidence, fetched_at, verified_at,
    verification_method, deterministic_checks, ai_verified,
    ai_verification_notes, human_reviewed, expires_at, status, notes,
    acquisition_job_id
  ) VALUES (
    v_resource_id,
    (p_input->'acquiredPage'->>'finalUrl'),
    v_canonical_url,
    v_content_hash,
    v_status_code,
    v_structured_title,
    jsonb_build_object(
      'description', p_input->'structuredContent'->'metadata'->>'description',
      'author', p_input->'structuredContent'->'metadata'->>'author',
      'date_published', p_input->'structuredContent'->'metadata'->>'datePublished',
      'language', p_input->'structuredContent'->'metadata'->>'language'
    ),
    jsonb_build_object(
      'interpreted', p_input->'educationalEvidence'->'interpreted'
    )::text,
    v_acquired_at,
    v_verified_at,
    'deterministic_v1',
    jsonb_build_object(
      'cleanedContentNonEmpty', (v_deterministic_checks->>'cleanedContentNonEmpty')::boolean,
      'titlePresent', (v_advisory_signals->>'titlePresent')::boolean,
      'educationalEvidencePresent', (v_advisory_signals->>'educationalEvidencePresent')::boolean,
      'wordCount', (v_advisory_signals->>'wordCount')::int,
      'headingCount', (v_advisory_signals->>'headingCount')::int,
      'paragraphCount', (v_advisory_signals->>'paragraphCount')::int
    ),
    false,
    null,
    false,
    null,
    v_verification_status,
    jsonb_build_object('acquisition_job_id', v_acquisition_job_id)::text,
    v_acquisition_job_id
  )
  ON CONFLICT (resource_id, acquisition_job_id, content_hash) WHERE acquisition_job_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_vr_id;

  -- If exact retry was caught earlier, v_vr_id is already set. Otherwise fetch it.
  IF v_vr_id IS NULL THEN
    SELECT id INTO v_vr_id
    FROM public.verification_records
    WHERE resource_id = v_resource_id
      AND acquisition_job_id = v_acquisition_job_id
      AND content_hash = v_content_hash
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  -- Create mapping if understanding target
  IF (p_input->'target'->>'understandingId') IS NOT NULL THEN
    INSERT INTO public.resource_mappings (resource_id, understanding_id, coverage_confidence)
    VALUES (v_resource_id, (p_input->'target'->>'understandingId')::uuid, 'medium')
    ON CONFLICT (resource_id, understanding_id) DO NOTHING
    RETURNING id INTO v_mapping_id;
  END IF;

  RETURN jsonb_build_object(
    'resource_id', v_resource_id,
    'vr_id', v_vr_id,
    'mapping_id', v_mapping_id,
    'is_exact_retry', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_with_fence(uuid, uuid, jsonb) FROM PUBLIC;
-- REVOKE ... FROM PUBLIC does not remove EXPLICIT grants that were made to
-- individual roles (Supabase's anon/authenticated). Those grants must be
-- revoked explicitly, otherwise a browser client could call this
-- SECURITY DEFINER function and mutate acquisition_jobs resources directly
-- (SECURITY DEFINER runs as the owner and bypasses table RLS).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.persist_with_fence(uuid, uuid, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.persist_with_fence(uuid, uuid, jsonb) TO service_role;


-- ---------------------------------------------------------------------
-- 2. Add the worker yield counter required by migration 0011.
-- ---------------------------------------------------------------------
ALTER TABLE public.acquisition_jobs
  ADD COLUMN IF NOT EXISTS yield_count integer DEFAULT 0;

UPDATE public.acquisition_jobs
SET yield_count = 0
WHERE yield_count IS NULL;

ALTER TABLE public.acquisition_jobs
  ALTER COLUMN yield_count SET DEFAULT 0;

-- ---------------------------------------------------------------------
-- 3. Durable, idempotent topic checkpoint (migration 0009).
-- ---------------------------------------------------------------------


CREATE OR REPLACE FUNCTION public._checkpoint_merge(
  p_result_data jsonb, p_scope text, p_topic_id text
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  WITH parts AS (
    SELECT
      COALESCE(p_result_data, '{}'::jsonb)                AS rd,
      COALESCE(p_result_data #> ARRAY[p_scope], '{}'::jsonb) AS scope_obj,
      COALESCE(p_result_data #> ARRAY[p_scope, 'completedTopicIds'], '[]'::jsonb) AS ids,
      jsonb_typeof(p_result_data #> ARRAY[p_scope, 'completedTopicIds'])         AS ids_type
  )
  SELECT jsonb_build_object(
    'result_data',
      parts.rd || jsonb_build_object(
        p_scope,
        (CASE WHEN jsonb_typeof(parts.scope_obj) = 'object'
              THEN parts.scope_obj
              ELSE '{}'::jsonb
         END)
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
  )
  FROM parts;
$$;

REVOKE ALL ON FUNCTION public._checkpoint_merge(jsonb, text, text) FROM PUBLIC;
-- The helper is only ever invoked from inside the SECURITY DEFINER functions
-- below (which execute as the owner), so no client role needs EXECUTE on it.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public._checkpoint_merge(jsonb, text, text) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_checkpoint(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_completed_topic_id uuid, p_resources_found int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_topic_id_str text := p_completed_topic_id::text;
  v_rows int;
BEGIN
  -- One atomic, fully fenced UPDATE.
  --   - The WHERE clause enforces claim_token + claim_version + status='running'.
  --     A stale worker therefore updates 0 rows and gets `false` back; it can
  --     never receive a misleading success.
  --   - The scope object is created by _checkpoint_merge, so completedTopicIds
  --     is always persisted alongside the version increment.
  --   - checkpoint_version only advances when the topic was actually added.
  UPDATE public.acquisition_jobs
  SET result_data = public._checkpoint_merge(result_data, 'checkpoint', v_topic_id_str)->'result_data',
      checkpoint_version = checkpoint_version + CASE
        WHEN (public._checkpoint_merge(result_data, 'checkpoint', v_topic_id_str)->>'changed')::boolean
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

REVOKE ALL ON FUNCTION public.advance_checkpoint(uuid, uuid, int, uuid, int) FROM PUBLIC;
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
        'REVOKE EXECUTE ON FUNCTION public.advance_checkpoint(uuid, uuid, int, uuid, int) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.advance_checkpoint(uuid, uuid, int, uuid, int) TO service_role;

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
CREATE OR REPLACE FUNCTION public.release_job_claim(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.acquisition_jobs
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

REVOKE ALL ON FUNCTION public.release_job_claim(uuid, uuid, int) FROM PUBLIC;
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
        'REVOKE EXECUTE ON FUNCTION public.release_job_claim(uuid, uuid, int) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.release_job_claim(uuid, uuid, int) TO service_role;

-- ---------------------------------------------------------------------------
-- recover_stale_jobs: reclaim stale jobs and reset yield_count
-- ---------------------------------------------------------------------------
-- Reclaims jobs whose lease has expired. Resets yield_count = 0 so that
-- a recovered job gets a fresh yield budget for its new claim cycle.
-- This replaces the 0006 definition.
CREATE OR REPLACE FUNCTION public.recover_stale_jobs()
RETURNS SETOF public.acquisition_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.acquisition_jobs%ROWTYPE;
BEGIN
  FOR v_job IN
    UPDATE public.acquisition_jobs
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

REVOKE ALL ON FUNCTION public.recover_stale_jobs() FROM PUBLIC;
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
        'REVOKE EXECUTE ON FUNCTION public.recover_stale_jobs() FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.recover_stale_jobs() TO service_role;

-- ---------------------------------------------------------------------------
-- claim_next_job: claim next pending job and reset yield_count
-- ---------------------------------------------------------------------------
-- Claims the next pending job for processing. Resets yield_count = 0 so that
-- a newly claimed job gets a fresh yield budget for its new claim cycle.
-- This replaces the 0006 definition.
CREATE OR REPLACE FUNCTION public.claim_next_job(p_job_type text, p_curriculum_id uuid DEFAULT NULL)
RETURNS public.acquisition_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.acquisition_jobs%ROWTYPE;
BEGIN
  UPDATE public.acquisition_jobs
  SET status = 'running',
      claim_token = gen_random_uuid(),
      claim_version = 1,
      claim_expires_at = now() + interval '5 minutes',
      started_at = now(),
      yield_count = 0  -- Reset yield budget for new claim cycle
  WHERE id = (
    SELECT id FROM public.acquisition_jobs
    WHERE status = 'pending' AND job_type = p_job_type
      AND (p_curriculum_id IS NULL OR curriculum_id = p_curriculum_id)
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  )
  RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_job(text, uuid) FROM PUBLIC;
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
        'REVOKE EXECUTE ON FUNCTION public.claim_next_job(text, uuid) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.claim_next_job(text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- advance_batch_checkpoint: separate durable progress for per-understanding
--   discovery (batch phase). Uses a distinct scope so it does not interfere
--   with the topic-level checkpoint maintained by advance_checkpoint.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_batch_checkpoint(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_completed_topic_id uuid, p_resources_found int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_topic_id_str text := p_completed_topic_id::text;
  v_rows int;
BEGIN
  UPDATE public.acquisition_jobs
  SET result_data = public._checkpoint_merge(result_data, 'batchCheckpoint', v_topic_id_str)->'result_data',
      checkpoint_version = checkpoint_version + CASE
        WHEN (public._checkpoint_merge(result_data, 'batchCheckpoint', v_topic_id_str)->>'changed')::boolean
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

REVOKE ALL ON FUNCTION public.advance_batch_checkpoint(uuid, uuid, int, uuid, int) FROM PUBLIC;
-- Same explicit-role revocation rationale as release_job_claim above.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.advance_batch_checkpoint(uuid, uuid, int, uuid, int) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.advance_batch_checkpoint(uuid, uuid, int, uuid, int) TO service_role;

-- ---------------------------------------------------------------------------
-- save_job_sources: persist discovered sources so a resumed worker can skip
--   the source-discovery AI call instead of repeating it every invocation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_job_sources(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_sources jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.acquisition_jobs
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

REVOKE ALL ON FUNCTION public.save_job_sources(uuid, uuid, int, jsonb) FROM PUBLIC;
-- Same explicit-role revocation rationale as release_job_claim above.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.save_job_sources(uuid, uuid, int, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_job_sources(uuid, uuid, int, jsonb) TO service_role;


-- ---------------------------------------------------------------------
-- 5. Explicitly lock down the audited job-management RPCs.
--    This removes direct PUBLIC/anon/authenticated grants and grants service_role.
--    Function owners and inherited role memberships can still have privileges;
--    this block does not attempt to rewrite ownership or role memberships.
-- ---------------------------------------------------------------------
DO $permissions$
DECLARE
  sig text;
  signatures text[] := ARRAY[
    'public.persist_with_fence(uuid,uuid,jsonb)',
    'public.advance_checkpoint(uuid,uuid,integer,uuid,integer)',
    'public.advance_batch_checkpoint(uuid,uuid,integer,uuid,integer)',
    'public.release_job_claim(uuid,uuid,integer)',
    'public.save_job_sources(uuid,uuid,integer,jsonb)',
    'public.claim_next_job(text,uuid)',
    'public.recover_stale_jobs()',
    'public.complete_job(uuid,uuid,integer,boolean)',
    'public.fail_job(uuid,uuid,integer,text)',
    'public.renew_lease(uuid,uuid)'
  ];
BEGIN
  FOREACH sig IN ARRAY signatures LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE EXCEPTION 'Permission repair aborted: expected function signature % is missing', sig;
    END IF;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', sig);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', sig);
    END IF;

    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;

  -- Internal helper: callable only from its owning SECURITY DEFINER functions.
  REVOKE ALL ON FUNCTION public._checkpoint_merge(jsonb,text,text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public._checkpoint_merge(jsonb,text,text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public._checkpoint_merge(jsonb,text,text) FROM authenticated;
  END IF;
END;
$permissions$;

-- ---------------------------------------------------------------------
-- 6. Post-repair sanity checks (read-only).
-- ---------------------------------------------------------------------
DO $postcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'acquisition_jobs'
      AND column_name = 'yield_count'
  ) THEN
    RAISE EXCEPTION 'Post-check failed: acquisition_jobs.yield_count is missing';
  END IF;
  IF to_regprocedure('public.release_job_claim(uuid,uuid,integer)') IS NULL
     OR to_regprocedure('public.save_job_sources(uuid,uuid,integer,jsonb)') IS NULL
     OR to_regprocedure('public.advance_batch_checkpoint(uuid,uuid,integer,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: one or more 0011 worker functions are missing';
  END IF;
END;
$postcheck$;

COMMIT;

-- After COMMIT, inspect the function definitions/ACLs and test via the application.
-- This script intentionally does not requeue the exhausted production job.
