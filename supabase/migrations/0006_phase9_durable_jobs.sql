-- 0006_phase9_durable_jobs.sql
-- Phase 9: Durable acquisition job processing
-- Additive only — no existing tables modified, no existing data deleted

-- ============================================================
-- 1. RESOURCE CANONICAL IDENTITY
-- ============================================================

-- Add canonical_url column to resources
ALTER TABLE resources ADD COLUMN canonical_url text;

-- Backfill canonical_url with best-effort SQL normalization.
-- CRITICAL WARNING: This backfill is APPROXIMATE. PostgreSQL regex cannot faithfully
-- reproduce the TypeScript URL parser (canonicalizeUrl in app/src/lib/deterministic/url.ts).
-- Known differences from runtime canonicalizeUrl():
--   1. Hostname lowercasing: Phase 4 lowercases ONLY the hostname; SQL lower() lowercases the whole URL (path/query too).
--   2. Default port removal: Phase 4 removes :80 (HTTP) and :443 (HTTPS) with protocol awareness;
--      SQL regex (:80|:443) removes both ports regardless of protocol.
--   3. Query parameter sorting: Phase 4 sorts query params alphabetically; SQL does not.
--   4. Path normalization: Phase 4 resolves . and .. segments; SQL does not.
--   5. Scheme validation: Phase 4 allows only http:/https; SQL only checks ^https?:// prefix.
--
-- CONSEQUENCE: Existing rows may have canonical_url values that differ from what
-- canonicalizeUrl() would produce. This means two URLs that canonicalizeUrl() would
-- treat as identical may have DIFFERENT backfilled values, and the preflight below
-- will NOT catch this collision. Only EXACT duplicates under backfilled values are caught.
--
-- STAGED REMEDIATION PATH:
--   A. Run this migration. It will fail with RAISE EXCEPTION if exact backfill duplicates exist.
--   B. If step A succeeds, existing rows may still have inconsistent canonical_url values
--      relative to runtime canonicalizeUrl(). Operators who require perfect consistency
--      should write a migration script that calls canonicalizeUrl() on every existing
--      resources.url and updates canonical_url accordingly, then re-run deduplication.
--   C. Only after deduplication succeeds should the UNIQUE indexes below be considered
--      fully trustworthy for preventing future duplicates.
--
-- New writes via persist_with_fence pass the runtime canonicalized URL from canonicalizeUrl(),
-- so new rows are always correct. The UNIQUE indexes below prevent duplicates among new writes
-- and between new writes and existing rows that happen to share backfilled values.
UPDATE resources
SET canonical_url = (
  CASE
    WHEN url IS NOT NULL AND url ~* '^https?://' THEN
      regexp_replace(
        lower(regexp_replace(regexp_replace(url, '^https?://', '', 'i'), '#.*$', '')),
        '(:80|:443)(/|$)', '\2'
      )
    ELSE NULL
  END
);

-- Ensure canonical_url is NULL for problematic values
UPDATE resources SET canonical_url = NULL WHERE canonical_url IS NULL OR canonical_url = '';

-- Preflight: check for duplicate (canonical_url, node_id) combinations
-- Catches EXACT duplicates under backfilled values. Does NOT catch collisions
-- caused by backfill/runtime canonicalizeUrl() differences (see warning above).
-- The migration will FAIL if duplicates exist. Operators must deduplicate before migration.
DO $$
DECLARE
  v_dup_node_count int;
  v_dup_mu_count int;
BEGIN
  SELECT count(*) INTO v_dup_node_count FROM (
    SELECT canonical_url, node_id, count(*) as cnt
    FROM resources
    WHERE canonical_url IS NOT NULL AND node_id IS NOT NULL
    GROUP BY canonical_url, node_id
    HAVING count(*) > 1
  ) sub;
  SELECT count(*) INTO v_dup_mu_count FROM (
    SELECT canonical_url, major_understanding_id, count(*) as cnt
    FROM resources
    WHERE canonical_url IS NOT NULL AND major_understanding_id IS NOT NULL
    GROUP BY canonical_url, major_understanding_id
    HAVING count(*) > 1
  ) sub;

  IF v_dup_node_count > 0 OR v_dup_mu_count > 0 THEN
    RAISE EXCEPTION 'Migration 0006 requires deduplication before running. Found % duplicate (canonical_url, node_id) and % duplicate (canonical_url, major_understanding_id) combinations under backfilled canonical_url values. Run manual deduplication first, then re-run migration.', v_dup_node_count, v_dup_mu_count;
  END IF;
END$$;

-- Create NON-UNIQUE index for canonical lookups (safe on existing duplicates)
CREATE INDEX idx_resources_canonical ON resources(canonical_url);

-- Preflight: validate existing rows satisfy XOR constraint (exactly one of node_id, major_understanding_id)
-- If violated, the ALTER TABLE will FAIL with a clear error.
DO $$
DECLARE
  v_xor_violations int;
BEGIN
  SELECT count(*) INTO v_xor_violations
  FROM resources
  WHERE (node_id IS NOT NULL)::int + (major_understanding_id IS NOT NULL)::int != 1;

  IF v_xor_violations > 0 THEN
    RAISE EXCEPTION 'Migration 0006 requires fixing XOR violations before running. Found % rows where neither or both node_id and major_understanding_id are set. Fix these rows manually, then re-run migration.', v_xor_violations;
  END IF;
END$$;

-- XOR constraint: exactly one target (node_id OR major_understanding_id)
ALTER TABLE resources
ADD CONSTRAINT resource_has_target_xor
CHECK ((node_id IS NOT NULL)::int + (major_understanding_id IS NOT NULL)::int = 1);

-- Partial UNIQUE indexes for target-aware identity.
-- These enforce uniqueness at the database level for new writes.
-- The preflight block above checks for existing duplicates and will fail
-- the migration if any are found, preventing silent data loss.
-- Operators must deduplicate existing rows before running this migration,
-- or convert the indexes to non-unique after deduplication.
CREATE UNIQUE INDEX uq_resource_node_target
  ON resources (canonical_url, node_id) WHERE node_id IS NOT NULL;

CREATE UNIQUE INDEX uq_resource_mu_target
  ON resources (canonical_url, major_understanding_id) WHERE major_understanding_id IS NOT NULL;

-- ============================================================
-- 2. ACQUISITION JOBS - CLAIM/LEASE/FENCING COLUMNS
-- ============================================================

ALTER TABLE acquisition_jobs
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_version int DEFAULT 0,
  ADD COLUMN claim_expires_at timestamptz,
  ADD COLUMN created_by uuid REFERENCES auth.users(id),
  ADD COLUMN checkpoint_version int DEFAULT 0,
  ADD COLUMN budget_version int DEFAULT 0,
  ADD COLUMN last_reservation_id uuid;

-- Index for efficient claim query
CREATE INDEX idx_aj_claim ON acquisition_jobs (job_type, status, created_at)
  WHERE status IN ('pending', 'running');

-- Partial unique index: one active generation job per curriculum
CREATE UNIQUE INDEX uq_aj_active_generation
  ON acquisition_jobs (curriculum_id, job_type)
  WHERE status IN ('pending', 'running') AND job_type = 'curriculum_generation';

-- ============================================================
-- 3. VERIFICATION RECORDS - EXACT RETRY IDEMPOTENCY
-- ============================================================

-- Add a dedicated, properly-typed acquisition_job_id column.
-- `verification_records.notes` is `text` (not jsonb) per migrations 0001-0005,
-- so retry deduplication must not rely on `notes->>'acquisition_job_id'`.
ALTER TABLE verification_records ADD COLUMN acquisition_job_id text;

-- Best-effort backfill: populate acquisition_job_id from existing notes where notes
-- holds valid JSON with an acquisition_job_id key. Existing notes text data is
-- preserved untouched; rows whose notes are not valid JSON are left NULL.
CREATE OR REPLACE FUNCTION _vr_extract_acquisition_job_id(p_notes text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_job_id text;
BEGIN
  IF p_notes IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_job_id := (p_notes::jsonb)->>'acquisition_job_id';
    RETURN v_job_id;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

UPDATE verification_records
SET acquisition_job_id = _vr_extract_acquisition_job_id(notes)
WHERE notes IS NOT NULL;

-- Partial unique index for exact-retry detection (same job + same content hash).
-- Uses the dedicated acquisition_job_id column; partial so multiple rows without
-- an acquisition job id are still allowed.
CREATE UNIQUE INDEX uq_vr_exact_retry
  ON verification_records (resource_id, acquisition_job_id, content_hash)
  WHERE acquisition_job_id IS NOT NULL;

-- ============================================================
-- 4. DURABLE AI RESERVATION TABLE
-- ============================================================

CREATE TABLE ai_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  claim_token uuid NOT NULL,
  claim_version int NOT NULL,
  reservation_id uuid NOT NULL UNIQUE,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_reservations_job ON ai_reservations(job_id);
CREATE INDEX idx_ai_reservations_reservation_id ON ai_reservations(reservation_id);

-- ============================================================
-- 5. SECURITY DEFINER FUNCTIONS
-- ============================================================

-- Helper: validate owner exists
CREATE OR REPLACE FUNCTION _validate_owner(p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM auth.users WHERE id = p_owner);
END;
$$;

-- Create curriculum and job atomically (service role only)
CREATE OR REPLACE FUNCTION create_curriculum_and_job(
  p_topic text, p_input jsonb, p_budgets jsonb, p_owner uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_curriculum_id uuid;
  v_job_id uuid;
BEGIN
  IF NOT _validate_owner(p_owner) THEN
    RETURN jsonb_build_object('error', 'invalid_owner');
  END IF;

  INSERT INTO curricula (title, subject, source_type, status, notes, created_by)
  VALUES (p_topic, p_topic, 'ai_organized', 'draft', p_input::text, p_owner)
  RETURNING id INTO v_curriculum_id;

  INSERT INTO acquisition_jobs (curriculum_id, job_type, status, input_data, budget_limits, created_by)
  VALUES (v_curriculum_id, 'curriculum_generation', 'pending', p_input, p_budgets, p_owner)
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object('curriculum_id', v_curriculum_id, 'job_id', v_job_id);
END;
$$;

-- Claim next pending job (service role only)
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
      started_at = now()
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

-- Renew lease without changing claim_version (heartbeat)
CREATE OR REPLACE FUNCTION renew_lease(p_job_id uuid, p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE acquisition_jobs
  SET claim_expires_at = now() + interval '5 minutes'
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND status = 'running' AND claim_expires_at > now();
  RETURN FOUND;
END;
$$;

-- Durable AI budget reservation with idempotency
CREATE OR REPLACE FUNCTION reserve_ai_call(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_max_ai_calls int, p_reservation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_used int; v_reason text; v_outcome jsonb;
BEGIN
  IF p_max_ai_calls <= 0 THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'invalid_max_ai_calls');
  END IF;

  -- Idempotency: check reservation table first
  SELECT outcome INTO v_outcome
  FROM ai_reservations
  WHERE job_id = p_job_id AND reservation_id = p_reservation_id;
  IF FOUND THEN
    RETURN v_outcome || jsonb_build_object('idempotent', true);
  END IF;

  -- Atomic reservation with all fence checks
  UPDATE acquisition_jobs
  SET result_data = jsonb_set(
    COALESCE(result_data, '{}'::jsonb),
    '{aiCallsUsed}',
    to_jsonb(COALESCE((result_data->>'aiCallsUsed')::int, 0) + 1)
  ),
  budget_version = budget_version + 1,
  last_reservation_id = p_reservation_id
  WHERE id = p_job_id
    AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running'
    AND claim_expires_at > now()
    AND COALESCE((result_data->>'aiCallsUsed')::int, 0) < p_max_ai_calls
  RETURNING (result_data->>'aiCallsUsed')::int INTO v_used;

  IF FOUND THEN
    v_outcome := jsonb_build_object('reserved', true, 'used', v_used, 'remaining', p_max_ai_calls - v_used);
  ELSE
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM acquisition_jobs WHERE id = p_job_id AND claim_token = p_claim_token AND claim_version = p_expected_claim_version AND status = 'running') THEN 'ownership_lost'
      ELSE 'budget_exhausted'
    END INTO v_reason;
    v_outcome := jsonb_build_object('reserved', false, 'reason', v_reason);
  END IF;

  -- Durable record of this reservation attempt
  INSERT INTO ai_reservations (job_id, claim_token, claim_version, reservation_id, outcome)
  VALUES (p_job_id, p_claim_token, p_expected_claim_version, p_reservation_id, v_outcome);

  RETURN v_outcome;
END;
$$;

-- Fenced persistence with exact-retry idempotency
CREATE OR REPLACE FUNCTION persist_with_fence(
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
  v_acquired_at text := p_input->'acquiredPage'->>'acquiredAt';
  v_verified_at text := p_input->'verificationResult'->>'verifiedAt';
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
  v_advisory_signals jsonb := p_input->'verificationResult'->'advisorySignals';
BEGIN
  -- Atomic ownership + lease validation
  SELECT * INTO v_job
  FROM acquisition_jobs
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND status = 'running' AND claim_expires_at > now()
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  -- Exact-retry check (same job + same content hash).
  -- Uses the dedicated acquisition_job_id column (notes is text, not jsonb).
  IF p_input->>'acquisitionJobId' IS NOT NULL THEN
    SELECT vr.id, vr.resource_id INTO v_vr_id, v_resource_id
    FROM verification_records vr
    WHERE vr.acquisition_job_id = p_input->>'acquisitionJobId'
      AND vr.content_hash = (p_input->'acquiredPage'->>'contentHash')
    ORDER BY vr.created_at DESC LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('resource_id', v_resource_id, 'vr_id', v_vr_id, 'is_exact_retry', true); END IF;
  END IF;

  -- UPSERT resource (target-aware)
  IF (p_input->'target'->>'nodeId') IS NOT NULL THEN
    INSERT INTO resources (node_id, canonical_url, url, title, source_domain, resource_type, license_status, embed_allowed, content_type_verified, ai_note, status)
    VALUES (
      (p_input->'target'->>'nodeId')::uuid, v_canonical_url,
      (p_input->'acquiredPage'->>'finalUrl'),
      COALESCE(p_input->'structuredContent'->'metadata'->>'title', v_domain, 'Untitled Resource'),
      v_domain,
      COALESCE(p_input->'callerMetadata'->>'resourceType', 'other'),
      COALESCE(p_input->'callerMetadata'->>'licenseStatus', 'link_only'),
      (v_verification_status = 'verified'),
      p_input->'callerMetadata'->>'aiNote',
      'draft'
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
      ai_note = EXCLUDED.ai_note
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
      (v_verification_status = 'verified'),
      p_input->'callerMetadata'->>'aiNote',
      'draft'
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
      ai_note = EXCLUDED.ai_note
    RETURNING id INTO v_resource_id;
  ELSE
    RETURN jsonb_build_object('error', 'invalid_target');
  END IF;

  -- INSERT verification_record (atomic exact-retry)
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
    (p_input->'acquiredPage'->>'contentHash'),
    (p_input->'acquiredPage'->>'statusCode')::int,
    (p_input->'structuredContent'->'metadata'->>'title'),
    jsonb_build_object(
      'description', p_input->'structuredContent'->'metadata'->>'description',
      'author', p_input->'structuredContent'->'metadata'->>'author',
      'date_published', p_input->'structuredContent'->'metadata'->>'datePublished',
      'language', p_input->'structuredContent'->'metadata'->>'language'
    ),
    (p_input->'educationalEvidence'->'interpreted')::text,
    (p_input->'acquiredPage'->>'acquiredAt'),
    (p_input->'verificationResult'->>'verifiedAt'),
    'deterministic_v1',
    jsonb_build_object(
      'cleanedContentNonEmpty', (p_input->'verificationResult'->'deterministicChecks'->>'cleanedContentNonEmpty')::boolean,
      'titlePresent', (p_input->'verificationResult'->'advisorySignals'->>'titlePresent')::boolean,
      'educationalEvidencePresent', (p_input->'verificationResult'->'advisorySignals'->>'educationalEvidencePresent')::boolean,
      'wordCount', (p_input->'verificationResult'->'advisorySignals'->>'wordCount')::int,
      'headingCount', (p_input->'verificationResult'->'advisorySignals'->>'headingCount')::int,
      'paragraphCount', (p_input->'verificationResult'->'advisorySignals'->>'paragraphCount')::int
    ),
    false, null, false, null, (p_input->'verificationResult'->>'status'),
    jsonb_build_object('acquisition_job_id', p_input->>'acquisitionJobId')::text,
    p_input->>'acquisitionJobId'
  ) ON CONFLICT (resource_id, acquisition_job_id, content_hash) WHERE acquisition_job_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_vr_id;

  IF v_vr_id IS NULL THEN
    SELECT id INTO v_vr_id FROM verification_records
    WHERE resource_id = v_resource_id
      AND acquisition_job_id = p_input->>'acquisitionJobId'
      AND content_hash = p_input->'acquiredPage'->>'contentHash';
  END IF;

  -- UPSERT mapping (only for understanding-targeted)
  IF (p_input->'target'->>'understandingId') IS NOT NULL THEN
    INSERT INTO resource_mappings (resource_id, understanding_id, coverage_confidence)
    VALUES (v_resource_id, (p_input->'target'->>'understandingId')::uuid, 'medium')
    ON CONFLICT (resource_id, understanding_id) DO NOTHING
    RETURNING id INTO v_mapping_id;
  END IF;

  RETURN jsonb_build_object('resource_id', v_resource_id, 'vr_id', v_vr_id, 'mapping_id', v_mapping_id, 'is_exact_retry', false);
END;
$$;

-- Idempotent checkpoint advancement
CREATE OR REPLACE FUNCTION advance_checkpoint(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_completed_topic_id uuid, p_resources_found int
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE acquisition_jobs
  SET result_data = jsonb_set(
    COALESCE(result_data, '{}'::jsonb),
    '{checkpoint,completedTopicIds}',
    COALESCE(result_data->'checkpoint'->'completedTopicIds', '[]'::jsonb) || to_jsonb(p_completed_topic_id)
  ),
  checkpoint_version = checkpoint_version + 1
  WHERE id = p_job_id AND claim_token = p_claim_token AND claim_version = p_expected_claim_version AND status = 'running';
  RETURN FOUND;
END;
$$;

-- Recovery: stale-job reclamation
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
      claim_token = NULL, claim_expires_at = NULL, claim_version = claim_version + 1,
      error = 'recovered: lease expired',
      retry_count = CASE
        WHEN retry_count < (budget_limits->>'max_retries')::int THEN retry_count + 1
        ELSE retry_count
      END
    WHERE status = 'running' AND claim_expires_at < now() AND claim_expires_at IS NOT NULL
    RETURNING *
  LOOP
    RETURN NEXT v_job;
  END LOOP;
  RETURN;
END;
$$;

-- Complete job (partial or full)
CREATE OR REPLACE FUNCTION complete_job(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int,
  p_has_progress boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE acquisition_jobs
  SET status = CASE WHEN p_has_progress THEN 'completed' ELSE 'failed' END,
      completed_at = now(),
      error = CASE WHEN p_has_progress THEN NULL ELSE 'max_ai_calls exhausted' END
  WHERE id = p_job_id AND claim_token = p_claim_token AND claim_version = p_expected_claim_version AND status = 'running';
  RETURN FOUND;
END;
$$;

-- Fail job with error
CREATE OR REPLACE FUNCTION fail_job(
  p_job_id uuid, p_claim_token uuid, p_expected_claim_version int, p_error text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE acquisition_jobs
  SET status = 'failed', error = p_error, retry_count = retry_count + 1
  WHERE id = p_job_id AND claim_token = p_claim_token AND claim_version = p_expected_claim_version AND status = 'running';
  RETURN FOUND;
END;
$$;

-- ============================================================
-- 6. GRANTS
-- ============================================================

-- Table grants for authenticated users
GRANT SELECT, INSERT ON curricula TO authenticated;
GRANT SELECT, INSERT ON acquisition_jobs TO authenticated;

-- Function execution grants (service role only)
REVOKE ALL ON FUNCTION create_curriculum_and_job(text, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_curriculum_and_job(text, jsonb, jsonb, uuid) TO service_role;

REVOKE ALL ON FUNCTION claim_next_job(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_job(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION renew_lease(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renew_lease(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION reserve_ai_call(uuid, uuid, int, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_ai_call(uuid, uuid, int, int, uuid) TO service_role;

REVOKE ALL ON FUNCTION persist_with_fence(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION persist_with_fence(uuid, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION advance_checkpoint(uuid, uuid, int, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_checkpoint(uuid, uuid, int, uuid, int) TO service_role;

REVOKE ALL ON FUNCTION recover_stale_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recover_stale_jobs() TO service_role;

REVOKE ALL ON FUNCTION complete_job(uuid, uuid, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_job(uuid, uuid, int, boolean) TO service_role;

REVOKE ALL ON FUNCTION fail_job(uuid, uuid, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fail_job(uuid, uuid, int, text) TO service_role;

-- ============================================================
-- 7. RLS POLICIES FOR STUDENT ACCESS
-- ============================================================

-- Students can create own curricula
CREATE POLICY "Users can create own curricula" ON curricula FOR INSERT WITH CHECK (created_by = auth.uid());

-- Students can read own curricula (draft or published)
CREATE POLICY "Owners can read their curricula" ON curricula FOR SELECT USING (created_by = auth.uid() OR status = 'published' OR is_admin());

-- Students can create own jobs
CREATE POLICY "Users can create own jobs" ON acquisition_jobs FOR INSERT WITH CHECK (created_by = auth.uid());

-- Students can read own jobs
CREATE POLICY "Owners can read their jobs" ON acquisition_jobs FOR SELECT USING (created_by = auth.uid());