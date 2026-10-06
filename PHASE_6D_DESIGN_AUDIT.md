# Phase 6D Design Audit — Ranking + Persistence

**Status**: READ-ONLY AUDIT — NO IMPLEMENTATION  
**Date**: 2026-10-04  
**Baseline**: Phase 6C — 356/356 tests passing, TypeScript/build passing

---

## 1. CURRENT REPOSITORY STATE

### 1.1 Phase Pipeline (Locked)

| Phase | Responsibility | Key Output | AI/Network |
|-------|---------------|------------|------------|
| 5 | Acquisition & cleaning | `AcquiredPage`, `CleanedPage` | Network (HTTP), **No AI** |
| 6A | Structured extraction | `StructuredContent` (headings, blocks, links, statistics) | **Zero AI, Zero Network** |
| 6B | Educational evidence | `EducationalEvidence` (objectives, definitions, exercises) | **Zero AI, Zero Network** |
| 6C | Verification gate | `VerificationResult` (status + advisory signals) | **Zero AI, Zero Network** |

### 1.2 Database Schema (Supabase)

**Core tables (Phase 1):**
- `curricula` — top-level container (status: draft/published/archived)
- `nodes` — topics within curriculum
- `major_understandings` — fine-grained concepts (resource attachment granularity)
- `domain_scores` — reputation scores 1-5 per domain
- `resources` — curated links with:
  - `node_id` OR `major_understanding_id` (must attach to one)
  - `url`, `title`, `source_domain`
  - `resource_type`: video/text/textbook/problem_set/reference_tool/practice_exam/other
  - `license_status`: cc_open/link_only/unknown_review_needed
  - `embed_allowed`: boolean (cc_open + domain_score >= 4)
  - `content_type_verified`: boolean
  - `ai_note`: string
  - `status`: draft/approved/rejected ← **RLS: only approved are public**
- `progress` — per-user completion

**Phase 3 acquisition infrastructure (additive, no existing table modifications):**
- `curriculum_sources` — provenance per curriculum (source_type: human_written/adapted/ai_generated)
- `resource_mappings` — many-to-many resource ↔ understanding
  - `resource_id`, `understanding_id` (unique)
  - `coverage_confidence`: high/medium/low
- `verification_records` — evidence of resource verification
  - `resource_id`, `url`, `canonical_url`, `content_hash`
  - `http_status`, `page_title`, `page_metadata`, `content_evidence`
  - `fetched_at`, `verified_at`
  - `verification_method`, `deterministic_checks` (jsonb)
  - `ai_verified`, `ai_verification_notes`
  - `human_reviewed`, `expires_at`
  - `status`: pending/verified/failed/expired
- `acquisition_jobs` — durable job records

**RLS (Phase 2):**
- Published curricula + approved resources = public
- Admin writes only (via `is_admin()` allowlist)
- Verification records = admin-only (internal evidence)

### 1.3 Current Resource Flow

1. **Generation pipeline** (`/api/generate/[id]/stream`):
   - Creates curriculum skeleton (AI + web search)
   - Inserts nodes + major understandings
   - Discovers sources (AI, no search)
   - Topic-level resource discovery (AI + web search) → inserts resources with `status: approved`
   - Publishes curriculum
   - Background per-understanding discovery (AI + web search) → inserts resources with `status: approved`

2. **Admin discovery** (`/api/discover`):
   - AI + web search per topic/understanding
   - Inserts resources with `status: draft` → admin review queue
   - `embed_allowed` = `license_status === "cc_open" && domain_score >= 4`

3. **Manual addition** (`/api/resources` POST):
   - Defaults to `license_status: link_only`, `status: draft`
   - Admin must approve

**Key observation**: The generation pipeline **bypasses the review queue** by inserting directly as `approved`. Admin discovery goes through `draft` → admin approval.

### 1.4 Verification Contract (Phase 6C — Locked)

```typescript
VerificationInput {
  acquiredPage: { contentHash, canonicalUrl, finalUrl, statusCode, contentType, acquiredAt }
  structuredContent: StructuredContent
  educationalEvidence: EducationalEvidence
}

VerificationResult {
  status: "verified" | "failed"
  deterministicChecks: { cleanedContentNonEmpty: boolean }
  advisorySignals: {
    titlePresent: boolean
    educationalEvidencePresent: boolean
    wordCount: number
    headingCount: number
    paragraphCount: number
  }
  contentHash: string          // Phase 5 AcquiredPage.contentHash
  canonicalUrl: string         // Phase 5 canonical URL (no re-canonicalization)
  verifiedAt: string           // ISO timestamp
}
```

**Hard gate**: `wordCount > 0` → `status: "verified"`  
**Advisory only**: title, evidence presence, word/heading/paragraph counts  
**No AI, no network, no persistence**

---

## 2. FINAL 6D PURPOSE

> **Phase 6D takes verified acquisition results plus already-extracted deterministic evidence and produces a persisted, rankable resource representation with deterministic ranking signals for downstream curriculum assembly — without AI, network calls, or lifecycle/publication decisions.**

---

## 3. INPUT CONTRACT

### 3.1 From Phase 5 (Acquisition)
- `AcquiredPage`: `contentHash`, `canonicalUrl`, `finalUrl`, `statusCode`, `contentType`, `acquiredAt`, `headers`, `body`, `charset`, `redirectChain`, `resolvedIps`

### 3.2 From Phase 6A (Structured Content)
- `StructuredContent`: `source` (cleanedHash, contentHash), `metadata` (title, description, author, datePublished, language), `headings`, `blocks`, `links`, `statistics` (wordCount, headingCount, headingCountsByLevel, paragraphCount, linkCount, externalLinkCount)

### 3.3 From Phase 6B (Educational Evidence)
- `EducationalEvidence`: `source` (cleanedHash, contentHash), `interpreted` (explicitLearningObjectives[], explicitDefinitions[], explicitExercises[])

### 3.4 From Phase 6C (Verification)
- `VerificationResult`: `status`, `deterministicChecks`, `advisorySignals`, `contentHash`, `canonicalUrl`, `verifiedAt`

### 3.5 Existing Domain/Database State
- `domain_scores` table (domain → score 1-5)
- `major_understandings` (target concepts for mapping)
- `curriculum_sources` (provenance context)
- `acquisition_jobs` (job context if invoked from job)

---

## 4. RANKING DESIGN

### 4.1 Design Philosophy

**No numeric scoring formula**. Arbitrary weights (title × 0.2 + wordCount × 0.3...) pretend to measure educational quality but cannot be validated. Instead: **deterministic tiering** with explicit rationale per signal.

### 4.2 Ranking Inputs (Deterministic Signals Only)

| Signal | Source | Meaning | Hard Exclusion? |
|--------|--------|---------|-----------------|
| `verification.status === "verified"` | 6C | Passed minimal content gate | **YES** — failed = not rankable |
| `advisorySignals.titlePresent` | 6C/6A | Document has a title | No — advisory |
| `advisorySignals.educationalEvidencePresent` | 6C/6B | ≥1 explicit educational pattern matched | No — advisory |
| `advisorySignals.wordCount` | 6C/6A | Cleaned text word count | No — advisory |
| `advisorySignals.headingCount` | 6C/6A | Structural organization | No — advisory |
| `advisorySignals.paragraphCount` | 6C/6A | Content depth indicator | No — advisory |
| `source_domain` score | `domain_scores` | Reputation of source (1-5) | No — advisory |
| `resource_type` | Existing | video/text/textbook/problem_set/... | No — advisory |
| `license_status` | Existing | cc_open/link_only/unknown | No — advisory |
| `embed_allowed` | Existing | Can be embedded (cc_open + score ≥ 4) | No — advisory |

### 4.3 Deterministic Tiering Algorithm

```typescript
type ResourceTier = "tier_1_strong" | "tier_2_good" | "tier_3_basic" | "tier_4_minimal";

function rankResource(input: RankingInput): ResourceTier {
  // HARD EXCLUSION: verification failed
  if (input.verification.status === "failed") {
    return "excluded"; // not rankable
  }

  const signals = {
    hasTitle: input.verification.advisorySignals.titlePresent,
    hasEducationalEvidence: input.verification.advisorySignals.educationalEvidencePresent,
    wordCount: input.verification.advisorySignals.wordCount,
    headingCount: input.verification.advisorySignals.headingCount,
    paragraphCount: input.verification.advisorySignals.paragraphCount,
    domainScore: input.domainScore ?? 2, // default 2 if unscored
    isEmbedAllowed: input.embedAllowed,
    resourceType: input.resourceType,
    licenseStatus: input.licenseStatus,
  };

  // Tier 1: Strong — verified + educational evidence + substantial content + good domain
  if (signals.hasEducationalEvidence &&
      signals.wordCount >= 300 &&
      signals.headingCount >= 2 &&
      signals.domainScore >= 4) {
    return "tier_1_strong";
  }

  // Tier 2: Good — verified + educational evidence OR substantial content + decent domain
  if ((signals.hasEducationalEvidence && signals.wordCount >= 150) ||
      (signals.wordCount >= 500 && signals.domainScore >= 3)) {
    return "tier_2_good";
  }

  // Tier 3: Basic — verified + some content
  if (signals.wordCount >= 50) {
    return "tier_3_basic";
  }

  // Tier 4: Minimal — verified but thin
  return "tier_4_minimal";
}
```

**Rationale for tier boundaries:**
- 300 words ≈ minimal educational article
- 150 words ≈ short explanation
- 50 words ≈ stub/thin content
- Domain score ≥ 4 = known reputable sources (official, textbook, established review)
- Educational evidence = explicit objectives/definitions/exercises detected

### 4.4 Why Not Numeric Scoring

1. **No ground truth**: No labeled dataset to calibrate weights
2. **False precision**: 0.73 vs 0.71 implies meaningful difference that doesn't exist
3. **Maintenance burden**: Weights become magic numbers nobody can justify
4. **Tiering is sufficient**: Downstream consumers need ordering, not precision scores
5. **Transparent**: Each tier has explicit, auditable criteria

### 4.5 Downstream Consumption

Curriculum assembly (6E+) queries resources ordered by:
1. `tier` (1 → 4)
2. Within tier: `domainScore` DESC, `wordCount` DESC, `headingCount` DESC

---

## 5. PERSISTENCE DESIGN

### 5.1 Tables 6D Will Touch

| Table | Operation | Fields |
|-------|-----------|--------|
| `resources` | UPSERT (create or update) | `url`, `title`, `source_domain`, `resource_type`, `license_status`, `embed_allowed`, `content_type_verified`, `ai_note`, `status` (draft), `node_id`/`major_understanding_id` |
| `verification_records` | INSERT (new record per verification) | `resource_id`, `url`, `canonical_url`, `content_hash`, `http_status`, `page_title`, `page_metadata`, `content_evidence`, `fetched_at`, `verified_at`, `verification_method`, `deterministic_checks`, `status` |
| `resource_mappings` | UPSERT (if understanding context provided) | `resource_id`, `understanding_id`, `coverage_confidence` |

### 5.2 Fields NOT Modified by 6D

- `resources.status` — **remains `draft`** (6E owns publication)
- `resources.ai_note` — set from discovery context if available, else null
- `verification_records.ai_verified` — **always false** (6D uses zero AI)
- `verification_records.human_reviewed` — **always false** (not a 6D concern)
- `verification_records.expires_at` — null (6E owns expiration)

### 5.3 Verification Method Value

```typescript
verification_method = "deterministic_v1"  // constant for 6D
```

### 5.4 Deterministic Checks Storage

```json
{
  "cleanedContentNonEmpty": true,
  "wordCount": 1250,
  "headingCount": 8,
  "paragraphCount": 22
}
```

---

## 6. RESOURCE IDENTITY

### 6.1 What Constitutes "Same Resource"

**Primary key**: `canonical_url` (from Phase 5, already normalized)

**Rationale**:
- Canonical URL is the stable identifier across acquisitions
- Content hash changes when page updates; URL stays same
- Phase 5 already produces canonical URLs via deterministic rules

### 6.2 What Constitutes "Changed Resource"

Same `canonical_url` + **different** `content_hash` (Phase 5 `AcquiredPage.contentHash`)

### 6.3 Duplicate Acquisition Prevention

- **URL-level dedup**: `canonical_url` unique per resource row
- **Content-level dedup**: `content_hash` tracked in `verification_records`
- If same URL acquired again with same hash → reuse existing resource + create new verification record
- If same URL acquired again with different hash → update resource + create new verification record (versioning)

---

## 7. VERIFICATION RECORD IDENTITY

### 7.1 When to Create New Verification Record

**Always create a new `verification_records` row** for each 6D execution, because:
- `verified_at` differs (temporal evidence)
- `deterministic_checks` may differ (content changed)
- Historical audit trail is valuable

### 7.2 When to Reuse (Don't)

Do NOT reuse verification records. Each verification is a point-in-time evidence snapshot.

### 7.3 Verification Record Fields Mapping

| VerificationRecord Field | Source |
|-------------------------|--------|
| `resource_id` | From upserted resource |
| `url` | Phase 5 `finalUrl` |
| `canonical_url` | Phase 5 `canonicalUrl` |
| `content_hash` | Phase 5 `contentHash` |
| `http_status` | Phase 5 `statusCode` |
| `page_title` | 6A `metadata.title` |
| `page_metadata` | 6A `metadata` (description, author, datePublished, language) |
| `content_evidence` | 6B `interpreted` (serialized) |
| `fetched_at` | Phase 5 `acquiredAt` |
| `verified_at` | 6C `verifiedAt` |
| `verification_method` | `"deterministic_v1"` |
| `deterministic_checks` | 6C `deterministicChecks` + `advisorySignals` |
| `ai_verified` | `false` |
| `ai_verification_notes` | `null` |
| `human_reviewed` | `false` |
| `expires_at` | `null` |
| `status` | 6C `status` ("verified" or "failed") |

---

## 8. IDEMPOTENCY

### 8.1 Idempotency Keys

| Operation | Key |
|-----------|-----|
| Resource upsert | `canonical_url` (unique constraint via application logic) |
| Verification record insert | Composite: `(resource_id, verified_at)` — always new |
| Resource mapping upsert | `(resource_id, understanding_id)` — DB unique constraint |

### 8.2 Repeated Execution Behavior

| Scenario | Behavior |
|----------|----------|
| First acquisition (verified) | Create resource (draft), create verification_record (verified), create mapping if understanding context |
| Same URL, same content hash | Reuse existing resource (no update), create NEW verification_record |
| Same URL, NEW content hash | UPDATE resource (title, metadata may change), create NEW verification_record |
| Failed verification | Create resource (draft), create verification_record (failed), NO mapping |
| Duplicate mapping | DB unique constraint prevents; 6D uses upsert |

### 8.3 Transaction Boundary

All three operations (resource, verification_record, mapping) in **single database transaction**. If any fails → full rollback.

---

## 9. CONTENT VERSIONING

### 9.1 Canonical URL + Changed Content Hash

| Event | Resource Row | Verification Record | Mapping |
|-------|--------------|---------------------|---------|
| First acquisition | INSERT | INSERT (verified) | UPSERT |
| Re-acquisition, same hash | NO CHANGE | INSERT (verified) | No change |
| Re-acquisition, new hash | UPDATE (title, metadata, wordCount stats) | INSERT (verified/failed) | Preserve existing |

### 9.2 Historical Preservation

- **Verification records are append-only** — full history of every acquisition attempt
- Resource row reflects **latest verified state** (title, metadata from latest successful acquisition)
- Failed verifications do NOT update the resource row (preserve last known good)

### 9.3 Ranking Impact

- Ranking always uses **latest verification's advisory signals**
- Tier can improve or degrade on re-verification
- 6E warm path reads latest resource + latest verification

---

## 10. RESOURCE MAPPING

### 10.1 How Mappings Are Created

**6D creates mappings ONLY when understanding context is explicitly provided.**

Two entry points:
1. **From acquisition job**: `acquisition_jobs.understanding_id` is set → 6D knows target understanding
2. **From admin discovery**: `/api/discover` includes `major_understanding_id` → passed to 6D

### 10.2 Mapping Confidence

| Source | Confidence | Rationale |
|--------|------------|-----------|
| Per-understanding discovery (explicit) | `high` | AI was asked for resources for THIS specific understanding |
| Topic-level discovery (broad) | `medium` | Resource covers topic; may cover multiple understandings |
| Manual admin addition | `medium` | Human selected, but no explicit curriculum alignment validation |

### 10.3 No Curriculum Alignment in 6D

6D does **not** perform curriculum alignment (matching resource content to understanding description). That requires semantic analysis → AI or human → **Phase 6E or later**.

6D only persists the mapping that was **already established upstream** (by discovery call context or job context).

---

## 11. HUMAN REVIEW / PUBLICATION BOUNDARY

### 11.1 Explicit Separation

| Concern | Phase | Owner |
|---------|-------|-------|
| **Verification** (content exists, passes gate) | 6C | Deterministic |
| **Ranking** (deterministic tiering) | 6D | Deterministic |
| **Persistence** (store resource + evidence + mapping) | 6D | Deterministic |
| **Human review** (approve/reject) | Existing admin UI | Human (optional) |
| **Publication** (draft → approved → public) | **6E** | Lifecycle rules |
| **Warm path delivery** (student request → DB lookup) | **6E** | Query logic |

### 11.2 Critical Invariant: No Human Review Required for Delivery

- 6D persists resources as `status: "draft"`
- `verification_records.human_reviewed = false` always
- **6D never reads or writes `resources.status` beyond initial `draft`**
- Downstream (6E) decides: verified + tier_1/2 → auto-approve? Or stay draft until human?
- **This design explicitly leaves publication policy to 6E**

### 11.3 Legacy Conflict: Generation Pipeline Bypasses Queue

Current generation pipeline inserts resources as `status: "approved"` directly. This conflicts with the invariant.

**6D Position**: 6D will always insert as `draft`. The generation pipeline (6E concern) must be updated to use 6D's output and then apply publication policy. **This is a 6E migration concern.**

---

## 12. AI / NETWORK BOUNDARY

| Capability | 6D Usage |
|------------|----------|
| AI calls | **ZERO** — all ranking signals are deterministic |
| Network requests | **ZERO** — all inputs already acquired |
| Web search | **ZERO** |
| External API | **ZERO** |

**Verification**: 6D functions are pure TypeScript functions taking already-produced representations as input.

---

## 13. SCHEMA IMPACT

### 13.1 Preferred: Zero Schema Changes

6D works with **existing schema exactly as-is**.

### 13.2 6E Migration Concerns (If Schema Changes Needed Later)

| Concern | Current State | 6E Resolution |
|---------|---------------|---------------|
| `resources.status` publication lifecycle | Draft/approved/rejected with RLS | Add `publication_state` separate from `review_status`; or use `verified_at` + `tier` for auto-publication rules |
| `verification_records.status` overloaded | pending/verified/failed/expired | Add `verification_generation` or separate `ranking_tier` column |
| No tier column on resources | Not stored | 6E adds `ranking_tier` to resources for fast warm-path queries |
| Generation pipeline bypasses review | Inserts `approved` directly | 6E changes pipeline to use 6D → apply publication policy |

**No 6D schema changes**. All above are 6E responsibilities.

---

## 14. IDEMPOTENCY / FAILURE MATRIX

| Case | Resource | Verification Record | Mapping | Transaction |
|------|----------|---------------------|---------|-------------|
| Verified, first seen | INSERT (draft) | INSERT (verified) | UPSERT (if understanding) | Commit |
| Verified, same URL + hash | No change | INSERT (verified) | No change | Commit |
| Verified, same URL + new hash | UPDATE (metadata) | INSERT (verified) | Preserve | Commit |
| Failed verification | INSERT (draft) | INSERT (failed) | **None** | Commit |
| Failed verification, retry later | Reuse existing draft | INSERT (verified) | UPSERT | Commit |
| Partial failure (mapping fails) | **Rollback all** | **Rollback all** | **Rollback all** | Rollback |
| Duplicate mapping (race) | No change | No change | DB unique constraint → retry/ignore | Retry logic |
| Verification hash mismatch (6C validate) | N/A (throws) | N/A | N/A | N/A (pre-check) |

### 14.1 Failure Handling

- **Pre-flight**: Call `validateVerificationInput()` — throws on hash mismatch before DB
- **Transaction**: Single `supabase.rpc()` or client-side transaction wrapper
- **Partial failure**: Full rollback; caller can retry
- **Verification failed**: Resource still created (draft) so admin can inspect; verification_record shows failed

---

## 15. TEST PLAN

### 15.1 Unit Tests (Pure Functions)

| Test | Description |
|------|-------------|
| `rankResource_tier1_strong` | Has evidence + wordCount≥300 + headings≥2 + domain≥4 → tier_1 |
| `rankResource_tier2_good_evidence` | Has evidence + wordCount≥150 → tier_2 |
| `rankResource_tier2_good_bulk` | wordCount≥500 + domain≥3 → tier_2 |
| `rankResource_tier3_basic` | wordCount≥50 → tier_3 |
| `rankResource_tier4_minimal` | Verified but wordCount<50 → tier_4 |
| `rankResource_excluded_failed` | Verification failed → excluded |
| `rankResource_deterministic` | Same input → same tier (10x) |
| `rankResource_unscored_domain` | Default domainScore=2 works correctly |

### 15.2 Integration Tests (Database)

| Test | Description |
|------|-------------|
| `persist_first_acquisition` | Creates resource + verification + mapping in transaction |
| `persist_duplicate_same_hash` | Reuses resource, adds verification record, no duplicate mapping |
| `persist_duplicate_new_hash` | Updates resource, adds verification record, preserves mapping |
| `persist_failed_verification` | Creates draft resource + failed verification, no mapping |
| `persist_partial_failure_rollback` | Mapping constraint violation → full rollback |
| `persist_idempotent_rerun` | Running 6D twice with same input → 1 resource, 2 verifications, 1 mapping |

### 15.3 Edge Case Tests

| Test | Description |
|------|-------------|
| `content_versioning` | Same URL, 3 acquisitions with different hashes → 1 resource, 3 verifications |
| `unscored_domain_defaults_to_2` | Domain not in domain_scores → treated as score 2 |
| `no_understanding_context` | Resource created without mapping |
| `verifyContent_throws_on_hash_mismatch` | Pre-flight validation catches integrity issues |
| `tier_boundary_wordcount_299_vs_300` | 299→tier_3, 300→tier_1 (with other signals met) |

---

## 16. PHASE BOUNDARY AUDIT

### 16.1 What 6D Does NOT Do (Explicit Negatives)

| Responsibility | Belongs To | 6D Does Not |
|----------------|------------|-------------|
| URL validation, DNS, HTTP fetch | Phase 5 | ❌ Acquire content |
| HTML cleaning, boilerplate removal | Phase 5/6A | ❌ Clean HTML |
| Heading/block/link extraction | Phase 6A | ❌ Extract structure |
| Educational pattern matching | Phase 6B | ❌ Extract evidence |
| Verification gate (wordCount>0) | Phase 6C | ❌ Verify |
| AI web search for resources | Generation/Discover APIs | ❌ Search |
| AI resource classification | Generation/Discover APIs | ❌ Classify |
| Curriculum alignment (resource ↔ understanding) | 6E+ | ❌ Align |
| Publication lifecycle (draft→approved) | 6E | ❌ Publish |
| Expiration/renewal | 6E | ❌ Expire |
| Warm path query logic | 6E | ❌ Serve |

### 16.2 Boundary Enforcement

- 6D imports ONLY types from 5/6A/6B/6C — no functions that perform I/O
- 6D exports pure functions: `rankResource()`, `persistVerifiedResource()`, `createVerificationRecord()`, `upsertResourceMapping()`
- 6D has no `import "@/lib/ai"` or `fetch()` calls

---

## 17. REMAINING DESIGN RISKS

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Generation pipeline bypasses draft** | High | 6E must update pipeline to use 6D + apply publication policy; document as 6E migration |
| **Tier thresholds uncalibrated** | Medium | Start conservative; 6E can adjust based on real data; tiers are explicit not magic |
| **Domain score default (2) may penalize new good sources** | Low | Domain scores are advisory only; 6E can override; unscored domains still rankable at tier_3/4 |
| **Mapping confidence heuristic** | Medium | Document as heuristic; 6E can refine with curriculum alignment |
| **Verification record growth** | Low | Append-only; 6E can add retention policy; index on `resource_id` + `verified_at` |
| **Race condition on resource upsert** | Low | Use `onConflict: "url"` with unique constraint; or advisory lock |
| **RLS: verification_records admin-only** | None | 6D runs with service role (like generation pipeline) — no RLS issue |

---

## 18. FINAL VERDICT

**PHASE 6D DESIGN: READY FOR IMPLEMENTATION**

### Summary

- ✅ Purpose is precise and bounded (ranking + persistence only)
- ✅ Inputs fully specified from locked phases 5/6A/6B/6C
- ✅ Ranking uses deterministic tiering — no arbitrary weights
- ✅ Persistence uses existing schema — zero migrations
- ✅ Resource identity = canonical URL; versioning via content hash
- ✅ Verification records append-only; full audit trail
- ✅ Idempotency defined for all scenarios with transaction boundary
- ✅ Human review / publication explicitly deferred to 6E
- ✅ Zero AI, zero network
- ✅ Phase boundaries audited — no leakage
- ✅ Test plan covers unit, integration, edge cases

### Implementation Order (for 6D implementer)

1. **Types**: `RankingInput`, `ResourceTier`, `PersistenceInput`, `PersistenceResult`
2. **Pure ranking**: `rankResource(input: RankingInput): ResourceTier`
3. **Persistence**: `persistVerifiedResource(input: PersistenceInput): PersistenceResult` (transactional)
4. **Integration**: Wire into acquisition job completion + admin discovery flow
5. **Tests**: All 15.1–15.3 test cases

---

*End of Phase 6D Design Audit*