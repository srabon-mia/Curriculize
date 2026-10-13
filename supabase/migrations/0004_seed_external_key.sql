-- 0004_seed_external_key.sql
-- Add external_key column to resources for idempotent seed upserts.
-- This is a seed-specific mechanism that does not affect normal application workflows.

ALTER TABLE public.resources
ADD COLUMN external_key text;

-- Partial unique index: only enforces uniqueness for rows that have an external_key set.
-- Normal application resources (admin, discovery, generation) leave external_key NULL
-- and are not constrained by this index.
CREATE UNIQUE INDEX idx_resources_external_key
ON public.resources (external_key)
WHERE external_key IS NOT NULL;

COMMENT ON COLUMN public.resources.external_key IS 'Seed-specific stable key for idempotent upserts. Nullable; only set for curated seed resources.';