-- Reset consecutive continuation yields only when a new, fenced coverage
-- attempt checkpoint is durably written. Replays return before this update.
CREATE OR REPLACE FUNCTION public.record_resource_coverage_attempt(
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
  v_job public.acquisition_jobs%ROWTYPE;
  v_data jsonb;
  v_coverage jsonb;
  v_key text;
  v_checkpoint_key text;
  v_attempts int;
  v_status text;
  v_ids jsonb;
  v_attempt_ids jsonb;
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('topic', 'batch')
    OR p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 2
    OR p_attempt_id IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_coverage_request');
  END IF;

  SELECT * INTO v_job
  FROM public.acquisition_jobs
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running' AND claim_expires_at > pg_catalog.now()
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  v_key := p_phase || ':' || p_target_id::text;
  v_checkpoint_key := CASE WHEN p_phase = 'topic' THEN 'checkpoint' ELSE 'batchCheckpoint' END;
  v_data := COALESCE(v_job.result_data, '{}'::jsonb);
  v_coverage := COALESCE(v_data->'resourceCoverage', '{}'::jsonb);
  v_attempts := COALESCE((v_coverage->v_key->>'attempts')::int, 0);
  v_attempt_ids := COALESCE(v_coverage->v_key->'attemptIds', '[]'::jsonb);

  -- A replay is not new progress: preserve both the checkpoint and yield cap.
  IF v_attempt_ids ? p_attempt_id::text THEN
    v_status := COALESCE(v_coverage->v_key->>'status', 'retrying');
    RETURN jsonb_build_object(
      'attempts', v_attempts,
      'status', v_status,
      'retry', v_status = 'retrying'
    );
  END IF;

  -- A distinct UUID does not authorize more work after a target is terminal.
  -- Keep the established two-attempt bound even for service-role callers.
  v_status := v_coverage->v_key->>'status';
  IF v_status IN ('complete', 'insufficient') THEN
    RETURN jsonb_build_object(
      'attempts', v_attempts,
      'status', v_status,
      'retry', false
    );
  END IF;
  IF v_attempts >= p_max_attempts THEN
    RETURN jsonb_build_object('error', 'attempt_limit_reached');
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
    'updatedAt', pg_catalog.now()
  ));
  v_data := pg_catalog.jsonb_set(v_data, '{resourceCoverage}', v_coverage, true);

  IF v_status IN ('complete', 'insufficient') THEN
    v_ids := COALESCE(v_data->v_checkpoint_key->'completedTopicIds', '[]'::jsonb);
    IF NOT (v_ids ? p_target_id::text) THEN
      v_ids := v_ids || pg_catalog.jsonb_build_array(p_target_id::text);
    END IF;
    v_data := pg_catalog.jsonb_set(
      v_data,
      ARRAY[v_checkpoint_key],
      COALESCE(v_data->v_checkpoint_key, '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'completedTopicIds', v_ids,
        'updatedAt', pg_catalog.now()
      ),
      true
    );
  END IF;

  -- The checkpoint and yield reset are one fenced write. A stale claim or an
  -- expired lease updates neither field; release_job_claim still enforces its
  -- existing cap when no new checkpoint has been committed.
  UPDATE public.acquisition_jobs
  SET result_data = v_data,
      checkpoint_version = checkpoint_version + 1,
      yield_count = 0
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version AND status = 'running'
    AND claim_expires_at > pg_catalog.now();
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'ownership_lost_or_expired'); END IF;

  RETURN jsonb_build_object(
    'attempts', v_attempts,
    'status', v_status,
    'retry', v_status = 'retrying'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_resource_coverage_attempt(uuid, uuid, int, text, uuid, uuid, int, boolean, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_resource_coverage_attempt(uuid, uuid, int, text, uuid, uuid, int, boolean, int, boolean) TO service_role;
