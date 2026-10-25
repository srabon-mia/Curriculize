-- Publish a fully generated curriculum and complete its acquisition job atomically.
-- Apply only through the reviewed deployment process; this file is not run here.
CREATE OR REPLACE FUNCTION public.publish_and_complete_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_claim_version int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_job public.acquisition_jobs%ROWTYPE;
  v_curriculum_id uuid;
BEGIN
  SELECT * INTO v_job
  FROM public.acquisition_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  -- A response may have been lost after the transaction committed. A replay
  -- from the same fenced claim is safe and reports the durable result.
  IF FOUND AND v_job.status = 'completed'
     AND v_job.claim_token = p_claim_token
     AND v_job.claim_version = p_expected_claim_version THEN
    IF EXISTS (
      SELECT 1 FROM public.curricula
      WHERE id = v_job.curriculum_id AND status = 'published'
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_completed');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'curriculum_not_found');
  END IF;

  IF NOT FOUND
     OR v_job.claim_token IS DISTINCT FROM p_claim_token
     OR v_job.claim_version IS DISTINCT FROM p_expected_claim_version
     OR v_job.status <> 'running'
     OR v_job.claim_expires_at IS NULL
     OR v_job.claim_expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('status', 'ownership_lost_or_expired');
  END IF;

  v_curriculum_id := v_job.curriculum_id;
  UPDATE public.curricula
  SET status = 'published'
  WHERE id = v_curriculum_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'curriculum_not_found');
  END IF;

  -- The job row is still locked. The token/version/status predicate retains
  -- fencing; lease validity was checked after acquiring the lock above.
  UPDATE public.acquisition_jobs
  SET status = 'completed', completed_at = pg_catalog.clock_timestamp(), error = NULL
  WHERE id = p_job_id
    AND claim_token = p_claim_token
    AND claim_version = p_expected_claim_version
    AND status = 'running';
  IF NOT FOUND THEN
    -- Raising rolls back the preceding curriculum update in this transaction.
    RAISE EXCEPTION 'fenced job completion update did not match the locked job';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'completed');
END;
$$;

REVOKE ALL ON FUNCTION public.publish_and_complete_job(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_and_complete_job(uuid, uuid, int) TO service_role;
