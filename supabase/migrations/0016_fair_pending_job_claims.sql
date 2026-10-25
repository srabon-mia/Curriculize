-- Prefer pending jobs that have never been claimed, then the least recently
-- claimed job. started_at is set on every claim and retained when a claim is
-- yielded, so this provides queue fairness without adding schema state.
CREATE OR REPLACE FUNCTION public.claim_next_job(
  p_job_type text,
  p_curriculum_id uuid DEFAULT NULL
)
RETURNS public.acquisition_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_job public.acquisition_jobs%ROWTYPE;
BEGIN
  UPDATE public.acquisition_jobs AS claimed
  SET status = 'running',
      claim_token = pg_catalog.gen_random_uuid(),
      claim_version = 1,
      claim_expires_at = pg_catalog.now() + interval '15 minutes',
      started_at = pg_catalog.now()
  WHERE claimed.id = (
    SELECT candidate.id
    FROM public.acquisition_jobs AS candidate
    WHERE candidate.status = 'pending'
      AND candidate.job_type = p_job_type
      AND (p_curriculum_id IS NULL OR candidate.curriculum_id = p_curriculum_id)
    ORDER BY candidate.started_at ASC NULLS FIRST,
      candidate.created_at ASC,
      candidate.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING claimed.* INTO v_job;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_job(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job(text, uuid) TO service_role;
