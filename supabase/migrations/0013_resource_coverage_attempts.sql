-- Record bounded, fenced per-topic and per-batch discovery attempts.
-- Apply through the normal reviewed deployment process; this migration is not
-- executed by the local audit task.
CREATE OR REPLACE FUNCTION record_resource_coverage_attempt(
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_claim_version int,
  p_phase text,
  p_target_id uuid,
  p_attempt_id uuid,
  p_resources_found int,
  p_sufficient boolean,
  p_max_attempts int DEFAULT 2,
  p_budget_exhausted boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_job acquisition_jobs%ROWTYPE;
  v_data jsonb;
  v_coverage jsonb;
  v_key text;
  v_checkpoint_key text;
  v_attempts int;
  v_status text;
  v_ids jsonb;
  v_attempt_ids jsonb;
BEGIN
  IF p_phase NOT IN ('topic', 'batch') OR p_max_attempts < 1 OR p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_coverage_request');
  END IF;

  SELECT * INTO v_job
  FROM acquisition_jobs
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running' AND claim_expires_at > now()
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  v_key := p_phase || ':' || p_target_id::text;
  v_checkpoint_key := CASE WHEN p_phase = 'topic' THEN 'checkpoint' ELSE 'batchCheckpoint' END;
  v_data := COALESCE(v_job.result_data, '{}'::jsonb);
  v_coverage := COALESCE(v_data->'resourceCoverage', '{}'::jsonb);
  v_attempts := COALESCE((v_coverage->v_key->>'attempts')::int, 0);
  v_attempt_ids := COALESCE(v_coverage->v_key->'attemptIds', '[]'::jsonb);

  -- Replaying the same RPC request returns the current target outcome without
  -- spending another retry. Each genuinely new discovery attempt gets a UUID.
  IF v_attempt_ids ? p_attempt_id::text THEN
    v_status := COALESCE(v_coverage->v_key->>'status', 'retrying');
    RETURN jsonb_build_object(
      'attempts', v_attempts,
      'status', v_status,
      'retry', v_status = 'retrying'
    );
  END IF;

  IF NOT p_budget_exhausted THEN
    v_attempts := v_attempts + 1;
  END IF;

  v_status := CASE
    WHEN p_sufficient THEN 'complete'
    WHEN p_budget_exhausted OR v_attempts >= p_max_attempts THEN 'insufficient'
    ELSE 'retrying'
  END;

  v_coverage := v_coverage || jsonb_build_object(v_key, jsonb_build_object(
    'attempts', v_attempts,
    'attemptIds', v_attempt_ids || jsonb_build_array(p_attempt_id::text),
    'status', v_status,
    'resourcesFound', GREATEST(p_resources_found, 0),
    'updatedAt', now()
  ));
  v_data := jsonb_set(v_data, '{resourceCoverage}', v_coverage, true);

  IF v_status IN ('complete', 'insufficient') THEN
    v_ids := COALESCE(v_data->v_checkpoint_key->'completedTopicIds', '[]'::jsonb);
    IF NOT (v_ids ? p_target_id::text) THEN
      v_ids := v_ids || jsonb_build_array(p_target_id::text);
    END IF;
    v_data := jsonb_set(
      v_data,
      ARRAY[v_checkpoint_key],
      COALESCE(v_data->v_checkpoint_key, '{}'::jsonb) || jsonb_build_object(
        'completedTopicIds', v_ids,
        'updatedAt', now()
      ),
      true
    );
  END IF;

  UPDATE acquisition_jobs
  SET result_data = v_data,
      checkpoint_version = checkpoint_version + 1
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version AND status = 'running'
    AND claim_expires_at > now();
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  RETURN jsonb_build_object(
    'attempts', v_attempts,
    'status', v_status,
    'retry', v_status = 'retrying'
  );
END;
$$;

REVOKE ALL ON FUNCTION record_resource_coverage_attempt(uuid, uuid, int, text, uuid, uuid, int, boolean, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_resource_coverage_attempt(uuid, uuid, int, text, uuid, uuid, int, boolean, int, boolean) TO service_role;
