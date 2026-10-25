-- Persist the complete generated structure before materializing topic rows.
-- Apply only through the reviewed deployment process; this file is not run here.
CREATE OR REPLACE FUNCTION save_job_skeleton(
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_claim_version int,
  p_skeleton jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_job public.acquisition_jobs%ROWTYPE;
  v_data jsonb;
  v_node jsonb;
  v_mu jsonb;
  v_seen_orders jsonb := '{}'::jsonb;
  v_order text;
  v_mu_entry record;
  v_mu_index bigint;
  v_mu_key text;
BEGIN
  -- Validate the complete document before any job state is changed.
  IF p_skeleton IS NULL OR pg_catalog.jsonb_typeof(p_skeleton) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_skeleton->'title') IS DISTINCT FROM 'string'
     OR COALESCE(pg_catalog.btrim(p_skeleton->>'title'), '') = ''
     OR p_skeleton->>'source_type' IS NULL
     OR p_skeleton->>'source_type' NOT IN ('adapted', 'ai_organized')
     OR pg_catalog.jsonb_typeof(p_skeleton->'nodes') IS DISTINCT FROM 'array'
     OR (p_skeleton ? 'source_attribution' AND pg_catalog.jsonb_typeof(p_skeleton->'source_attribution') IS DISTINCT FROM 'string'
         AND pg_catalog.jsonb_typeof(p_skeleton->'source_attribution') IS DISTINCT FROM 'null')
     OR (p_skeleton ? 'source_url' AND pg_catalog.jsonb_typeof(p_skeleton->'source_url') IS DISTINCT FROM 'string'
         AND pg_catalog.jsonb_typeof(p_skeleton->'source_url') IS DISTINCT FROM 'null') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
  END IF;
  IF pg_catalog.jsonb_array_length(p_skeleton->'nodes') = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
  END IF;

  FOR v_node IN SELECT value FROM pg_catalog.jsonb_array_elements(p_skeleton->'nodes') LOOP
    IF pg_catalog.jsonb_typeof(v_node) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_node->'title') IS DISTINCT FROM 'string'
       OR COALESCE(pg_catalog.btrim(v_node->>'title'), '') = ''
       OR pg_catalog.jsonb_typeof(v_node->'order_index') IS DISTINCT FROM 'number'
       OR (v_node->>'order_index') !~ '^[0-9]+$'
       OR pg_catalog.jsonb_typeof(v_node->'major_understandings') IS DISTINCT FROM 'array' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
    END IF;
    IF pg_catalog.jsonb_array_length(v_node->'major_understandings') = 0 THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
    END IF;

    v_order := v_node->>'order_index';
    IF v_seen_orders ? v_order THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
    END IF;
    v_seen_orders := v_seen_orders || pg_catalog.jsonb_build_object(v_order, true);

    v_seen_orders := '{}'::jsonb;
    FOR v_mu_entry IN SELECT value, ordinality FROM pg_catalog.jsonb_array_elements(v_node->'major_understandings') WITH ORDINALITY LOOP
      v_mu := v_mu_entry.value;
      v_mu_index := v_mu_entry.ordinality;
      IF pg_catalog.jsonb_typeof(v_mu) IS DISTINCT FROM 'object'
         OR pg_catalog.jsonb_typeof(v_mu->'description') IS DISTINCT FROM 'string'
         OR COALESCE(pg_catalog.btrim(v_mu->>'description'), '') = ''
         OR (v_mu ? 'code' AND pg_catalog.jsonb_typeof(v_mu->'code') IS DISTINCT FROM 'null'
             AND pg_catalog.jsonb_typeof(v_mu->'code') IS DISTINCT FROM 'string')
         OR (v_mu ? 'code' AND pg_catalog.jsonb_typeof(v_mu->'code') = 'string'
             AND COALESCE(pg_catalog.btrim(v_mu->>'code'), '') = '') THEN
        RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
      END IF;
      v_mu_key := COALESCE(v_mu->>'code', v_order || '.' || v_mu_index::text);
      IF v_seen_orders ? v_mu_key THEN
        RETURN pg_catalog.jsonb_build_object('status', 'invalid_skeleton');
      END IF;
      v_seen_orders := v_seen_orders || pg_catalog.jsonb_build_object(v_mu_key, true);
    END LOOP;
  END LOOP;

  SELECT * INTO v_job
  FROM public.acquisition_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_job.claim_token IS DISTINCT FROM p_claim_token
     OR v_job.claim_version IS DISTINCT FROM p_expected_claim_version
     OR v_job.status <> 'running' OR v_job.claim_expires_at IS NULL
     OR v_job.claim_expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('status', 'ownership_lost_or_expired');
  END IF;

  v_data := COALESCE(v_job.result_data, '{}'::jsonb);
  IF v_data ? 'skeleton' THEN
    IF v_data->'skeleton' = p_skeleton THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_saved');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'skeleton_conflict');
  END IF;

  UPDATE public.acquisition_jobs
  SET result_data = pg_catalog.jsonb_set(v_data, '{skeleton}', p_skeleton, true),
      checkpoint_version = COALESCE(checkpoint_version, 0) + 1
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version AND status = 'running'
    AND claim_expires_at > pg_catalog.clock_timestamp();

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'ownership_lost_or_expired');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'saved');
END;
$$;

REVOKE ALL ON FUNCTION save_job_skeleton(uuid, uuid, int, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_job_skeleton(uuid, uuid, int, jsonb) TO service_role;
