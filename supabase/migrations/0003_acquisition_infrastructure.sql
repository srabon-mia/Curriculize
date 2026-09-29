-- 0003_acquisition_infrastructure.sql
-- Phase 1: acquisition infrastructure tables for the locked architecture.
-- Additive only — no existing tables modified, no existing data deleted,
-- no existing RLS policies modified.
--
-- Tables added:
--   curriculum_sources  — structured provenance authority per curriculum
--   resource_mappings   — many-to-many resource ↔ understanding
--   verification_records — evidence of resource verification
--   acquisition_jobs    — durable job records for acquisition work

-- ============================================================
-- curriculum_sources: structured provenance authority
-- ============================================================
create table curriculum_sources (
  id uuid primary key default gen_random_uuid(),
  curriculum_id uuid not null references curricula(id) on delete cascade,
  source_type text not null check (source_type in ('human_written', 'adapted', 'ai_generated')),
  source_url text,
  source_title text,
  source_author text,
  source_institution text,
  verification_state text,
  structure_match_info jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_curriculum_sources_curriculum on curriculum_sources(curriculum_id);

-- ============================================================
-- resource_mappings: many-to-many resource ↔ understanding
-- ============================================================
create table resource_mappings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources(id) on delete cascade,
  understanding_id uuid not null references major_understandings(id) on delete cascade,
  coverage_confidence text not null check (coverage_confidence in ('high', 'medium', 'low')),
  unique (resource_id, understanding_id)
);

create index idx_rm_resource on resource_mappings(resource_id);
create index idx_rm_understanding on resource_mappings(understanding_id);

-- ============================================================
-- verification_records: evidence of resource verification
-- ============================================================
create table verification_records (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources(id) on delete cascade,
  url text not null,
  canonical_url text,
  content_hash text,
  http_status int,
  page_title text,
  page_metadata jsonb,
  content_evidence text,
  fetched_at timestamptz,
  verified_at timestamptz,
  verification_method text,
  deterministic_checks jsonb,
  ai_verified boolean,
  ai_verification_notes text,
  human_reviewed boolean,
  expires_at timestamptz,
  status text not null check (status in ('pending', 'verified', 'failed', 'expired')),
  notes text,
  created_at timestamptz not null default now()
);

create index idx_vr_resource on verification_records(resource_id);
create index idx_vr_status on verification_records(status);
create index idx_vr_expires on verification_records(expires_at);

-- ============================================================
-- acquisition_jobs: durable job records
-- ============================================================
create table acquisition_jobs (
  id uuid primary key default gen_random_uuid(),
  curriculum_id uuid references curricula(id) on delete set null,
  unit_id uuid references nodes(id) on delete set null,
  understanding_id uuid references major_understandings(id) on delete set null,
  job_type text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  input_data jsonb,
  result_data jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  retry_count smallint default 0,
  budget_limits jsonb
);

create index idx_aj_status on acquisition_jobs(status);
create index idx_aj_curriculum on acquisition_jobs(curriculum_id);
create index idx_aj_unit on acquisition_jobs(unit_id);
create index idx_aj_understanding on acquisition_jobs(understanding_id);
create index idx_aj_created on acquisition_jobs(created_at);

-- ============================================================
-- Row Level Security policies
-- Follows the existing is_admin() pattern from 0002_rls.sql.
-- ============================================================

-- curriculum_sources: admin-only writes; public reads for verified sources
alter table curriculum_sources enable row level security;

create policy "Admins can write curriculum_sources"
  on curriculum_sources for all
  using (is_admin())
  with check (is_admin());

create policy "Public can read curriculum_sources"
  on curriculum_sources for select
  using (verification_state = 'verified' or is_admin());

-- resource_mappings: public reads; admin writes
alter table resource_mappings enable row level security;

create policy "Public can read resource_mappings"
  on resource_mappings for select
  using (true);

create policy "Admins can write resource_mappings"
  on resource_mappings for all
  using (is_admin())
  with check (is_admin());

-- verification_records: admin-only (internal evidence, not student-facing)
alter table verification_records enable row level security;

create policy "Admins only verification_records"
  on verification_records for all
  using (is_admin())
  with check (is_admin());

-- acquisition_jobs: admin-only (server-side creation only)
alter table acquisition_jobs enable row level security;

create policy "Admins only acquisition_jobs"
  on acquisition_jobs for all
  using (is_admin())
  with check (is_admin());
