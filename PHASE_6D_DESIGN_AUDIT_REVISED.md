# Phase 6D Design Audit — Revised (Read-Only)

**STATUS: READ-ONLY — NO IMPLEMENTATION**

---

## 1. ACTUAL REPOSITORY CONSTRAINTS

### 1.1 Resource Table (`resources`) — Actual Schema

```sql
create table resources (
  id uuid primary key default gen_random_uuid(),
  node_id uuid references nodes(id) on delete cascade,
  major_understanding_id uuid references major_understandings(id) on delete cascade,
  url text not null,                    -- NOT unique, NO canonical_url column
  title text not null,
  source_domain text,                   -- denormalized for fast lookup
  resource_type text not null check (
    resource_type in ('video', 'text', 'textbook', 'problem_set',
                      'reference_tool', 'practice_exam', 'other')
  ),
  license_status text not null default 'link_only' check (
    license_status in ('cc_open', 'link_only', 'unknown_review_needed')
  ),
  embed_allowed boolean not null default false,
  content_type_verified boolean not null default false,
  ai_note text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint resource_has_target check (node_id is not null or major_understanding_id is not null)
);

-- Indexes (NO unique constraint on url)
create index idx_resources_node on resources(node_id);
create index idx_resources_mu on resources(major_understanding_id);
create index idx_resources_status on resources(status);
create index idx_resources_domain on resources(source_domain);
```

**Critical facts:**
- `resources.url` is **NOT unique** — no unique constraint, no unique index
- `resources` has **NO `canonical_url` column** — only `verification_records` has it
- Two resources CAN have different URLs that canonicalize to the same value — no prevention exists
- Current insertion code (generation pipeline, admin discovery) does **not** check for duplicates before insert
- Duplicate URLs will create multiple resource rows

### 1.2 Verification Records — Actual Schema

```sql
create table verification_records (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources(id) on delete cascade,
  url text not null,
  canonical_url text,                   -- EXISTS here, not on resources
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
```

### 1.3 Resource Mappings — Actual Schema

```sql
create table resource_mappings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resources(id) on delete cascade,
  understanding_id uuid not null references major_understandings(id) on delete cascade,
  coverage_confidence text not null check (coverage_confidence in ('high', 'medium', 'low')),
  unique (resource_id, understanding_id)  -- UNIQUE CONSTRAINT EXISTS
);

create index idx_rm_resource on resource_mappings(resource_id);
create index idx_rm_understanding on resource_mappings(understanding_id);
```

### 1.4 Acquisition Jobs — Actual Schema

```sql
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
```

**No code currently reads/writes `acquisition_jobs`** — table exists but is unused.

### 1.5 Domain Scores — Actual Usage

```sql
create table domain_scores (
  domain text primary key,
  score smallint not null check (score between 1 and 5),
  category text,
  notes text,
  updated_at timestamptz not null default now()
);
```

**Current usage (only two places):**
1. `/api/discover` route: `embed_allowed = license_status === "cc_open" && domainScore >= 4`
2. `/api/resources` POST: same logic for manual entry

**No ranking, no tiering, no thresholds beyond embed eligibility.**

### 1.6 Transaction Capability

- **No `rpc` calls** found in codebase
- **No transaction wrappers** found
- Supabase client (`@supabase/supabase-js`) does **NOT** provide automatic multi-operation transactions
- Generation pipeline uses service role client (`createServiceClient`) but performs sequential `.insert()` calls without atomicity
- Admin discovery uses user client (`createClient()`) — also no transactions

### 1.7 Deduplication Utilities (Existing, In-Memory Only)

`deterministic/dedup.ts` provides:
- `normalizeForDedup(url)` — aggressive normalization (tracking params, www, sorted query)
- `canonicalizeUrl(url)` — standard canonicalization (lowercase host, no default ports, sorted query, no fragment)
- `DedupTracker` — in-memory per-job tracking of normalized URLs + content hashes
- `makeDedupKey(url, content?)` — returns `{ normalizedUrl, contentHash, canonicalUrl }`
- `keysEqual(a, b)` — compares by contentHash if both present, else normalizedUrl

**Phase 5 engine uses `AcquisitionDedupTracker`** (wraps `DedupTracker`) for in-job deduplication only.

### 1.8 Current Resource Insertion Flows

| Flow | Client | Status Inserted | Mapping Created? |
|------|--------|-----------------|------------------|
| Generation pipeline (topic-level) | Service role | `approved` | No |
| Generation pipeline (background batch) | Service role | `approved` | **Yes** (with `understanding_codes` from AI) |
| Admin discovery (topic/understanding/bulk) | User (admin) | `draft` | No |
| Manual admin entry | User (admin) | `draft` | No |

---

## 2. REVISED 6D PURPOSE

> **Phase 6D provides a deterministic persistence primitive that takes verified acquisition outputs and stores them as resources with verification evidence — without ranking, without publication decisions, and without schema changes.**

6D is a **storage layer** for verified content. It does not rank, score, tier, or classify. It ensures:
- Verified content is durably stored
- Verification evidence is recorded
- Duplicate acquisitions are handled deterministically
- Downstream phases (6E) can query verified resources with evidence

---

## 3. REVISED INPUT CONTRACT

### 3.1 From Phase 5 (Acquisition)
- `AcquiredPage`: `contentHash`, `canonicalUrl`, `finalUrl`, `statusCode`, `contentType`, `acquiredAt`, `headers`, `body`, `charset`, `redirectChain`, `resolvedIps`

### 3.2 From Phase 6A (Structured Content)
- `StructuredContent`: `source` (cleanedHash, contentHash), `metadata` (title, description, author, datePublished, language), `headings`, `blocks`, `links`, `statistics` (wordCount, headingCount, headingCountsByLevel, paragraphCount, linkCount, externalLinkCount)

### 3.3 From Phase 6B (Educational Evidence)
- `EducationalEvidence`: `source` (cleanedHash, contentHash), `interpreted` (explicitLearningObjectives[], explicitDefinitions[], explicitExercises[])

### 3.4 From Phase 6C (Verification)
- `VerificationResult`: `status` ("verified" | "failed"), `deterministicChecks`, `advisorySignals`, `contentHash`, `canonicalUrl`, `verifiedAt`

### 3.5 Context (Optional)
- `targetNodeId?: string` — if resource attaches to a node
- `targetUnderstandingId?: string` — if resource attaches to a major understanding
- `acquisitionJobId?: string` — if invoked from a job (for idempotency)

---

## 4. REVISED RANKING DESIGN

### 4.1 No Ranking in 6D

**6D does not rank, tier, score, or classify resources.**

Rationale from repository inspection:
- No ranking system exists in the codebase
- Domain scores used **only** for `embed_allowed` (binary: cc_open + score ≥ 4)
- No thresholds for word count, heading count, evidence presence
- No numeric scoring, no quality tiers
- Adding invented thresholds would be arbitrary and ungrounded

### 4.2 What 6D Provides Instead

6D persists **all deterministic signals** from 6A/6B/6C so that 6E can implement ranking:

| Signal | Stored Where |
|--------|--------------|
| `verification.status` | `verification_records.status` |
| `advisorySignals.titlePresent` | `verification_records.deterministic_checks` (jsonb) |
| `advisorySignals.educationalEvidencePresent` | `verification_records.deterministic_checks` |
| `advisorySignals.wordCount` | `verification_records.deterministic_checks` |
| `advisorySignals.headingCount` | `verification_records.deterministic_checks` |
| `advisorySignals.paragraphCount` | `verification_records.deterministic_checks` |
| `structuredContent.statistics.*` | `verification_records.deterministic_checks` / `page_metadata` |
| `educationalEvidence.interpreted.*` | `verification_records.content_evidence` |
| `domain_scores.score` | Join at query time (`resources.source_domain` → `domain_scores`) |
| `resource_type` | `resources.resource_type` |
| `license_status` | `resources.license_status` |
| `embed_allowed` | `resources.embed_allowed` |

### 4.3 6E Responsibility

6E will:
- Define ranking algorithm (if needed)
- Add `ranking_tier` or `quality_score` column to `resources` (schema migration)
- Implement warm-path queries that order by ranking
- Handle publication policy (when does verified → approved?)

**6D enables 6E by storing the raw signals. 6D does not interpret them.**

---

## 5. RESOURCE IDENTITY

### 5.1 Current Reality

| Question | Answer |
|----------|--------|
| What identifies a resource? | `resources.id` (UUID PK) — nothing else is unique |
| Is `resources.url` unique? | **No** — no unique constraint, no unique index |
| Does `resources` have `canonical_url`? | **No** — only `verification_records` has it |
| Can two resources have same canonical URL? | **Yes** — currently possible, no prevention |
| What happens on duplicate insert? | New resource row created (different UUID) |

### 5.2 6D Identity Strategy (No Schema Migration)

Since `resources.url` is not unique and no `canonical_url` column exists:

**Logical identity for 6D = `(canonical_url, target_context)`**

Where `target_context` = `{ node_id }` or `{ major_understanding_id }` or `{}` (orphan, not allowed by constraint).

**Implementation in 6D (application-level, not DB constraint):**

```typescript
// Before insert, query for existing resource with same canonical URL + same target
const existing = await supabase
  .from("resources")
  .select("id, url, title, source_domain, ...")
  .eq("node_id", targetNodeId ?? null)
  .eq("major_understanding_id", targetUnderstandingId ?? null)
  .ilike("url", canonicalUrl)  // or exact match after canonicalization in app
  .maybeSingle();
```

**Why not add unique constraint in 6D?** Schema change → 6E concern.

**Why not use `verification_records.canonical_url` as deduplication key?** It's on a different table; joining for every insert adds complexity. 6D uses application-level check.

### 5.3 Behavior: Same Canonical URL, Different Original URLs

| Scenario | 6D Behavior |
|----------|-------------|
| First acquisition of `https://example.com/page?utm=1` | Insert resource, create verification_record |
| Later acquisition of `https://example.com/page?utm=2` (same canonical) | **Find existing resource** by canonical URL + target context → reuse resource, create NEW verification_record |
| Different target (node vs understanding) | Different resource row (different target_context) |

---

## 6. ACQUISITION / IDEMPOTENCY IDENTITY

### 6.1 Two Distinct Retry Scenarios

| Scenario | Detection | Behavior |
|----------|-----------|----------|
| **A. Exact retry of same acquisition job** | Same `acquisition_job_id` provided, or same `AcquisitionDedupTracker` in-memory (not durable) | **Do not create duplicate verification_record** — the job is being retried |
| **B. Genuine new acquisition of same URL** | Different `acquisition_job_id` (or none), or new process | Create new verification_record (new evidence snapshot) |

### 6.2 Idempotency Key Design

**For 6D, the durable idempotency key = `acquisition_job_id` (if provided).**

- If caller provides `acquisition_job_id`: 6D checks `verification_records` for existing record with that job ID (stored in `notes` or `input_data` — but no field exists yet)
- **Problem**: `verification_records` has no `acquisition_job_id` column
- **6D solution**: Store job ID in `verification_records.notes` as JSON: `{"acquisition_job_id": "..."}`

**If no job ID provided** (e.g., admin discovery): treat as new acquisition → always create verification_record.

### 6.3 Idempotency Behavior Matrix

| Input | Resource Exists? | Content Hash Same? | Job ID Same? | Action |
|-------|------------------|--------------------|--------------|--------|
| First acquisition | No | N/A | N/A | Insert resource + verification_record |
| Retry (same job_id) | Yes | Yes | **Yes** | **No-op** (return existing) |
| Retry (same job_id) | Yes | **No** | **Yes** | Update resource + new verification_record |
| Re-acquisition (new job_id) | Yes | Yes | No | New verification_record only |
| Re-acquisition (new job_id) | Yes | **No** | No | Update resource + new verification_record |
| Failed verification retry | Yes (draft) | N/A | New job_id | New verification_record (may now be verified) |

---

## 7. VERIFICATION RECORD IDENTITY

### 7.1 One Record Per Verification Attempt

**Every 6D execution that completes verification creates exactly one `verification_records` row.**

- `verified_at` = timestamp of this verification
- `status` = "verified" or "failed" (from 6C)
- `deterministic_checks` = full advisory signals + hard gate result
- `content_evidence` = serialized 6B educational evidence
- `verification_method` = "deterministic_v1"
- `ai_verified` = false
- `human_reviewed` = false
- `expires_at` = null
- `notes` = JSON including `acquisition_job_id` if provided

### 7.2 No Deduplication of Verification Records

Unlike resources, verification records are **append-only evidence**. Each attempt = one row.

---

## 8. CONTENT VERSIONING

### 8.1 Identity Hierarchy

| Level | Identity | Changes When |
|-------|----------|--------------|
| **Logical Resource** | `(canonical_url, target_context)` | Never (stable) |
| **Acquisition** | `acquisition_job_id` or `(canonical_url, fetched_at)` | New fetch job |
| **Content Version** | `content_hash` (Phase 5) | Page content changes |
| **Verification** | `verification_records.id` (UUID) | Every 6D run |

### 8.2 Versioning Behavior

| Event | Resource Row | Verification Record |
|-------|--------------|---------------------|
| First acquisition (verified) | INSERT (draft) | INSERT (verified) |
| Same job retry (same hash) | No change | **No new record** (idempotent) |
| Same job retry (new hash) | UPDATE (title, metadata) | INSERT (verified/failed) |
| New job, same hash | No change | INSERT (verified/failed) |
| New job, new hash | UPDATE (title, metadata) | INSERT (verified/failed) |
| Failed verification | No change (or INSERT if first) | INSERT (failed) |
| Failed → later verified | No change | INSERT (verified) |

### 8.3 Resource Row = Latest Verified State

- Resource `title`, `source_domain`, `resource_type`, `license_status` updated on **successful** re-acquisition (new hash)
- Failed verifications **do not update** resource row
- `embed_allowed` recalculated on each successful acquisition (domain score may have changed)

---

## 9. RESOURCE MAPPING

### 9.1 Current Reality

- `resource_mappings` has unique constraint on `(resource_id, understanding_id)`
- Generation pipeline background batch **does create mappings** (from AI `understanding_codes`)
- Admin discovery **does NOT create mappings**
- Manual entry **does NOT create mappings**

### 9.2 6D Mapping Behavior

**6D creates/updates a mapping ONLY when `targetUnderstandingId` is explicitly provided.**

```typescript
if (targetUnderstandingId) {
  await supabase.from("resource_mappings").upsert({
    resource_id: resource.id,
    understanding_id: targetUnderstandingId,
    coverage_confidence: "medium"  // Conservative default
  }, { onConflict: "resource_id,understanding_id" });
}
```

### 9.3 Confidence Level

**6D always uses `coverage_confidence: "medium"`** — conservative default.

Rationale:
- Being discovered for an understanding ≠ proven coverage
- AI prompt asked for resources for that understanding, but no semantic verification
- "high" would overclaim; "low" would underclaim
- 6E can upgrade confidence with semantic alignment

**6D does not create mappings for topic-level (node) resources** — only when understanding is explicitly targeted.

---

## 10. PERSISTENCE AND TRANSACTION MECHANISM

### 10.1 No Database Transactions Available

- Supabase JS client does not support multi-statement transactions
- No RPC functions exist for this
- Creating an RPC = schema/database change → 6E concern

### 10.2 6D Approach: Best-Effort Sequential with Compensation

```typescript
async function persistVerifiedResource(input: PersistenceInput): Promise<PersistenceResult> {
  // 1. Find or create resource (application-level dedup by canonical_url + target)
  const resource = await findOrCreateResource(input);
  
  // 2. Check idempotency: same job_id + same content_hash → skip verification record
  const isExactRetry = input.acquisitionJobId && 
    await hasVerificationRecordForJob(resource.id, input.acquisitionJobId, input.contentHash);
  
  let verificationRecord = null;
  if (!isExactRetry) {
    verificationRecord = await createVerificationRecord(resource.id, input);
  }
  
  // 3. Create mapping if understanding context provided
  let mapping = null;
  if (input.targetUnderstandingId) {
    mapping = await upsertResourceMapping(resource.id, input.targetUnderstandingId);
  }
  
  return { resource, verificationRecord, mapping, isExactRetry };
}
```

### 10.3 Failure Handling (No Rollback)

| Failure Point | Behavior |
|---------------|----------|
| Resource insert fails | Throw error — caller retries |
| Verification record insert fails | Resource exists (draft), verification missing — caller retries |
| Mapping upsert fails | Resource + verification exist, mapping missing — caller retries |
| Partial success | **No automatic rollback** — caller must handle retry |

**This is acceptable because:**
- All operations are idempotent (safe to retry)
- Verification records are append-only (duplicates detectable by job_id + content_hash)
- Resource dedup is application-level (safe to retry)
- Mapping has unique constraint (upsert is idempotent)

---

## 11. PUBLICATION / HUMAN REVIEW BOUNDARY

### 11.1 Current State

| Flow | Inserted Status | Public Visibility |
|------|-----------------|-------------------|
| Generation pipeline | `approved` | **Yes** (RLS allows approved) |
| Admin discovery | `draft` | No (RLS blocks draft) |
| Manual entry | `draft` | No |

### 11.2 6D Behavior

**6D always inserts resources with `status: "draft"`**

- Never writes `approved` or `rejected`
- Never reads `resources.status` except to find existing resource
- Verification record `human_reviewed = false` always

### 11.3 Integration Strategy

| Integration Point | 6D Role | 6E Role |
|-------------------|---------|---------|
| Generation pipeline | **Not integrated in 6D** | 6E updates pipeline to use 6D persistence + apply publication policy |
| Admin discovery | **Not integrated in 6D** | 6E updates discovery to use 6D persistence (still draft) |
| Warm path (student delivery) | **Not implemented in 6D** | 6E implements: verified + tier_1/2 → auto-approve or direct delivery |

### 11.4 Student Delivery Invariant

> **Normal student delivery must not require manual admin review.**

- 6D creates `draft` resources — this **does not affect current delivery** because:
  - Generation pipeline still inserts `approved` directly (unchanged in 6D)
  - 6D is a new code path; existing flows untouched
- 6E will define: `verified AND tier_1/2 → auto-approve` OR `verified → direct delivery bypassing status`
- Human review remains optional administrative workflow

**6D does not change publication semantics. 6E does.**

---

## 12. EXACT EXISTING FIELDS TO BE WRITTEN

### 12.1 `resources` Table

| Field | Source | Notes |
|-------|--------|-------|
| `node_id` | Input `targetNodeId` | Null if understanding-targeted |
| `major_understanding_id` | Input `targetUnderstandingId` | Null if node-targeted |
| `url` | Phase 5 `finalUrl` | Original final URL |
| `title` | 6A `metadata.title` | Fallback: Phase 5 `canonicalUrl` host |
| `source_domain` | 6A `metadata` domain or Phase 5 domain | Extracted from URL |
| `resource_type` | Input or default `"other"` | From discovery context if available |
| `license_status` | Input or default `"link_only"` | From discovery context if available |
| `embed_allowed` | Computed: `license_status === "cc_open" && domainScore >= 4` | Requires domain_scores lookup |
| `content_type_verified` | `true` (verified by 6C) | Hard-coded true for 6D-verified |
| `ai_note` | Input `aiNote` or null | From discovery context |
| `status` | `"draft"` | **Always draft** |
| `added_by` | `null` (or admin user if available) | Service role = null |

**Fields NOT written (don't exist or not 6D concern):**
- `canonical_url` — **column doesn't exist**
- `ranking_tier` — **column doesn't exist**
- `word_count` — **column doesn't exist**
- `version` — **column doesn't exist**
- `acquisition_id` — **column doesn't exist**

### 12.2 `verification_records` Table

| Field | Source | Notes |
|-------|--------|-------|
| `resource_id` | From resource upsert | Required |
| `url` | Phase 5 `finalUrl` | |
| `canonical_url` | Phase 5 `canonicalUrl` | **Only place canonical URL stored** |
| `content_hash` | Phase 5 `contentHash` | |
| `http_status` | Phase 5 `statusCode` | |
| `page_title` | 6A `metadata.title` | |
| `page_metadata` | 6A `metadata` (jsonb) | `{description, author, datePublished, language}` |
| `content_evidence` | 6B `interpreted` (jsonb) | Serialized educational evidence |
| `fetched_at` | Phase 5 `acquiredAt` | |
| `verified_at` | 6C `verifiedAt` | |
| `verification_method` | `"deterministic_v1"` | Constant |
| `deterministic_checks` | 6C `deterministicChecks` + `advisorySignals` (jsonb) | Full signals for 6E ranking |
| `ai_verified` | `false` | Constant |
| `ai_verification_notes` | `null` | Constant |
| `human_reviewed` | `false` | Constant |
| `expires_at` | `null` | 6E concern |
| `status` | 6C `status` | "verified" or "failed" |
| `notes` | JSON with `acquisition_job_id` if provided | `{"acquisition_job_id": "..."}` |

### 12.3 `resource_mappings` Table

| Field | Source | Notes |
|-------|--------|-------|
| `resource_id` | From resource upsert | |
| `understanding_id` | Input `targetUnderstandingId` | Only when provided |
| `coverage_confidence` | `"medium"` | Conservative default |

---

## 13. SCHEMA IMPACT

### 13.1 6D Schema Changes: **ZERO**

6D works with **existing schema exactly as-is**.

### 13.2 6E Migration Concerns (Explicit Deferral)

| Need | Current State | 6E Action |
|------|---------------|-----------|
| Resource deduplication by canonical URL | No unique constraint, no canonical_url column | Add `canonical_url` to resources + unique index on `(canonical_url, node_id, major_understanding_id)` |
| Ranking storage | No ranking column | Add `ranking_tier` or `quality_score` to resources |
| Acquisition job tracking on verification | No job_id field | Add `acquisition_job_id` to verification_records or use `notes` JSON |
| Publication policy | `status: draft/approved/rejected` with RLS | Add `publication_state` separate from review status, or auto-promotion rules |
| Content versioning | No version table | Add `resource_versions` if needed, or use verification_records history |
| Warm path query performance | No materialized ranking | Add indexes or materialized view for verified+tier resources |

**None of these are 6D responsibilities.**

---

## 14. FAILURE / RETRY MATRIX

| Case | Resource | Verification Record | Mapping | Notes |
|------|----------|---------------------|---------|-------|
| Verified, first seen | INSERT (draft) | INSERT (verified) | UPSERT (if understanding) | Success |
| Retry same job_id, same hash | Reuse existing | **SKIP** (idempotent) | Reuse existing | Exact retry |
| Retry same job_id, new hash | UPDATE | INSERT (verified/failed) | Preserve | Content changed |
| New job, same hash | Reuse existing | INSERT (verified) | Preserve | Re-verification |
| New job, new hash | UPDATE | INSERT (verified/failed) | Preserve | New version |
| Failed verification | INSERT (draft) or reuse | INSERT (failed) | **None** | Failed gate |
| Failed → later verified | Reuse draft | INSERT (verified) | UPSERT | Recovery |
| Resource insert fails | Error thrown | Not attempted | Not attempted | Retry from start |
| Verification insert fails | Exists (draft) | Missing | Not attempted | Retry verification only |
| Mapping upsert fails | Exists | Exists | Missing/Conflict | Retry mapping only |
| Duplicate URL, different target | New resource row | New verification | New mapping | Different target_context |

---

## 15. TEST PLAN

### 15.1 Unit Tests (Pure Functions)

| Test | Description |
|------|-------------|
| `findExistingResource_byCanonicalUrl` | Finds resource by canonical URL + target context |
| `findExistingResource_noMatch` | Returns null when no match |
| `computeEmbedAllowed_ccOpenHighScore` | `cc_open` + score 5 → true |
| `computeEmbedAllowed_ccOpenLowScore` | `cc_open` + score 3 → false |
| `computeEmbedAllowed_linkOnly` | `link_only` → false regardless of score |
| `serializeDeterministicChecks` | Combines 6C checks + advisory signals correctly |
| `serializeEducationalEvidence` | 6B interpreted → JSON for content_evidence |
| `isExactRetry_sameJobSameHash` | Returns true for exact retry |
| `isExactRetry_differentJob` | Returns false for new job |
| `isExactRetry_newHash` | Returns false for content change |

### 15.2 Integration Tests (Database)

| Test | Description |
|------|-------------|
| `persist_firstAcquisition_verified` | Creates resource (draft) + verification (verified) |
| `persist_firstAcquisition_failed` | Creates resource (draft) + verification (failed), no mapping |
| `persist_exactRetry_sameJobSameHash` | Returns existing resource + verification, no new rows |
| `persist_exactRetry_sameJobNewHash` | Updates resource, adds verification |
| `persist_reAcquisition_newJobSameHash` | Reuses resource, adds verification |
| `persist_reAcquisition_newJobNewHash` | Updates resource, adds verification |
| `persist_withUnderstandingContext` | Creates mapping with confidence=medium |
| `persist_withoutUnderstandingContext` | No mapping created |
| `persist_concurrentInserts_sameUrl` | Application-level dedup prevents duplicate resources |
| `persist_mappingUniqueConstraint` | Upsert handles concurrent mapping gracefully |

### 15.3 Edge Case Tests

| Test | Description |
|------|-------------|
| `canonicalUrl_differentOriginalUrls` | `example.com/page?utm=1` and `example.com/page?utm=2` → same resource |
| `unscoredDomain_defaultsToTwo` | Domain not in domain_scores → treated as score 2 for embed |
| `failedVerification_doesNotUpdateResource` | Resource title unchanged after failed verification |
| `verificationRecord_appendOnly` | 3 acquisitions → 1 resource, 3 verification records |
| `serviceRoleNullAddedBy` | Service role inserts have `added_by = null` |

---

## 16. PHASE 6D → 6E BOUNDARY

### 16.1 What 6D Delivers to 6E

| Artifact | Description |
|----------|-------------|
| `resources` rows with `status: "draft"` | Verified content durably stored |
| `verification_records` rows with full evidence | Audit trail + ranking signals in `deterministic_checks` + `content_evidence` |
| `resource_mappings` rows (when understanding provided) | Explicit resource-understanding links |
| Deterministic signals in JSONB | All 6A/6B/6C outputs queryable for 6E ranking |

### 16.2 What 6E Must Do Before Warm Path Works

1. **Add ranking algorithm** — define tiers/scores using stored signals
2. **Add ranking column** — `resources.ranking_tier` or similar (migration)
3. **Define publication policy** — e.g., `verified AND tier_1/2 → auto-approve` or bypass status check
4. **Update generation pipeline** — use 6D persistence instead of direct `approved` inserts
5. **Implement warm path query** — `SELECT * FROM resources JOIN verification_records ... WHERE status='verified' AND tier IN ('tier_1','tier_2') ORDER BY ...`
6. **Add canonical_url to resources** — for reliable deduplication (migration)

### 16.3 6D Does Not Block 6E

- All signals stored in JSONB — flexible for 6E to experiment
- No hardcoded tiers in 6D — 6E owns ranking logic
- Resources stay `draft` — 6E controls publication
- Mappings use conservative confidence — 6E can refine

---

## 17. REMAINING RISKS

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Application-level dedup race condition** | Medium | Two concurrent 6D calls for same URL may both pass "find existing" check → duplicate resources. Mitigation: 6E adds unique constraint; for now, rare in practice (generation is sequential, admin is human-paced). |
| **No transaction atomicity** | Medium | Partial failure leaves resource without verification or mapping. Mitigation: all operations idempotent; caller retries. 6E can add RPC for atomicity. |
| **Generation pipeline still inserts `approved`** | High (if 6D integrated prematurely) | **Do not integrate 6D into generation pipeline in this phase.** 6D is a library; 6E integrates it. |
| **Verification record growth** | Low | Append-only; index on `resource_id` + `verified_at` sufficient for now. |
| **Mapping confidence overclaim** | Low | 6D uses "medium" default; 6E validates with semantic alignment. |
| **Domain score changes not reflected** | Low | `embed_allowed` recalculated on each successful acquisition. Stale on resource row until next fetch. |

---

## 18. FINAL VERDICT

**PHASE 6D DESIGN: READY FOR IMPLEMENTATION**

### Summary of Key Corrections from Previous Design

| Previous Design | Revised Design |
|-----------------|----------------|
| Invented tier thresholds (50/150/300/500 words) | **No ranking in 6D** — stores raw signals for 6E |
| `canonical_url` as primary key on resources | **Application-level dedup** by canonical URL + target (no schema change) |
| Always create verification record | **Idempotent for exact job retry** (job_id in notes) |
| Multi-statement transaction via RPC | **Sequential best-effort** with idempotent operations (no RPC exists) |
| Mapping confidence: high/medium by source | **Always "medium"** — conservative, no semantic claim |
| Integrate into generation pipeline now | **6D is a library**; 6E integrates + changes pipeline to use it |
| Resource row updated on failed verification | **Failed verification never updates resource** |
| New fields: ranking_tier, word_count, etc. | **Zero schema changes** — all in JSONB or existing columns |

### Implementation Scope for 6D

1. **Types**: `PersistenceInput`, `PersistenceResult`
2. **Pure functions**: `findOrCreateResource()`, `createVerificationRecord()`, `upsertResourceMapping()`, `isExactRetry()`
3. **Main export**: `persistVerifiedResource(input: PersistenceInput): Promise<PersistenceResult>`
4. **No AI, no network, no schema changes, no ranking, no publication decisions**

---

*End of Revised Phase 6D Design Audit*