-- 0009_fix_checkpoint_persistence.sql
--
-- Fix: advance_checkpoint must reliably persist the completedTopicIds array.
--
-- ROOT CAUSE
--   The original (migration 0006) implementation used a single jsonb_set on the
--   nested path '{checkpoint,completedTopicIds}' and incremented
--   checkpoint_version in the same UPDATE. When result_data did not yet
--   contain a 'checkpoint' object, the nested write could be silently dropped
--   while checkpoint_version still advanced — producing the production
--   signature `checkpoint_version = 6` with no `completedTopicIds` array.
--   The consequence is fatal for resumption: a worker resuming from the
--   checkpoint sees an empty completed set and redoes every topic.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds an IMMUTABLE helper `_checkpoint_merge` that computes the new
--      result_data for a given scope. It is written so the 'checkpoint'
--      (or 'batchCheckpoint') parent object is ALWAYS present in the output,
--      regardless of whether it existed in the input. The parent object is
--      created explicitly via jsonb_build_object — NOT via a nested
--      jsonb_set(..., true), which cannot create missing intermediate objects.
--   2. Rewrites advance_checkpoint to use that helper inside ONE fenced UPDATE.
--      The claim-token / claim-version / status checks live in the UPDATE's
--      WHERE clause, so a stale worker can never mutate state and never
--      receives a misleading `true`.
--   3. Makes repeated calls for the same topic idempotent: the array is left
--      untouched and checkpoint_version is NOT incremented, but the function
--      still returns true (the caller holds a valid claim).
--
-- SAFETY
--   - Single statement: the row lock is taken by the UPDATE and all SET
--     expressions are evaluated against the same (pre-update) row version, so
--     no read-modify-write race is possible.
--   - Unrelated result_data keys (e.g. aiCallsUsed) are preserved: the merge
--     is a top-level jsonb '||' which keeps every key except the scope key,
--     which is rebuilt from its previous value plus the new array.
--   - A malformed 'checkpoint' value (not an object, or a completedTopicIds
--     that is not an array) is normalized rather than propagated.
--
-- NOTE: migration 0011 redefines _checkpoint_merge with an IDENTICAL body so
-- that 0011 remains self-contained. Keep the two definitions byte-identical
-- in the CASE expression to avoid divergent append semantics.

-- ---------------------------------------------------------------------------
-- Immutable helper: merge a topic id into result_data.<scope>.completedTopicIds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _checkpoint_merge(
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

REVOKE ALL ON FUNCTION _checkpoint_merge(jsonb, text, text) FROM PUBLIC;
-- The helper is only ever invoked from inside the SECURITY DEFINER functions
-- below (which execute as the owner), so no client role needs EXECUTE on it.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION _checkpoint_merge(jsonb, text, text) FROM %I', r);
    END IF;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- advance_checkpoint: durable, fenced, idempotent topic checkpoint
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION advance_checkpoint(
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

REVOKE ALL ON FUNCTION advance_checkpoint(uuid, uuid, int, uuid, int) FROM PUBLIC;
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
        'REVOKE EXECUTE ON FUNCTION advance_checkpoint(uuid, uuid, int, uuid, int) FROM %I', r);
    END IF;
  END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION advance_checkpoint(uuid, uuid, int, uuid, int) TO service_role;
