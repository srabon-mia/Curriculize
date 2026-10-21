-- ========================================================================
-- PRODUCTION_REPAIR_REVIEW.sql
-- Read-only review artifact for production repair of curriculum-generator
-- Generated from local source inspection (no production access)
-- Sections:
--   1. persist_with_fence: minimal corrections (timestamps + content_evidence + notes casts)
--   2. Missing schema: yield_count column (idempotent, NOT NULL)
--   3. Missing/updated RPCs: _checkpoint_merge, advance_checkpoint, advance_batch_checkpoint,
--      release_job_claim, save_job_sources, recover_stale_jobs, claim_next_job
--   4. Permissions: revokes/grants for audited service-role-only RPCs
--   5. Preflight checks (safe, repeatable, run against CURRENT production schema)
--   6. Post-repair verification queries (read-only)
-- ========================================================================
-- SOURCE TRACEABILITY:
--   Live persist_with_fence: migrations 0007/0008 (auto-approval) + 0010 (timestamp fix)
--   Schema verification_records (0003:L58, L68): content_evidence=text, notes=text
--   0006: correct ::text casts for content_evidence/notes; 0007/0008/0010 introduced jsonb→text mismatches
--   0009: _checkpoint_merge + advance_checkpoint fix
--   0011: yield_count, release_job_claim, advance_batch_checkpoint, save_job_sources, recover_stale_jobs, claim_next_job
--   TypeScript callers: jobService.ts, route.ts (all via SUPABASE_SERVICE_ROLE_KEY)
-- ========================================================================
-- VERIFICATION STATUS:
--   Local migration files read in full. No production connection made.
--   Production function inventory unknown — preflight Section 5 must run first.
--   Grants/ACLs not independently verified in production.
--   CONFIRMED IN PRODUCTION (do not re-verify):
--     [x] uq_resource_node_target, uq_resource_mu_target, uq_vr_exact_retry indexes exist
--     [x] resources_status_check constraint allows 'approved'
--     [x] reserve_ai_call signature: (uuid, uuid, int, int, uuid)
--     [x] create_curriculum_and_job signature: (text, jsonb, jsonb, uuid)
--     [x] advance_checkpoint is 0006 buggy version (needs 0009 fix)
--     [x] claim_next_job is 0006 version (needs 0011 yield_count fix)
--     [x] recover_stale_jobs is 0006 version (needs 0011 yield_count fix)
--   UNVERIFIED:
--     [ ] Exact byte-for-byte match of live persist_with_fence vs. 0010 definition
-- ========================================================================


-- ========================================================================
-- SECTION 1: persist_with_fence — MINIMAL CORRECTIONS
-- ========================================================================
-- Base: live production function = 0010 definition (auto-approval from 0007/0008 + timestamp fix).
-- Changes from live 0010:
--   (a) v_acquired_at / v_verified_at: already timestamptz in 0010 (keep)
--   (b) content_evidence: 0010 passes jsonb; schema is text → add ::text cast
--   (c) notes: 0010 passes jsonb; schema is text → add ::text cast
-- All other logic (lease validation, exact-retry, target-aware upsert, auto-approval,
-- verification_record insertion, resource mappings) preserved exactly.
-- NOTE: persist_with_fence does NOT accept p_expected_claim_version; it validates
-- claim_token + claim_expires_at + status='running' only.
-- ========================================================================
-- DIFF vs 0010_fix_persist_with_fence_timestamps.sql (only these two lines differ):
--   0010 line 144-145: jsonb_build_object('interpreted', p_input->'educationalEvidence'->'interpreted')
--   REVIEW line 180:   (p_input->'educationalEvidence'->'interpreted')::text
--   0010 line 163:     jsonb_build_object('acquisition_job_id', v_acquisition_job_id)
--   REVIEW line 198:   jsonb_build_object('acquisition_job_id', v_acquisition_job_id)::text
-- ========================================================================
-- LINE-BY-LINE VERIFICATION vs 0007/0008/0010:
--   - Lease validation (FOR NO KEY UPDATE): matches 0007/0008/0010
--   - Exact-retry check: matches 0007/0008/0010
--   - Node-target upsert with auto-approval: matches 0007/0008/0010
--   - MU-target upsert with auto-approval: matches 0007/0008/0010
--   - verification_record INSERT: matches 0007/0008/0010 EXCEPT content_evidence/notes casts
--   - content_evidence: 0006 used ::text; 0007/0008/0010 used jsonb_build_object → FIXED to ::text
--   - notes: 0006 used ::text; 0007/0008/0010 used jsonb_build_object → FIXED to ::text
--   - fetched_at/verified_at: 0010 timestamptz with NULLIF → KEPT
--   - v_auto_approve logic: 0007/0008/0010 → KEPT
--   - resource_mappings INSERT: matches 0007/0008/0010
--   - Return value: matches 0007/0008/0010
--   - SECURITY DEFINER, search_path = public: matches 0007/0008/0010
-- BEHAVIOR NOT PROVABLE EQUIVALENT WITHOUT PRODUCTION MATCH:
--   - Exact byte-for-byte equality of live function body vs 0010
--   - Whether any whitespace/comment differences exist
-- ========================================================================

CREATE OR REPLACE FUNCTION public.persist_with_fence(
  p_job_id uuid, p_claim_token uuid, p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job acquisition_jobs%ROWTYPE;
  v_resource_id uuid; v_vr_id uuid; v_mapping_id uuid;
  v_canonical_url text := p_input->'acquiredPage'->'canonicalUrl'->>'url';
  v_content_hash text := p_input->'acquiredPage'->>'contentHash';
  v_acquisition_job_id text := p_input->>'acquisitionJobId';
  v_target_node_id uuid := nullif(p_input->'target'->>'nodeId', '')::uuid;
  v_target_mu_id uuid := nullif(p_input->'target'->>'understandingId', '')::uuid;
  v_verification_status text := p_input->'verificationResult'->>'status';
  v_final_url text := p_input->'acquiredPage'->>'finalUrl';
  v_status_code int := (p_input->'acquiredPage'->>'statusCode')::int;
  -- Timestamp fix from 0010 (already timestamptz in live production):
  v_acquired_at timestamptz := NULLIF(p_input->'acquiredPage'->>'acquiredAt', '')::timestamptz;
  v_verified_at timestamptz := NULLIF(p_input->'verificationResult'->>'verifiedAt', '')::timestamptz;
  v_structured_title text := p_input->'structuredContent'->'metadata'->>'title';
  v_domain text := lower(regexp_replace(v_final_url, '^https?://([^/]+).*$', '\1'));
  v_domain_score int := COALESCE((SELECT score FROM domain_scores WHERE domain = v_domain), 2);
  v_license_status text := COALESCE(p_input->'callerMetadata'->>'licenseStatus', 'link_only');
  v_resource_type text := COALESCE(p_input->'callerMetadata'->>'resourceType', 'other');
  v_ai_note text := p_input->'callerMetadata'->>'aiNote';
  v_embed_allowed boolean := (v_license_status = 'cc_open' AND v_domain_score >= 4);
  v_structured_metadata jsonb := p_input->'structuredContent'->'metadata';
  v_educational_evidence jsonb := p_input->'educationalEvidence'->'interpreted';
  v_deterministic_checks jsonb := p_input->'verificationResult'->'deterministicChecks';
  v_advisory_signals jsonb := p_input->'verificationResult'->>'advisorySignals';
  -- Auto-approval gate (from 0007/0008):
  v_auto_approve boolean := (
    v_verification_status = 'verified' AND
    (v_advisory_signals->>'educationalEvidencePresent')::boolean = true
  );
BEGIN
  -- Atomic ownership + lease validation
  SELECT * INTO v_job
  FROM acquisition_jobs
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND status = 'running' AND claim_expires_at > now()
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  -- Exact-retry check (same job + same content hash).
  -- Uses dedicated acquisition_job_id column (notes is text, not jsonb).
  IF p_input->>'acquisitionJobId' IS NOT NULL THEN
    SELECT vr.id, vr.resource_id INTO v_vr_id, v_resource_id
    FROM verification_records vr
    WHERE vr.acquisition_job_id = p_input->>'acquisitionJobId'
      AND vr.content_hash = (p_input->'acquiredPage'->>'contentHash')
    ORDER BY vr.created_at DESC LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('resource_id', v_resource_id, 'vr_id', v_vr_id, 'is_exact_retry', true); END IF;
  END IF;

  -- UPSERT resource (target-aware) with auto-approval
  IF (p_input->'target'->>'nodeId') IS NOT NULL THEN
    INSERT INTO resources (node_id, canonical_url, url, title, source_domain, resource_type, license_status, embed_allowed, content_type_verified, ai_note, status)
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
    INSERT INTO resources (major_understanding_id, canonical_url, url, title, source_domain, resource_type, license_status, embed_allowed, content_type_verified, ai_note, status)
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
  -- FIX: content_evidence (text column) ← cast jsonb to text
  -- FIX: notes (text column) ← cast jsonb to text
  INSERT INTO verification_records (
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
    -- content_evidence is TEXT in schema (0003:L58) → cast to text
    (p_input->'educationalEvidence'->'interpreted')::text,
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
    -- notes is TEXT in schema (0003:L68) → cast to text
    jsonb_build_object('acquisition_job_id', v_acquisition_job_id)::text,
    v_acquisition_job_id
  )
  ON CONFLICT (resource_id, acquisition_job_id, content_hash) WHERE acquisition_job_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_vr_id;

  -- If exact retry was caught earlier, v_vr_id is already set. Otherwise fetch it.
  IF v_vr_id IS NULL THEN
    SELECT id INTO v_vr_id
    FROM verification_records
    WHERE resource_id = v_resource_id
      AND acquisition_job_id = v_acquisition_job_id
      AND content_hash = v_content_hash
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  -- Create mapping if understanding target
  IF (p_input->'target'->>'understandingId') IS NOT NULL THEN
    INSERT INTO resource_mappings (resource_id, understanding_id, coverage_confidence)
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


-- ========================================================================
-- SECTION 2: SCHEMA — yield_count COLUMN (IDEMPOTENT, NOT NULL)
-- ========================================================================
-- Required by release_job_claim (0011). Safe to run repeatedly.
-- Sequence: add column if absent → backfill NULLs → set default 0 → set NOT NULL.
-- MUST be applied BEFORE Section 3 functions that reference yield_count.
-- ========================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'acquisition_jobs' AND column_name = 'yield_count'
  ) THEN
    ALTER TABLE public.acquisition_jobs ADD COLUMN yield_count int;
  END IF;
END;
$$;

UPDATE public.acquisition_jobs SET yield_count = 0 WHERE yield_count IS NULL;

ALTER TABLE public.acquisition_jobs ALTER COLUMN yield_count SET DEFAULT 0;

ALTER TABLE public.acquisition_jobs ALTER COLUMN yield_count SET NOT NULL;


-- ========================================================================
-- SECTION 3: MISSING/UPDATED RPCs
-- ========================================================================
-- PREREQUISITES (must be satisfied before applying):
--   [ ] Section 2 (yield_count NOT NULL) exists
--   [ ] Section 5.6 confirms uq_resource_node_target, uq_resource_mu_target, uq_vr_exact_retry indexes exist
--   [ ] Section 5.7 confirms resources_status_check constraint allows 'approved'
-- EXECUTION ORDER (do not reorder):
--   1. Section 2 (yield_count)
--   2. _checkpoint_merge (single authoritative definition)
--   3. advance_checkpoint (0009 fix)
--   4. advance_batch_checkpoint (0011)
--   5. release_job_claim (0011)
--   6. save_job_sources (0011)
--   7. recover_stale_jobs (0011 yield_count reset)
--   8. claim_next_job (0011 yield_count reset)
--   9. Section 4 permissions (after all functions exist)
-- ========================================================================

-- ---------------------------------------------------------------------------
-- _checkpoint_merge (IMMUTABLE helper) — SINGLE AUTHORITATIVE DEFINITION
-- Source: 0009_fix_checkpoint_persistence.sql (authoritative for advance_checkpoint)
-- 0011 redefines with IDENTICAL body — keep one definition here.
-- Fixes applied vs local 0009:
--   - CTE column named 'ids' (not 'ids_') with consistent 'parts.ids' references
--   - Outer jsonb_build_object properly closed before FROM parts
--   - Return format: {"result_data": {...}, "changed": boolean}
--   - Malformed scope (non-object) normalized to {}; missing completedTopicIds normalized to []
--   - Unrelated result_data keys preserved via top-level '||' merge
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._checkpoint_merge(
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

-- advance_checkpoint: durable, fenced, idempotent topic checkpoint
-- Signature: (uuid, uuid, int, uuid, int) → boolean
-- Matches TypeScript: advanceCheckpoint(jobId, claimToken, expectedClaimVersion, completedTopicId, resourcesFound)
-- Replaces 0006 buggy version with 0009 fix (uses _checkpoint_merge helper)

CREATE OR REPLACE FUNCTION public.advance_checkpoint(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_completed_topic_id uuid, p_resources_found int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_topic_id_str text := p_completed_topic_id::text;
  v_rows int;
BEGIN
  UPDATE acquisition_jobs
  SET result_data = _checkpoint_merge(result_data, 'checkpoint', v_topic_id_str)->'result_data',
      checkpoint_version = checkpoint_version + CASE
        WHEN (_checkpoint_merge(result_data, 'checkpoint', v_topic_id_str)->>'changed')::boolean
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


-- ---------------------------------------------------------------------------
-- Migration 0011 functions: advance_batch_checkpoint, release_job_claim,
-- save_job_sources, recover_stale_jobs, claim_next_job
-- Source: 0011_worker_yield_and_batch_checkpoint.sql
-- ---------------------------------------------------------------------------

-- advance_batch_checkpoint: batch-phase checkpoint (scope 'batchCheckpoint')
-- Requires _checkpoint_merge. Signature: (uuid, uuid, int, uuid, int) → boolean
-- Matches TypeScript: advanceBatchCheckpoint(jobId, claimToken, expectedClaimVersion, completedTopicId, resourcesFound)

CREATE OR REPLACE FUNCTION public.advance_batch_checkpoint(
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

-- release_job_claim: yield a running job without consuming a retry
-- Requires yield_count column (Section 2, NOT NULL). Signature: (uuid, uuid, int) → boolean
-- Matches TypeScript: releaseJobClaim(jobId, claimToken, expectedClaimVersion)
-- NULL yield_count cannot bypass limit because column is NOT NULL with default 0.

CREATE OR REPLACE FUNCTION public.release_job_claim(
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

-- save_job_sources: persist discovered sources for resume
-- Signature: (uuid, uuid, int, jsonb) → boolean
-- Matches TypeScript: saveJobSources(jobId, claimToken, expectedClaimVersion, sources)

CREATE OR REPLACE FUNCTION public.save_job_sources(
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

-- recover_stale_jobs: reclaim stale jobs, reset yield_count = 0
-- Replaces 0006 definition. Signature: () → SETOF acquisition_jobs
-- Matches TypeScript: recoverStaleJobs()

CREATE OR REPLACE FUNCTION public.recover_stale_jobs()
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

-- claim_next_job: claim next pending job, reset yield_count = 0
-- Replaces 0006 definition. Signature: (text, uuid) → acquisition_jobs
-- Matches TypeScript: claimNextJob(jobType, curriculumId)

CREATE OR REPLACE FUNCTION public.claim_next_job(p_job_type text, p_curriculum_id uuid DEFAULT NULL)
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


-- ========================================================================
-- SECTION 4: PERMISSIONS — EXPLICIT REVOKES + GRANTS FOR SERVICE_ROLE ONLY
-- ========================================================================
-- All audited RPCs are SECURITY DEFINER and called exclusively via service-role client.
-- Revokes use bare function names (no schema prefix) matching migration pattern.
-- Function signatures are type-only (no argument names) as required by PostgreSQL GRANT/REVOKE.
-- Explicit REVOKE from anon/authenticated required because REVOKE FROM PUBLIC
-- does not remove explicit grants to those roles.
-- APPLY AFTER all Section 3 functions exist.
-- ========================================================================
-- NOTE: _checkpoint_merge is INTERNAL helper — excluded from service_role grant list.
--       It is only invoked from within SECURITY DEFINER functions above.
-- ========================================================================

-- Helper: revoke from PUBLIC, anon, authenticated, then grant to service_role
DO $$
DECLARE
  r text;
  sig text;
  func_sigs text[] := ARRAY[
    'persist_with_fence(uuid, uuid, jsonb)',
    'advance_checkpoint(uuid, uuid, int, uuid, int)',
    'advance_batch_checkpoint(uuid, uuid, int, uuid, int)',
    'release_job_claim(uuid, uuid, int)',
    'save_job_sources(uuid, uuid, int, jsonb)',
    'claim_next_job(text, uuid)',
    'recover_stale_jobs()',
    'complete_job(uuid, uuid, int, boolean)',
    'fail_job(uuid, uuid, int, text)',
    'renew_lease(uuid, uuid)'
  ];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH sig IN ARRAY func_sigs LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', sig, r);
      END LOOP;
    END IF;
  END LOOP;

  -- Revoke from PUBLIC (covers any other roles)
  FOREACH sig IN ARRAY func_sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
  END LOOP;

  -- Grant to service_role (excludes _checkpoint_merge)
  FOREACH sig IN ARRAY func_sigs LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END;
$$;

-- Internal helper: _checkpoint_merge — NO GRANT to service_role
REVOKE ALL ON FUNCTION public._checkpoint_merge(jsonb, text, text) FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public._checkpoint_merge(jsonb, text, text) FROM %I', r);
    END IF;
  END LOOP;
END$$;
-- No GRANT to service_role


-- ========================================================================
-- SECTION 5: PREFLIGHT CHECKS (SAFE, REPEATABLE, RUN AGAINST CURRENT PRODUCTION)
-- ========================================================================
-- Run BEFORE any repair. These queries reference ONLY columns/objects that
-- exist in the base 0006 schema (no yield_count, no 0009/0011 RPCs).
-- Do not modify data. Safe to run repeatedly.
-- ========================================================================

-- 5.1 Migration ledger discovery (no assumptions)
SELECT table_name, table_schema
FROM information_schema.tables
WHERE table_schema IN ('public', 'supabase_migrations', 'migrations')
  AND table_name ILIKE '%migration%';

-- If ledger found: SELECT * FROM <schema>.<table> ORDER BY version/name/created_at;

-- 5.2 Current function inventory (exact signatures from catalog)
-- Includes all known RPCs; missing ones will simply not appear.
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS signature,
  pg_get_function_result(p.oid) AS return_type,
  p.prosecdef AS security_definer,
  p.provolatile
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'persist_with_fence',
    '_checkpoint_merge',
    'advance_checkpoint',
    'advance_batch_checkpoint',
    'release_job_claim',
    'save_job_sources',
    'claim_next_job',
    'recover_stale_jobs',
    'complete_job',
    'fail_job',
    'renew_lease',
    'reserve_ai_call',
    'create_curriculum_and_job'
  )
ORDER BY p.proname;

-- 5.3 Current ACLs — expands default ACLs via acldefault(), shows grantee 0 as PUBLIC
-- Note: grant_origin='default' means the privilege comes from acldefault() for the function's owner,
-- not that it was explicitly granted to PUBLIC. Explicit grants to PUBLIC would also show grantee=PUBLIC.
SELECT
  p.proname,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  a.privilege_type,
  CASE
    WHEN a.grantee = 0 AND p.proacl IS NULL THEN 'default_acl'
    WHEN a.grantee = 0 AND p.proacl IS NOT NULL THEN 'explicit_to_public'
    ELSE 'explicit'
  END AS grant_origin
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
WHERE n.nspname = 'public'
  AND p.proname IN (
    'persist_with_fence',
    '_checkpoint_merge',
    'advance_checkpoint',
    'advance_batch_checkpoint',
    'release_job_claim',
    'save_job_sources',
    'claim_next_job',
    'recover_stale_jobs',
    'complete_job',
    'fail_job',
    'renew_lease',
    'reserve_ai_call',
    'create_curriculum_and_job'
  )
ORDER BY p.proname, grantee;

-- 5.4 verification_records column types (confirm content_evidence=text, notes=text)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'verification_records'
  AND column_name IN ('content_evidence', 'notes', 'fetched_at', 'verified_at', 'acquisition_job_id');

-- 5.5 Pre-repair job state (curriculum-generation) — NO yield_count reference
SELECT
  id, curriculum_id, status, claim_token, claim_version, claim_expires_at,
  retry_count, checkpoint_version, budget_version,
  result_data->'checkpoint'->'completedTopicIds' AS topic_checkpoint,
  result_data->'batchCheckpoint'->'completedTopicIds' AS batch_checkpoint,
  result_data->>'aiCallsUsed' AS ai_calls_used,
  result_data->'discoveredSources' AS discovered_sources,
  error, created_at, started_at, completed_at
FROM acquisition_jobs
WHERE job_type = 'curriculum_generation'
  AND status IN ('running', 'pending', 'failed')
ORDER BY created_at DESC LIMIT 10;

-- 5.6 Required unique/partial indexes for persist_with_fence ON CONFLICT clauses
-- CONFIRMED IN PRODUCTION: all three indexes exist.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'uq_resource_node_target',
    'uq_resource_mu_target',
    'uq_vr_exact_retry'
  );

-- 5.7 resources.status constraint verification
-- CONFIRMED IN PRODUCTION: constraint allows 'approved'.
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.resources'::regclass
  AND contype = 'c'
  AND conname = 'resources_status_check';


-- ========================================================================
-- SECTION 6: POST-REPAIR VERIFICATION (READ-ONLY)
-- ========================================================================
-- Run AFTER applying repairs to confirm postconditions.
-- ========================================================================

-- 6.1 Verify persist_with_fence timestamp declarations
SELECT pg_get_functiondef(oid) AS definition
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'persist_with_fence';

-- 6.2 Verify content_evidence and notes casts in persist_with_fence
-- (Inspect definition for ::text casts on those VALUES expressions)

-- 6.3 Verify all RPC signatures match expected
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS signature,
  pg_get_function_result(p.oid) AS return_type
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'persist_with_fence',
    '_checkpoint_merge',
    'advance_checkpoint',
    'advance_batch_checkpoint',
    'release_job_claim',
    'save_job_sources',
    'claim_next_job',
    'recover_stale_jobs',
    'complete_job',
    'fail_job',
    'renew_lease',
    'reserve_ai_call',
    'create_curriculum_and_job'
  )
ORDER BY p.proname;

-- 6.4 Verify _checkpoint_merge is IMMUTABLE
SELECT proname, provolatile FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_checkpoint_merge';

-- 6.5 Verify yield_count column: NOT NULL, default 0
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'acquisition_jobs' AND column_name = 'yield_count';

-- 6.6 Post-repair job state (includes yield_count)
SELECT
  id, curriculum_id, status, claim_token, claim_version, claim_expires_at,
  retry_count, yield_count, checkpoint_version, budget_version,
  result_data->'checkpoint'->'completedTopicIds' AS topic_checkpoint,
  result_data->'batchCheckpoint'->'completedTopicIds' AS batch_checkpoint,
  result_data->>'aiCallsUsed' AS ai_calls_used,
  result_data->'discoveredSources' AS discovered_sources,
  error, created_at, started_at, completed_at
FROM acquisition_jobs
WHERE job_type = 'curriculum_generation'
  AND status IN ('running', 'pending', 'failed')
ORDER BY created_at DESC LIMIT 10;

-- 6.7 Verify recover_stale_jobs and claim_next_job reset yield_count = 0
SELECT proname, pg_get_functiondef(oid) AS definition
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('recover_stale_jobs', 'claim_next_job');

-- 6.8 Verify grants: only service_role has EXECUTE on audited RPCs (expands defaults)
SELECT
  p.proname,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  a.privilege_type,
  CASE
    WHEN a.grantee = 0 AND p.proacl IS NULL THEN 'default_acl'
    WHEN a.grantee = 0 AND p.proacl IS NOT NULL THEN 'explicit_to_public'
    ELSE 'explicit'
  END AS grant_origin
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
WHERE n.nspname = 'public'
  AND p.proname IN (
    'persist_with_fence', '_checkpoint_merge', 'advance_checkpoint',
    'advance_batch_checkpoint', 'release_job_claim', 'save_job_sources',
    'claim_next_job', 'recover_stale_jobs', 'complete_job', 'fail_job',
    'renew_lease', 'reserve_ai_call', 'create_curriculum_and_job'
  )
ORDER BY p.proname, grantee;

-- 6.9 Verify unique/partial indexes still exist post-repair
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'uq_resource_node_target',
    'uq_resource_mu_target',
    'uq_vr_exact_retry'
  );

-- 6.10 Verify resources.status constraint still includes 'approved'
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.resources'::regclass
  AND contype = 'c'
  AND conname = 'resources_status_check';


-- ========================================================================
-- CLAIM_VERSION FENCING GUARANTEES (DOCUMENTATION)
-- ========================================================================
-- claim_version semantics (from migrations 0006/0011):
--   - claim_next_job: sets claim_version = 1 (fresh claim cycle)
--   - renew_lease:    does NOT change claim_version (heartbeat only)
--   - recover_stale_jobs: increments claim_version by 1 (new cycle after expiry)
--   - release_job_claim: does NOT change claim_version (yield within same cycle)
--   - advance_checkpoint, advance_batch_checkpoint, save_job_sources, complete_job,
--     fail_job: validate p_expected_claim_version in WHERE clause
--   - persist_with_fence: validates claim_token + claim_expires_at + status='running'
--     (does NOT accept p_expected_claim_version)
-- Monotonicity: claim_version increases ONLY on recovery (recover_stale_jobs).
-- It resets to 1 on fresh claim. This is intentional.
--
-- Remaining risk: If a worker holds a valid claim but the lease expires
-- between RPC calls, the next RPC will return false (ownership lost).
-- The worker must check return values and stop (implemented in route.ts/worker.ts).
-- No RPC silently changes claim_version except recover_stale_jobs.
-- ========================================================================


-- ========================================================================
-- UNVERIFIED PREREQUISITES — MUST CONFIRM IN PRODUCTION BEFORE APPLYING
-- ========================================================================
-- [ ] Exact byte-for-byte match of live persist_with_fence vs. 0010 definition
-- [ ] Production function inventory matches preflight expectations (Section 5.2)
--
-- DO NOT APPLY ANY REPAIR UNTIL SECTION 5 PREFLIGHT CONFIRMS GAPS.
-- ========================================================================
-- END OF PRODUCTION_REPAIR_REVIEW.sql
-- ========================================================================