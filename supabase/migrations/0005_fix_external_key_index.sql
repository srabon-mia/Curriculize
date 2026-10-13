-- 0005_fix_external_key_index.sql
-- Fix: partial unique index is incompatible with ON CONFLICT (external_key).
-- Replace with full unique index. PostgreSQL allows multiple NULLs in unique index by default.

DROP INDEX IF EXISTS idx_resources_external_key;

CREATE UNIQUE INDEX idx_resources_external_key
ON public.resources (external_key);

COMMENT ON INDEX idx_resources_external_key IS 'Full unique index on external_key. NULL values allowed (multiple rows), non-NULL values must be unique. Enables ON CONFLICT (external_key) for seed upserts.';