-- Preserve resource review decisions during automated fenced persistence.
-- This replaces persist_with_fence without changing its signature or approval gate.
-- Automated approval remains verified + explicit educational evidence only.

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS status_reviewed_by uuid REFERENCES auth.users(id);

-- Remove the withdrawn, reputation/length-based approval RPC if it was ever
-- applied in an environment; no application caller should retain that bypass.
DROP FUNCTION IF EXISTS public.approve_authoritative_resource_with_fence(uuid, uuid, uuid);

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
  -- FIX: Parse ISO text to timestamptz at declaration (single well-defined point).
  -- NULLIF guards against empty string -> NULL instead of cast error.
  -- Malformed ISO (e.g., 'not-a-date') -> PostgreSQL throws invalid input syntax ->
  -- function aborts -> caller treats as persistence failure (candidate skipped, safe).
  -- The application (acquisition engine http.ts) emits new Date().toISOString() -- guaranteed format.
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
  v_advisory_signals jsonb := p_input->'verificationResult'->'advisorySignals';
  -- Auto-approval gate: verified + educational evidence present
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
  -- Uses the dedicated acquisition_job_id column (notes is text, not jsonb).
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
    WHERE resources.status = 'draft'
      AND resources.status_reviewed_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM verification_records vr
        WHERE vr.resource_id = resources.id AND vr.human_reviewed IS TRUE
      )
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
    WHERE resources.status = 'draft'
      AND resources.status_reviewed_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM verification_records vr
        WHERE vr.resource_id = resources.id AND vr.human_reviewed IS TRUE
      )
    RETURNING id INTO v_resource_id;
  ELSE
    RETURN jsonb_build_object('error', 'invalid_target');
  END IF;

  -- ON CONFLICT ... WHERE may intentionally skip a reviewed resource. Resolve
  -- its id so verification evidence and concept mappings can still be recorded
  -- without mutating the reviewed resource itself.
  IF v_resource_id IS NULL THEN
    IF v_target_node_id IS NOT NULL THEN
      SELECT id INTO v_resource_id
      FROM resources
      WHERE canonical_url = v_canonical_url AND node_id = v_target_node_id;
    ELSE
      SELECT id INTO v_resource_id
      FROM resources
      WHERE canonical_url = v_canonical_url
        AND major_understanding_id = v_target_mu_id;
    END IF;
  END IF;

  IF v_resource_id IS NULL THEN
    RETURN jsonb_build_object('error', 'resource_upsert_failed');
  END IF;

  -- INSERT verification_record (atomic exact-retry)
  -- v_acquired_at and v_verified_at are already timestamptz (no cast needed at INSERT)
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
    jsonb_build_object(
      'interpreted', p_input->'educationalEvidence'->'interpreted'
    ),
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
    jsonb_build_object('acquisition_job_id', v_acquisition_job_id),
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

REVOKE ALL ON FUNCTION persist_with_fence(uuid, uuid, jsonb) FROM PUBLIC;
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
        'REVOKE EXECUTE ON FUNCTION persist_with_fence(uuid, uuid, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION persist_with_fence(uuid, uuid, jsonb) TO service_role;
