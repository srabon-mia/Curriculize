-- 0012_increase_lease_duration.sql
-- Increase lease duration from 5 minutes to 15 minutes to accommodate
-- long-running AI calls with web search (skeleton generation).
--
-- The 5-minute lease was too short for AI calls with web search which can
-- take 4+ minutes, leaving only ~1 minute buffer between the 60-second
-- heartbeat interval and the 5-minute expiry.
--
-- 15 minutes provides 14 minutes of buffer, sufficient for even slow
-- web searches and retries.

-- 1. Update claim_next_job: set initial lease to 15 minutes
CREATE OR REPLACE FUNCTION claim_next_job(p_job_type text, p_curriculum_id uuid DEFAULT NULL)
RETURNS acquisition_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job acquisition_jobs%ROWTYPE;
BEGIN
  UPDATE acquisition_jobs
  SET status = 'running',
      claim_token = gen_random_uuid(),
      claim_version = 1,
      claim_expires_at = now() + interval '15 minutes',  -- CHANGED: 5 -> 15 minutes
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

-- 2. Update renew_lease: renew to 15 minutes
CREATE OR REPLACE FUNCTION renew_lease(p_job_id uuid, p_claim_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE acquisition_jobs
  SET claim_expires_at = now() + interval '15 minutes'  -- CHANGED: 5 -> 15 minutes
  WHERE id = p_job_id AND claim_token = p_claim_token
    AND status = 'running' AND claim_expires_at > now();
  RETURN FOUND;
END;
$$;

-- 3. Update recover_stale_jobs: jobs are stale after 15 minutes (no change needed in logic,
--    it uses claim_expires_at < now() which will now be 15 minutes from last renewal)
--    No SQL change needed for recover_stale_jobs - it automatically uses the new duration.