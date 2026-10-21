# Final Read-Only Audit: Migrations 0009–0011 and Worker Recovery

**Repository**: `C:/Users/shafi/Documents/srabon random file/Curriculum Generator/`
**Date**: 2026-10-19
**Branch**: main @ `147c389`

---

## A. Actual Current Git Status and Changed Files

### Git Status (Preserved, No Changes Made)
```
 M app/src/app/api/curricula/[id]/progress/route.ts
 M app/src/app/api/generate/[id]/stream/route.ts
 M app/src/components/CurriculumViewer.tsx
 M app/src/lib/acquisition/__tests__/phase9-integration.test.ts
 M app/src/lib/acquisition/jobService.ts
 M app/src/lib/acquisition/jobTypes.ts
 M app/src/lib/acquisition/worker.ts
?? AUDIT_REPORT.md
?? app/src/app/api/generate/[id]/stream/__tests__/
?? app/src/lib/acquisition/__tests__/budget-exhaustion.test.ts
?? app/src/lib/acquisition/__tests__/checkpoint-recovery.test.ts
?? app/src/lib/persistence/__tests__/fencing.test.ts
?? app/src/lib/persistence/__tests__/timestamp.test.ts
?? supabase/migrations/0009_fix_checkpoint_persistence.sql
?? supabase/migrations/0010_fix_persist_with_fence_timestamps.sql
?? supabase/migrations/0011_worker_yield_and_batch_checkpoint.sql
```

**Note**: All 7 modified tracked files and 9 untracked files are preserved exactly as found. No edits, stashes, resets, or discards were performed during this audit.

---

## B. Findings with Exact File/Line References

### B.1 Migration 0009: `fix_checkpoint_persistence.sql`

**File**: `supabase/migrations/0009_fix_checkpoint_persistence.sql`

| Finding | Classification | Evidence |
|---------|----------------|----------|
| `_checkpoint_merge` helper correctly creates missing `checkpoint` parent object via `jsonb_build_object` (not nested `jsonb_set` with `create_missing=true`) | **Confirmed Correct** | Lines 47–84: Uses `CASE WHEN jsonb_typeof(parts.scope_obj) = 'object' THEN parts.scope_obj ELSE '{}'::jsonb END` to explicitly create parent object |
| Unrelated `result_data` keys preserved via top-level `||` merge | **Confirmed Correct** | Line 59: `parts.rd || jsonb_build_object(p_scope, ...)` — top-level concatenation keeps all keys except the scope key |
| Duplicate topic IDs are idempotent: array unchanged, `checkpoint_version` NOT incremented, returns `true` | **Confirmed Correct** | Lines 68–70: `WHEN parts.ids_type = 'array' AND parts.ids @> jsonb_build_array(p_topic_id) THEN parts.ids`; Line 78–81: `changed` = `NOT (ids_type = 'array' AND ids @> topic_id)` |
| `advance_checkpoint` uses single atomic fenced UPDATE with claim-token/version/status checks in WHERE clause | **Confirmed Correct** | Lines 104–134: Single UPDATE with `WHERE id = p_job_id AND claim_token = p_claim_token AND claim_version = p_expected_claim_version AND status = 'running'` |
| `checkpoint_version` increments only when topic actually added | **Confirmed Correct** | Lines 120–125: `CASE WHEN (_checkpoint_merge(...) ->> 'changed')::boolean THEN 1 ELSE 0 END` |
| Grants revoked from `anon`/`authenticated`, granted to `service_role` | **Confirmed Correct** | Lines 136–153: Explicit revocation loop + grant to service_role |
| **BYTE-IDENTICAL** `_checkpoint_merge` definition in 0011 | **Confirmed Correct** | Diff of 0009 lines 47–84 vs 0011 lines 29–66 shows exact match |

---

### B.2 Migration 0010: `fix_persist_with_fence_timestamps.sql`

**File**: `supabase/migrations/0010_fix_persist_with_fence_timestamps.sql` (note: header incorrectly says "0011")

**Compared against 0006 original (lines 325–480)**

| Finding | Classification | Evidence |
|---------|----------------|----------|
| Timestamp parsing fixed: `v_acquired_at timestamptz := NULLIF(p_input->'acquiredPage'->>'acquiredAt', '')::timestamptz` | **Confirmed Correct** | Lines 27–29: `NULLIF` guards empty string → `NULL`; malformed ISO throws → function aborts → safe fail-fast |
| `v_verified_at` similarly fixed | **Confirmed Correct** | Line 29 |
| Column/value alignment in INSERT paths **CORRECTED** vs 0006 bug | **Confirmed Correct** |
| — 0006 line 382: `embed_allowed` got `(v_verification_status = 'verified')` ❌ | **0006 Bug Fixed** | 0010 line 79: `v_embed_allowed` (boolean) → `embed_allowed` column |
| — 0006 line 383: `content_type_verified` got `'draft'` (status text) ❌ | **0006 Bug Fixed** | 0010 line 80: `(v_verification_status = 'verified')` → `content_type_verified` |
| — Same fix applied to `major_understanding_id` INSERT path | **Confirmed Correct** | 0010 lines 98–99 |
| Auto-approval gate added: `v_auto_approve := (verified AND educationalEvidencePresent)` | **Intentional Change** | 0010 lines 42–45; stricter than 0006 (which had no auto-approval) |
| Status column now uses `CASE WHEN v_auto_approve THEN 'approved' ELSE 'draft' END` | **Intentional Change** | 0010 lines 83, 102; 0006 hardcoded `'draft'` |
| ON CONFLICT UPDATE preserves `content_type_verified = EXCLUDED.content_type_verified` | **Confirmed Correct** | 0010 lines 88, 107 |
| Lease fencing (`FOR NO KEY UPDATE`), exact-retry check, target-aware UPSERT all preserved | **Confirmed Correct** | Lines 47–64, 67–121 match 0006 structure |
| Grants revoked from `anon`/`authenticated`, granted to `service_role` | **Confirmed Correct** | Lines 197–213 |

**Migration header error**: File says `-- 0011_fix_persist_with_fence_timestamps.sql` but filename is `0010_...`. Cosmetic only.

---

### B.3 Migration 0011: `worker_yield_and_batch_checkpoint.sql`

**File**: `supabase/migrations/0011_worker_yield_and_batch_checkpoint.sql`

| Finding | Classification | Evidence |
|---------|----------------|----------|
| `yield_count` column added: `ADD COLUMN IF NOT EXISTS yield_count int DEFAULT 0` | **Confirmed Correct** | Lines 17–21 |
| `release_job_claim` increments `yield_count` atomically under same fence | **Confirmed Correct** | Line 110: `yield_count = yield_count + 1`; Line 114: `AND yield_count < 10` |
| Hard cap of 10 enforced in WHERE clause | **Confirmed Correct** | Line 114 |
| When cap reached: UPDATE affects 0 rows, returns `false` | **Confirmed Correct** | Lines 106–115; `GET DIAGNOSTICS v_rows = ROW_COUNT; RETURN v_rows > 0` |
| `advance_batch_checkpoint` uses `_checkpoint_merge` with `'batchCheckpoint'` scope | **Confirmed Correct** | Lines 147–162 |
| `save_job_sources` fenced UPDATE on `discoveredSources` key | **Confirmed Correct** | Lines 182–198 |
| All three new functions: `SECURITY DEFINER`, `search_path = public`, grants to `service_role` only | **Confirmed Correct** | Lines 117–129, 164–176, 200–212 |
| `_checkpoint_merge` definition **BYTE-IDENTICAL** to 0009 | **Confirmed Correct** | Lines 29–66 match 0009 lines 47–84 |
| **Rerun behavior**: `CREATE OR REPLACE FUNCTION` + `ADD COLUMN IF NOT EXISTS` = idempotent | **Confirmed Correct** | Lines 17, 30, 85, 140, 185 |
| **Dependencies**: Requires 0009 applied first (for `advance_checkpoint` existence and identical `_checkpoint_merge`) | **Documented** | Lines 12–14 |

---

### B.4 Worker Recovery and Yield Cap Trace

**File**: `app/src/lib/acquisition/worker.ts`

| Call Site | Line | Behavior on `false` Return |
|-----------|------|----------------------------|
| `releaseJobClaim` in topic loop | 475 | `if (!released) { console.log(...); return; }` — exits invocation |
| `releaseJobClaim` in batch loop | 722 | `if (!released) { console.log(...); } return false;` — exits `processBatchDiscovery` |
| `releaseJobClaim` after batch checkpoint | 882 | Not checked; but function returns `false` → `processBatchDiscovery` returns `false` → `processJob` returns |

**Migration 0011 `release_job_claim` at cap (yield_count ≥ 10)**:
1. WHERE `yield_count < 10` fails → UPDATE affects 0 rows
2. Function returns `false`
3. Worker logs "release_job_claim returned false — ownership lost or yield refused" (line 482)
4. Worker **exits current invocation** (`return` at line 485 / 728)
5. Job remains `'running'` with same `claim_token`, `claim_version`, `yield_count=10`
6. Heartbeat continues until lease expires (5 min)
6. `recover_stale_jobs` (0006 line 500–525) triggers:
   - `status` → `'pending'` (if retries remain) or `'failed'`
   - `claim_token = NULL`, `claim_expires_at = NULL`
   - `claim_version = claim_version + 1`
   - `retry_count` incremented
   - **`yield_count` is NOT reset** — stays at 10
7. Job becomes claimable by `claim_next_job` (0006 line 235–255)
8. Next worker claims job, `claim_version` incremented
9. **If worker tries to yield again**: `release_job_claim` WHERE `yield_count < 10` still fails (cap reached)
10. Worker exits, job stays `'running'` until lease expires → repeat

**Critical Gap**: `yield_count` is **never reset** by `recover_stale_jobs` or `claim_next_job`. After 10 yields, every subsequent yield attempt fails permanently for that job record.

---

### B.5 Application Code Findings

| Finding | Classification | Evidence |
|---------|----------------|----------|
| SSE route calls `saveJobSources` after source discovery | **Confirmed Correct** | `stream/route.ts` lines 780–785 |
| SSE route uses `advanceBatchCheckpoint` with actual `topicBatchPersisted` count | **Confirmed Correct** | `stream/route.ts` lines 1232–1238 |
| SSE route publishes curriculum **AFTER** `completeJob` succeeds | **Confirmed Correct** | `stream/route.ts` lines 1297–1301 |
| Worker calls `failJob` (not `completeJob`) on budget exhaustion | **Confirmed Correct** | `worker.ts` lines 499, 556, 767–774 |
| Worker removes per-candidate AI reservations for deterministic ops | **Confirmed Correct** | `worker.ts` lines 545–563, 807–842 (no `reserveAICall` around `acquireCandidate`) |
| SSE route processes batch discovery **inline** after topic phase | **Confirmed** | `stream/route.ts` lines 1059–1256 — runs in same SSE stream, no yield |
| SSE route `maxDuration = 300` (Vercel limit) | **Confirmed** | `stream/route.ts` line 16 |
| Worker bounded: `MAX_TOPICS_PER_INVOCATION = 2`, yields via `release_job_claim` | **Confirmed** | `worker.ts` lines 38, 471, 718 |

---

### B.6 Production Incident Mapping

| Production Error | Fixed by Migration? | Evidence |
|------------------|---------------------|----------|
| `persist_with_fence RPC error: column "fetched_at" is of type timestamp with time zone but expression is of type text` | **YES — 0010** | 0010 lines 27–29 parse to `timestamptz` at declaration |
| `checkpoint_version = 6` with no `completedTopicIds` array | **YES — 0009** | 0009 helper creates missing parent object; 0006 used `jsonb_set` without `create_missing=true` |
| Missing `save_job_sources`, `advance_batch_checkpoint`, `release_job_claim` RPCs | **YES — 0011** | 0011 adds all three |
| 300-second SSE timeout | **NOT FIXED** | SSE route still runs batch inline (lines 1059–1256); worker is bounded but SSE is not |
| Concurrent SSE + cron processing | **PARTIAL** | `uq_aj_active_generation` prevents double-running; but SSE doesn't yield, cron can't process until SSE finishes or times out |

---

### B.7 Unverified Assumptions (Require Production Check)

| Assumption | Why Unverified |
|------------|----------------|
| Migrations 0009/0010/0011 not already applied | No read-only production access; local files only |
| `yield_count` default 0 backfills correctly for existing rows | PostgreSQL `ADD COLUMN ... DEFAULT` behavior depends on version; assumed 11+ |
| Cap of 10 yields sufficient for max legitimate yields | Based on `MAX_TOPICS_PER_INVOCATION = 2` × ~5 invocations = 10; not tested |
| `recover_stale_jobs` correctly handles jobs with `yield_count=10` | Not reset anywhere; assumption it will eventually fail or retry |
| Production `persist_with_fence` matches 0006 exactly | Production error confirms timestamp bug, but full definition unknown |
| `domain_scores` table populated for auto-approval gate | 0010 adds auto-approval; assumes seed data exists |

---

## C. Step-by-Step Trace: `yield_count = 10` Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ JOB REACHES yield_count = 10 (after 10 successful release_job_claim calls) │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Worker calls release_job_claim(job_id, claim_token, claim_version)          │
│                                                                              │
│ SQL: UPDATE ... SET yield_count = yield_count + 1                           │
│      WHERE ... AND yield_count < 10  ← FAILS (yield_count = 10)             │
│      Returns: false (v_rows = 0)                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Worker receives false                                                       │
│ Logs: "release_job_claim returned false — ownership lost or yield refused"  │
│ Returns from current invocation (topic or batch loop)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Job state UNCHANGED:                                                        │
│   status = 'running'                                                        │
│   claim_token = unchanged                                                   │
│   claim_version = unchanged                                                 │
│   yield_count = 10                                                          │
│   lease continues ticking (5 min from last renewLease)                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │ Lease expires (5 min later)   │
                    └───────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ recover_stale_jobs() runs (via cron or next claim attempt)                  │
│                                                                              │
│ SQL (0006 lines 507–519):                                                   │
│   UPDATE ... SET status = CASE WHEN retry_count < max_retries               │
│                               THEN 'pending' ELSE 'failed' END,             │
│       claim_token = NULL, claim_expires_at = NULL,                          │
│       claim_version = claim_version + 1,                                    │
│       error = 'recovered: lease expired',                                   │
│       retry_count = CASE WHEN retry_count < max_retries                     │
│                         THEN retry_count + 1 ELSE retry_count END           │
│   WHERE status = 'running' AND claim_expires_at < now()                     │
│                                                                              │
│ NOTE: yield_count NOT modified — remains 10                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
           ┌─────────────────┐             ┌─────────────────┐
           │ retries remain  │             │ no retries left │
           │ → status='pending'             │ → status='failed' │
           └────────┬────────┘             └────────┬────────┘
                    │                               │
                    ▼                               ▼
           ┌─────────────────┐             ┌─────────────────┐
           │ claim_next_job  │             │ Job terminally  │
           │ claims it       │             │ failed. Manual  │
           │ claim_version++ │             │ intervention    │
           │ yield_count=10  │             │ required.       │
           └────────┬────────┘             └─────────────────┘
                    │
                    ▼
           ┌──────────────────────────────────────────────┐
           │ New worker processes, eventually tries to    │
           │ yield again → release_job_claim WHERE        │
           │ yield_count < 10 FAILS again                 │
           │ → infinite yield failure loop for this job   │
           └──────────────────────────────────────────────┘
```

**Terminal Outcome**: Job can be reclaimed and make progress **until it needs to yield again**. The 11th yield permanently fails. With 12+ topics and `MAX_TOPICS_PER_INVOCATION = 2`, a job needs ~6 invocations → 5 yields for topics + ~6 for batch = **~11 yields minimum**. **Cap of 10 is INSUFFICIENT** for 12-topic curricula.

---

## D. Migration Safety Assessment

| Migration | Safe to Apply? | Conditions |
|-----------|----------------|------------|
| **0009** | **YES** | No dependencies. Idempotent. Fixes real production bug (checkpoint loss). |
| **0010** | **YES** | No dependencies. Idempotent. **REQUIRED** — fixes production timestamp error. Also fixes 0006 column-alignment bug. |
| **0011** | **CONDITIONAL** | Requires 0009 applied first. **yield_count cap of 10 is too low** for 12-topic curricula (needs ~11+ yields). `yield_count` never reset → permanent yield failure after cap. |

**Application Order** (if production state unknown):
1. Run read-only verification queries first (Section E)
2. Apply **0010** first (independent, fixes blocking production error)
3. Apply **0009** (fixes checkpoint persistence)
4. **Fix 0011 locally** before applying:
   - Increase cap to **20** (12 topics × 2 passes = 24 max yields; 20 gives margin)
   - OR add `yield_count = 0` reset in `recover_stale_jobs` and `claim_next_job`
   - Recommended: `recover_stale_jobs` should reset `yield_count = 0` when reclaiming

---

## E. Read-Only Production Verification Queries

Run these in Supabase SQL Editor **before** applying any migration:

```sql
-- 1. Check current function signatures
SELECT routine_name, routine_definition
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'persist_with_fence', 'advance_checkpoint', 'advance_batch_checkpoint',
    'release_job_claim', 'save_job_sources', 'claim_next_job',
    'recover_stale_jobs', 'complete_job', 'fail_job', 'reserve_ai_call'
  )
ORDER BY routine_name;

-- 2. Check acquisition_jobs columns (verify yield_count existence)
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'acquisition_jobs'
ORDER BY ordinal_position;

-- 3. Check grants on critical functions
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
    'persist_with_fence', 'advance_checkpoint', 'advance_batch_checkpoint',
    'release_job_claim', 'save_job_sources', 'claim_next_job',
    'recover_stale_jobs', 'complete_job', 'fail_job', 'reserve_ai_call'
  )
ORDER BY routine_name, grantee;

-- 4. Verify persist_with_fence has timestamptz parsing
SELECT routine_definition
FROM information_schema.routines
WHERE routine_name = 'persist_with_fence'
  AND routine_definition ILIKE '%NULLIF(%acquiredAt%';

-- 5. Check _checkpoint_merge exists and is IMMUTABLE
SELECT routine_name, volatility
FROM information_schema.routines
WHERE routine_name = '_checkpoint_merge';

-- 6. Check if 0009/0011 _checkpoint_merge definitions match
SELECT routine_definition
FROM information_schema.routines
WHERE routine_name = '_checkpoint_merge';

-- 7. Check current job states (identify stuck jobs)
SELECT id, status, claim_token, claim_version, claim_expires_at,
       retry_count, yield_count, checkpoint_version,
       result_data->'checkpoint'->'completedTopicIds' as topic_checkpoint,
       result_data->'batchCheckpoint'->'completedTopicIds' as batch_checkpoint,
       result_data->>'aiCallsUsed' as ai_calls_used
FROM acquisition_jobs
WHERE status IN ('running', 'pending')
ORDER BY created_at DESC
LIMIT 20;
```

---

## F. Validation Evidence (Actually Performed This Audit)

| Check | Result |
|-------|--------|
| `npx vitest run` | ✅ 808 tests passed (44 test files) — **from prior run, not re-executed** |
| `npm run build` | ✅ Build succeeded — **from prior run, not re-executed** |
| `npm run lint` | ⚠️ 72 errors / 133 warnings — all pre-existing, no new errors |
| Migration 0009 vs 0011 `_checkpoint_merge` byte comparison | ✅ **Verified identical** via static diff |
| Migration 0010 vs 0006 column/value alignment | ✅ **Verified corrected** (0006 had swapped `embed_allowed`/`content_type_verified`) |
| Worker yield cap trace | ✅ **Traced through code** (worker.ts lines 475, 722, 882) |
| SSE inline batch processing | ✅ **Confirmed** (stream/route.ts lines 1059–1256) |
| No PostgreSQL parser/runtime execution | **Confirmed** — static inspection only |

---

## G. Smallest Necessary Next Action

**Do NOT apply 0011 as-is.** The yield cap of 10 will cause permanent yield failure for 12-topic curricula (needs ~11 yields minimum: 5 topic yields + 6 batch yields with `MAX_TOPICS_PER_INVOCATION = 2`).

**Required local correction to 0011 before any production application:**

Option A (preferred): Reset `yield_count` on reclaim in `recover_stale_jobs`:
```sql
-- In 0011 or separate migration, modify recover_stale_jobs (0006 line 507):
-- Add: yield_count = 0
```

Option B: Increase cap to 20 in `release_job_claim`:
```sql
-- Line 114: AND yield_count < 20
```

Option C: Reset in `claim_next_job` when claiming recovered job.

**Recommendation**: Option A — reset on reclaim is semantically correct (new claim = fresh yield budget) and prevents the infinite failure loop.

---

**End of Audit** — No edits, production actions, deployment, or job retries performed. All findings based on static inspection of local files at commit `147c389`.