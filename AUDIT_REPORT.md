# Curriculum Generator — Final-Week Read-Only Audit Report

**Date**: 2026-10-19  
**Deadline**: 2026-10-26 (Congressional App Challenge)  
**Repository**: `C:/Users/shafi/Documents/srabon random file/Curriculum Generator/`  
**Branch/Commit**: `main` @ `147c389` ("automatic verification and concurrency fixes")

---

## 1. Actual Repository State

| Metric | Value |
|--------|-------|
| Current branch | `main` |
| HEAD commit | `147c389` |
| Modified tracked files | 7 (matches handoff) |
| Untracked test/migration files | 9 (matches handoff) |
| No local commits contradicting handoff | ✓ Verified |

**Modified tracked files:**
- `app/src/app/api/curricula/[id]/progress/route.ts` — adds `job_status` + `generation_finished` fields
- `app/src/app/api/generate/[id]/stream/route.ts` — uses `advanceBatchCheckpoint` in background batch
- `app/src/components/CurriculumViewer.tsx` — respects `generation_finished`, shows failure UI
- `app/src/lib/acquisition/__tests__/phase9-integration.test.ts` — updated budget expectations (12→32)
- `app/src/lib/acquisition/jobService.ts` — +3 RPC wrappers (`releaseJobClaim`, `saveJobSources`, `advanceBatchCheckpoint`), budget 12→32
- `app/src/lib/acquisition/jobTypes.ts` — `DEFAULT_BUDGET_LIMITS.max_ai_calls: 32`
- `app/src/lib/acquisition/worker.ts` — **major rewrite**: resume detection, source caching, bounded work (2 topics/invocation), separate batch checkpoint, claim release on quota

**Untracked files (new):**
- Tests: `budget-exhaustion.test.ts`, `checkpoint-recovery.test.ts`, `fencing.test.ts`, `timestamp.test.ts`
- Migrations: `0009_fix_checkpoint_persistence.sql`, `0010_fix_persist_with_fence_timestamps.sql`, `0011_worker_yield_and_batch_checkpoint.sql`

---

## 2. Findings

| # | Severity | Classification | Finding | Evidence | Minimum Correction |
|---|----------|----------------|---------|----------|-------------------|
| 1 | **Critical** | Code-verified | **AI budget (32) still insufficient for 12-topic/73-MU curricula**. Worker path: 1 skeleton + 1 sources + 12 topic-discovery + 12 batch-discovery + acquisition/verification calls (1 per candidate) = **38+ calls minimum**. Production job `b3930613...` exhausted 12 calls at old budget; 32 only buys margin for ~8 topics. | `jobTypes.ts:256` (`max_ai_calls: 32`), `worker.ts:549-563` (per-candidate `reserveAICall`), `worker.ts:830-836` (batch per-MU `reserveAICall`), production incident `max_ai_calls exhausted` at 12 | Raise budget to **≥64** or decouple acquisition calls from the shared budget (separate pool for verification). Apply in `jobTypes.ts`, `jobService.ts`, and any migration setting defaults. |
| 2 | **Critical** | Code-verified | **SSE route lacks bounded work and will hit Vercel 300s limit**. It processes all topics sequentially with 15s delays (12 topics × 15s = 180s + AI latency), then runs background batch in same stream. No claim release / yield. Production timeout at 300s confirmed. | `stream/route.ts:1017-1019` (15s delay), `stream/route.ts:1057-1251` (background batch inline), `maxDuration = 300` (line 16) | **P0**: Move SSE background batch to cron worker (like `worker.ts` does). SSE should only do skeleton + topic-level, then return. Requires `release_job_claim` + cron processor. |
| 3 | **High** | Code-verified | **SSE publishes curriculum before batch discovery completes**. `stream/route.ts:1046-1049` updates status to `published` at line 1048, *then* runs background batch. If batch fails or times out, curriculum is public with incomplete resources. Worker correctly publishes only after `completeJob` succeeds (`worker.ts:668-672`). | `stream/route.ts:1046-1052` vs `worker.ts:651-672` | **P0**: Move `status: 'published'` update to after `completeJob` succeeds in SSE route, matching worker. |
| 4 | **High** | Code-verified | **Worker completes job with `hasProgress=true` even on budget exhaustion mid-topic**, potentially marking a partially-done job as `completed` (not `failed`). Budget exhaustion in topic loop calls `completeJob(..., hasProgress)` where `hasProgress` checks *topic* checkpoint only, not batch. | `worker.ts:498-504`, `worker.ts:555-562`, `worker.ts:767-774` | On budget exhaustion, call `failJob` with "budget_exhausted" error so `recover_stale_jobs` can retry with fresh budget (if retry logic supports it) or leave as `failed` for manual intervention. |
| 5 | **High** | Code-verified | **`release_job_claim` has no yield-count guard**. A buggy/malicious worker could yield indefinitely, spinning the job between cron runs without progress. Migration 0011 comment mentions "yield cap reached" but no SQL enforcement exists. | `0011_worker_yield_and_batch_checkpoint.sql:79` (comment only), `worker.ts:475-484` | Add `yield_count` column to `acquisition_jobs` + increment in `release_job_claim`, cap at e.g. 10. |
| 6 | **Medium** | Code-verified | **SSE route does not persist discovered sources** (`saveJobSources`), so a resumed SSE invocation re-spends the source-discovery AI call. Worker does persist (`worker.ts:444-446`). | `stream/route.ts:712-777` (no `saveJobSources` call), `worker.ts:304-325` (jobService wrapper), `0011...sql:162-183` | Call `saveJobSources` after source discovery in SSE route (requires migration 0011 applied). |
| 7 | **Medium** | Code-verified | **`advance_batch_checkpoint` called with `resourcesFound: 0` always** (both SSE and worker). The parameter exists but is never populated with actual count. | `stream/route.ts:1227-1233` (`muRows ? muRows.length : 0` but passes 0), `worker.ts:882-884` (hardcoded 0) | Pass actual `batchPersisted` or `targetMuIds.length` to enable visibility into batch progress. |
| 8 | **Medium** | Code-verified | **`JobResultData.checkpoint` type lacks `batchCheckpoint` scope**. TypeScript reads it via `as { batchCheckpoint?: ... }` but type doesn't declare it. | `jobTypes.ts:43-54` (no `batchCheckpoint`), `worker.ts:714-722` (cast), `stream/route.ts` (not used) | Add `batchCheckpoint?: { completedTopicIds: string[]; updatedAt: string }` to `JobResultData.checkpoint` or use a union. |
| 9 | **Medium** | Test-verified | **Lint fails (72 errors, 133 warnings)** — mostly `@typescript-eslint/no-explicit-any` in test files and phase6-integration. Not blocking build but indicates tech debt. | `npm run lint` output | **P2**: Fix `any` in test mocks; non-blocking for launch. |
| 10 | **Low** | Code-verified | **SSE heartbeat interval (60s) vs lease duration (5 min)** — if heartbeat fails once, 4 min remain; but `ownershipLost` flag stops processing. Worker has same. Acceptable but tight. | `stream/route.ts:459-469`, `worker.ts:249-255`, `jobTypes.ts:263` | Consider 30s heartbeat or 10min lease for margin. |
| 11 | **Low** | Reported, not verified | **Production error: `persistVerifiedResourceWithFence RPC error: column "fetched_at" is of type timestamp with time zone but expression is of type text`**. Migration 0010 fixes this by parsing at declaration with `NULLIF(... )::timestamptz`. Must verify 0010 is applied in production. | Migration `0010...sql:28-29`, production incident log | **P0**: Apply migration 0010 to production Supabase before any generation. |
| 12 | **Low** | Reported, not verified | **Production error: HTTP 403 for Hackster candidate**. Candidate skip is expected behavior (acquisition pipeline handles failures), but 403s should not crash the job. | Production incident log, `worker.ts:571-573` (continues on acquisition failure) | Verify acquisition engine gracefully handles 403 (appears to). No code change needed. |

---

## 3. Migration Assessment

| Migration | Assessment | Rationale |
|-----------|------------|-----------|
| **0009_fix_checkpoint_persistence.sql** | ✅ **Appears safe by static review** | - `_checkpoint_merge` helper correctly creates missing `checkpoint` object via `jsonb_build_object` (not nested `jsonb_set` with `create_missing=true`).<br>- Single atomic `UPDATE` with fenced `WHERE` (claim_token + claim_version + status='running').<br>- `checkpoint_version` increments only when `changed=true` (topic not already in array).<br>- Idempotent: duplicate topic IDs leave array unchanged, version not incremented.<br>- Revokes from `anon`/`authenticated`, grants to `service_role`.<br>- **Caveat**: Must be applied before 0011 (which redefines `_checkpoint_merge` identically). |
| **0010_fix_persist_with_fence_timestamps.sql** | ✅ **Appears safe by static review** | - Parses `acquiredAt`/`verifiedAt` to `timestamptz` at declaration with `NULLIF(..., '')::timestamptz` — fixes the exact production type-mismatch error.<br>- Empty string → `NULL` (no cast error). Malformed ISO → PostgreSQL throws → function aborts → caller treats as persistence failure (candidate skipped, safe fail-fast).<br>- Preserves all prior behavior: lease fencing (`FOR NO KEY UPDATE`), exact-retry via `acquisition_job_id` column, target-aware UPSERT, auto-approval gate, `SECURITY DEFINER`, `search_path=public`, grants.<br>- Revokes from `anon`/`authenticated`, grants to `service_role`.<br>- **Caveat**: Application *must* emit ISO 8601 UTC (`new Date().toISOString()`) — verified in `http.ts` equivalent. |
| **0011_worker_yield_and_batch_checkpoint.sql** | ⚠️ **Needs correction before application** | - `release_job_claim`: missing yield-count guard (Finding #5).<br>- `advance_batch_checkpoint`: correctly uses separate `batchCheckpoint` scope via shared `_checkpoint_merge` (identical to 0009 definition — good).<br>- `save_job_sources`: simple `jsonb_set` on `{discoveredSources}`, fenced — correct.<br>- All three: proper revokes/grants to `service_role` only.<br>- **Dependency**: Requires 0009 applied first (for `advance_checkpoint` and `_checkpoint_merge`).<br>- **Correction needed**: Add `yield_count` column + increment/cap in `release_job_claim`. |

---

## 4. Core User Journey — Verification Status

| Step | Status | Notes |
|------|--------|-------|
| Submit topic (GenerateForm → `/api/generate`) | ✅ **Verified** | Creates curriculum + job, SSE stream starts |
| Create curriculum structure (skeleton → nodes + MUs) | ✅ **Code-supported, unverified in prod** | Both SSE and worker paths implement; worker has resume detection |
| Discover resources (topic-level) | ⚠️ **Broken in SSE** | SSE lacks bounded work → 300s timeout. Worker bounded (2 topics/invocation) but untested in prod. |
| Persist verified resources | ✅ **Code-supported** | `persistWithFence` with lease fencing; migration 0010 fixes timestamp bug |
| Resume interrupted work | ⚠️ **Partial** | Worker: full resume (skeleton skip, source cache, topic + batch checkpoints). SSE: no source cache, no batch checkpoint, no yield → cannot resume cleanly. |
| Complete the job | ⚠️ **Inconsistent** | Worker: only publishes after `completeJob` succeeds. SSE: publishes *before* background batch. |
| Display terminal errors accurately | ✅ **Fixed** | Progress API returns `job_status` + `generation_finished`; Viewer shows "Generation failed" vs "Finding resources…" correctly. |

---

## 5. Verification Results

| Check | Result | Details |
|-------|--------|---------|
| **Unit/integration tests** | ✅ **808 passed** | `npx vitest run` — 44 test files, 1.93s |
| **TypeScript build** | ✅ **Success** | `npm run build` — 3.3s compile, 12/12 pages generated |
| **Lint** | ❌ **72 errors, 133 warnings** | Mostly `@typescript-eslint/no-explicit-any` in test mocks and phase6-integration. No runtime impact. |
| **Test coverage of failure modes** | **Partial** | - Budget exhaustion: tested (`budget-exhaustion.test.ts`)<br>- Checkpoint persistence/resume: tested (`checkpoint-recovery.test.ts`)<br>- Lease fencing: tested (`fencing.test.ts`)<br>- Timestamp handling: tested (`timestamp.test.ts`)<br>- **Missing**: Integration test for SSE→worker handoff, bounded-work yield/resume cycle, concurrent claim race, production RPC execution. All RPCs mocked. |

**Key limitation**: Tests mock Supabase RPCs entirely — no PostgreSQL integration. Migration SQL not exercised.

---

## 6. Minimum Repair Plan for Final Week

### P0 — Prevents safe/reliable core generation or risks incorrect production state

| # | Action | Files/Migrations | Evidence |
|---|--------|------------------|----------|
| **P0-1** | **Apply migration 0010 to production Supabase** (timestamp fix) | `supabase/migrations/0010_fix_persist_with_fence_timestamps.sql` | Production error `column "fetched_at" is of type timestamp with time zone but expression is of type text` |
| **P0-2** | **Apply migration 0009 to production** (checkpoint persistence) | `supabase/migrations/0009_fix_checkpoint_persistence.sql` | Production `checkpoint_version=6` with no `completedTopicIds` array |
| **P0-3** | **Apply migration 0011 to production** (yield + batch checkpoint) *after adding yield_count guard* | `supabase/migrations/0011_worker_yield_and_batch_checkpoint.sql` + new migration for `yield_count` | Worker bounded work requires `release_job_claim`; SSE needs `saveJobSources` |
| **P0-4** | **Raise AI budget to ≥64** (or split budget pools) | `jobTypes.ts:256`, `jobService.ts:67`, any migration setting default | 12-topic curriculum needs 38+ calls; 32 is insufficient |
| **P0-5** | **Move SSE background batch to cron worker** — SSE should only do skeleton + topic-level, then return | `stream/route.ts` (remove lines 1054-1315), ensure cron processor calls `worker.ts` | SSE hits 300s Vercel limit; worker already implements bounded batch |
| **P0-6** | **Move curriculum publish to after `completeJob` succeeds in SSE route** | `stream/route.ts:1046-1049` → after line 1293 | SSE publishes prematurely; worker does it correctly |

### P1 — Necessary for trustworthy user-facing completion and failure handling

| # | Action | Files/Migrations | Evidence |
|---|--------|------------------|----------|
| **P1-1** | **On budget exhaustion, call `failJob` not `completeJob`** | `worker.ts:498-504`, `555-562`, `767-774` | Partial work marked `completed` misleads progress API |
| **P1-2** | **Add `saveJobSources` call in SSE route after source discovery** | `stream/route.ts:774` (after line 773) | Resumed SSE re-spends source AI call |
| **P1-3** | **Fix `advance_batch_checkpoint` `resourcesFound` parameter** | `stream/route.ts:1232`, `worker.ts:883` | Always passes 0; should pass actual count |
| **P1-4** | **Add `batchCheckpoint` to `JobResultData` type** | `jobTypes.ts:49-52` | TypeScript casts violate type safety |

### P2 — Only if time remains and materially affects launch

| # | Action | Files/Migrations | Evidence |
|---|--------|------------------|----------|
| **P2-1** | **Add `yield_count` column + cap in `release_job_claim`** | New migration + `0011...sql:73-91` | Prevents infinite yield loops |
| **P2-2** | **Fix lint errors** (non-blocking) | Various test files | Tech debt; build passes |
| **P2-3** | **Increase lease duration to 10 min or heartbeat to 30s** | `jobTypes.ts:263`, `stream/route.ts:459`, `worker.ts:249` | Margin for network hiccups |

---

## 7. Decision

**Most important blockers:**

1. **Production migrations 0009, 0010, 0011 not applied** — the timestamp bug (0010) and checkpoint loss (0009) are *confirmed production failures*. These must be applied manually via Supabase SQL Editor before any generation attempt.

2. **SSE route will timeout on any curriculum >~8 topics** — the 300s Vercel limit is hard. The worker path is correct but only runs via cron. The SSE path *must* delegate background batch to the worker.

3. **AI budget of 32 is mathematically insufficient** for the target 12-topic/73-MU curricula. Even with all other fixes, generation will fail with `max_ai_calls exhausted`.

**Single next action:**

> **Apply migrations 0009, 0010, and 0011 (with yield_count fix) to production Supabase today.** Then raise `DEFAULT_BUDGET_LIMITS.max_ai_calls` to 64 in code and redeploy. Only after that, refactor SSE to hand off background batch to the cron worker.

Without the migrations, *no* generation can succeed reliably. Without the budget increase, *large* curricula will always fail. Without the SSE→worker handoff, the user-facing generation flow will timeout.

---

**End of Audit** — No implementation performed. All findings based on static code review, local test/build runs, and documented production incident facts.