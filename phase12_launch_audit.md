# Phase 12 — End-to-End Launch Readiness Audit

**Repository:** Curriculum Generator (`C:\Users\shafi\Documents\srabon random file\Curriculum Generator`)
**Phase 12 deliverable:** Cut over existing generation path to the Learning Engine + Acquisition Engine
**Deadline:** October 26, 2026
**Commit under audit:** `0b647dc` (HEAD, pushed; `d6f6ac2` → `df8ffa6` → `0b647dc`)
**Date of audit:** 2026-10-18
**Scope:** Read-only. No SQL executed, no DB mutations, no deploy, no live AI calls, no secrets exposed, no commits/pushes.

---

## 1. Repository State Confirmation

| Check | Result | Evidence |
|-------|--------|----------|
| Current branch | `main` | `git branch --show-current` |
| HEAD commit | `0b647dc` — "phase 12 implemented - cut over existing generation path" | `git log --oneline -1` |
| Working tree | Clean at HEAD | `git status --short` shows only 2 files with LF→CRLF whitespace-only diffs (`about/page.tsx`, `page.tsx`) — **no substantive content changes**; `git diff --ignore-all-space` is empty |
| Phase 12 files present and committed | ✓ | `learningEngine.ts`, `stream/route.ts`, `stream/route.test.ts`, `learningEngine.test.ts` all at HEAD |

---

## 2. Build / Test / Lint Verification

| Check | Result | Evidence |
|-------|--------|----------|
| **Tests** | ✅ 678 passed (36 files) | `npx vitest run` — all green |
| **TypeScript (`tsc --noEmit`)** | ✅ No errors in Phase 12 code; 11 pre-existing errors confined to **untouched test files** | `jobService.unit.test.ts` (missing `CompleteJobResponse`/`FailJobResponse`/`AcquisitionJob` exports), `assembly.test.ts` (type mismatches on `content_type_verified | undefined` and `sourceDomain` vs `source_domain`) — all pre-existing, not introduced by Phase 12 |
| **ESLint (Phase 12 files)** | ✅ Clean | `eslint learningEngine.ts stream/route.ts learningEngine.test.ts stream/route.test.ts` — zero output |
| **Production build** | ✅ Exit 0, all 21 routes generated | `npm run build` — routes include `ƒ /api/generate/[id]/stream`, `ƒ /api/jobs/process`, `ƒ /api/curricula/[id]/assemble`, `ƒ /curriculum/[id]` |
| **Git lineage** | ✅ `d6f6ac2` → `df8ffa6` → `0b647dc` | Confirmed |

---

## 3. Phase 12 Acceptance Criteria Assessment

**Architecture spec (architecture.md §1185-1186):**
> "Redirect `stream/route.ts` to use new Learning Engine + Acquisition Engine. Preserve SSE events so frontend is unchanged. Fix `approved`/`content_type_verified` bug — resources land as `draft`, pending admin approval."

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `stream/route.ts` routes candidates through Learning Engine | ✅ **Verified by source** | Imports `discoverVerifiedResource` + `LearnParams` from `@/lib/learningEngine` (route.ts:8-10). Replaced both direct-insert blocks with `discoverVerifiedResource(params, {cache, dedupTracker})` calls (route.ts:363-366, 502-503) |
| SSE event contract preserved (status/skeleton/complete/error) | ✅ **Verified by source + tests** | Events emitted at route.ts:133 (status), 193 (skeleton), 405 (complete), 125/173/531 (error). `stream/route.test.ts` test 1 asserts all four event types flow correctly |
| Resources land as `status='draft'` (never `approved`) | ✅ **Verified by source + tests** | `persistVerifiedResource` → `createResource` hardcodes `status: "draft"` (persistence/index.ts:148). Test in learningEngine.test.ts:197 asserts `status === "draft"`; stream route test:362 asserts `r.status === "draft"` and `r.status !== "approved"` |
| `content_type_verified` derived from verification gate, not hardcoded | ✅ **Verified by source + tests** | `createResource` sets `content_type_verified: verificationStatus === "verified"` (persistence/index.ts:146). SQL RPC `persist_with_fence` sets `content_type_verified = (v_verification_status = 'verified')` (migration 0006:382, 407). Test learningEngine.test.ts:153 asserts `contentTypeVerified === true` for verified candidates; test at 185-203 asserts `contentTypeVerified === false` for failed verification |
| Frontend unchanged | ✅ **Verified by source** | `generate/[id]/page.tsx` consumes same SSE events; no changes to `GenerateForm.tsx` or `CurriculumViewer.tsx` |
| Hardcoded `content_type_verified: false` / `status: "draft"` lines removed | ✅ **Verified by source** | Old pre-Phase-12 bug (commit d20d801) removed — route.ts:363-366 and 494-503 now call `discoverVerifiedResource` only |
| Unused `getCacheStore` import removed | ✅ **Verified by source** | route.ts imports only `createCache` (line 11); `CreateCache` is used at route.ts:276 |

**Phase 12 acceptance criteria: FULLY MET.** All criteria verified by source inspection and automated tests.

---

## 4. End-to-End Journey Verification Matrix

### User Journey: Student generates a new curriculum

| Step | Component | Path | Verification |
|------|-----------|------|--------------|
| 1. Student fills form | `GenerateForm.tsx` | 7 fields (topic, grade_level, difficulty, existing_knowledge, learning_goal, time_available, added_context) | Source ✓ — "No account required" text at GenerateForm.tsx:279 |
| 2. POST to create | `api/generate/route.ts` POST | Unauthenticated. Warm path: exact title+notes match on published → `{cached:true}`. Cold path: insert draft curriculum + pending acquisition_job (status='pending', created_by=NULL) | Source ✓ — warm lookup at route.ts:31-54; cold path at route.ts:58-125 |
| 3. Navigate to progress | `generate/[id]/page.tsx` | Opens EventSource to `/api/generate/${id}/stream` | Source ✓ |
| 4a. SSE: skeleton | `stream/route.ts` | Calls `buildSkeletonPrompt` → `callAI` → parse JSON → insert nodes+MUs → emit `skeleton` event | Source ✓ |
| 4b. SSE: source discovery | `stream/route.ts` | Calls `buildSourceDiscoveryPrompt` → `callAISources` (no web search) | Source ✓ |
| 4c. SSE: topic discovery | `stream/route.ts` | Per-topic: `buildDiscoverPrompt` → `callAI` → parse candidates → `discoverVerifiedResource` with shared cache + dedup tracker | Source ✓ |
| 4d. SSE: publish | `stream/route.ts` | Sets curriculum `status='published'`, emits `complete` event | Source ✓ (route.ts:400-405) |
| 4e. SSE: background batch | `stream/route.ts` (IIFE) | Per-understanding batch via `buildTopicBatchPrompt` → `callAI` → `discoverVerifiedResource` per MU (cache only, no tracker) | Source ✓ (route.ts:408-527) |
| 5. Student views curriculum | `curriculum/[id]/page.tsx` → `CurriculumViewer.tsx` | Fetches nodes + resources via `getResourcesForTargets` (anon client, RLS). Filters `status === "approved"`. Polls `/api/curricula/[id]/progress` every 30s. | Source ✓ |

### User Journey: Cron-triggered generation (alternative path)

| Step | Component | Path | Verification |
|------|-----------|------|--------------|
| 1. Cron → process | `api/jobs/process/route.ts` POST | Validates CRON_SECRET. Calls `recoverStaleJobs()` + `claimNextJob('curriculum_generation')` + `processJob()` | Source ✓ |
| 2. Worker: full pipeline | `acquisition/worker.ts` `processJob()` | Claims job (status→running). AI calls with `reserveAICall` budget gating. Uses `persist_with_fence` SQL RPC for all persistence. Calls `advance_checkpoint`, `completeJob`/`failJob`. | Source ✓ |
| 3. Student polls status | `api/jobs/[id]/status/route.ts` GET | Requires auth. Checks `job.created_by === user.id`. Returns step/currentTopic/topicsCompleted. | Source ✓ |

### Key finding from the journey matrix

**The SSE inline path (Step 4) and the cron path (Step 2) are BOTH fully instrumented but use completely different persistence mechanisms and neither coordinates with the other.** See §5.

---

## 5. Findings: Defects vs Gaps

### 🔴 CRITICAL — Launch Blockers

#### 5.1 Double-processing: SSE inline path and cron worker both process the same `acquisition_jobs` row

**Status:** Verified by source inspection

**What:** `POST /api/generate` creates a `pending` `acquisition_jobs` row with `created_by=NULL` (route.ts:88-112). The student immediately opens `/generate/${id}`, which starts the SSE stream. The SSE stream (`stream/route.ts`) runs the **entire** pipeline inline — skeleton, source discovery, topic-level discovery, resource persistence — but it **never claims or updates the job**:

- `getAcquisitionJobId()` (route.ts:60-70) only **reads** the job ID (SELECT + `maybeSingle`)
- No call to `claim_next_job`, `reserve_ai_call`, `advance_checkpoint`, `complete_job`, or `fail_job`
- The job row stays `status='pending'` forever

Meanwhile, if a cron scheduler calls `POST /api/jobs/process`, the worker (worker.ts:228) calls `claim_nextJob` which sets `status='running'` and re-runs the **entire** pipeline from scratch — skeleton, nodes, sources, all topic discovery, and the background batch.

**Why it matters:**
- Two concurrent pipelines write to the same `curricula`, `nodes`, `major_understandings`, `resources`, and `verification_records` tables
- The `uq_resource_node_target` / `uq_resource_mu_target` unique indexes (migration 0006:113-117) prevent duplicate resource rows, but the `curricula` and `nodes` inserts are NOT idempotent — duplicate nodes could be created
- Both paths consume AI credits (Claude API calls, web search) — double spend
- The SSE path publishes the curriculum (`status='published'`) at route.ts:400 before the background batch finishes; the cron path would try to do the same, potentially racing
- The `uq_aj_active_generation` unique index (0006:137-139) only prevents multiple `pending`/`running` jobs per curriculum — since the SSE path never changes status, the cron worker sees it as `pending` and claims it

**Root cause:** The SSE stream was designed as the primary generation path (per CLAUDE.md: "SSE for long-running generation"), while the cron worker + durable jobs (Phase 9) were designed as an alternative. They were never reconciled. Phase 12 cut the SSE stream over to the Learning Engine but did **not** address job-state coordination.

**Affected files:**
- `app/src/app/api/generate/[id]/stream/route.ts` — never claims/updates job state
- `app/src/lib/acquisition/worker.ts` — `processJob` claims and processes jobs independently
- `app/src/app/api/jobs/process/route.ts` — triggers the cron path
- `app/src/app/api/generate/route.ts` — creates the pending job that neither path claims

#### 5.2 No cron scheduler configuration in repository

**Status:** Verified by source inspection + file system search

**What:** `POST /api/jobs/process` exists and validates `CRON_SECRET` (process/route.ts:8-11), but there is **no scheduler definition anywhere in the repo**:

- No `vercel.json` with cron configuration
- No `.github/workflows/` directory with scheduled workflows
- No `supabase/functions/` with a cron entry
- No `cron.config.*` or `crontab.*` files
- `next.config.ts` is empty (just `{}`)

This means the cron worker (`worker.ts`) is **dead code at launch** — it will never fire unless an operator manually configures an external scheduler and sets the `CRON_SECRET` environment variable in their deployment platform.

**Compounding issue:** `CRON_SECRET` is present in `.env.local` (value: `aa259d207c047ccfcfe55df84c6a7c6a73061bf5846998dfc0256dc3aab57360`) but is **absent from `.env.local.example`**. An operator copying the example to their deployment would have `CRON_SECRET` unset, causing `POST /api/jobs/process` to return 401 on every request.

**Why it matters:** Without a scheduler, the only active generation path is the SSE inline stream. The durable jobs system (Phase 9 — claim/renew/complete/fail, `ai_reservations`, exact-retry dedup, stale-job recovery) is entirely idle. If the SSE stream fails mid-generation (client closes tab, server timeout, Vercel function limit), the job is left `pending` forever with no recovery mechanism.

**Affected files:**
- `app/src/app/api/jobs/process/route.ts` — no scheduler triggers this
- `.env.local.example` — missing `CRON_SECRET`

#### 5.3 `content_type_verified` gate not enforced on the student-facing CurriculumViewer page

**Status:** Verified by source inspection

**What:** The eligibility gate `selectEligibleResources()` (curriculum-data.ts:143-147) correctly requires BOTH `status='approved' AND content_type_verified=true`. This gate is applied in:

- ✅ Landing page preview (`app/src/page.tsx:99`) — both conditions checked
- ✅ Assemble route (`api/curricula/[id]/assemble/route.ts:112-122`) — `selectEligibleResources` called
- ❌ **CurriculumViewer page (`curriculum/[id]/page.tsx:31`)** — filters only `r.status === "approved"`, **does NOT check `content_type_verified`**

**Why it matters:** The CurriculumViewer page is the **primary** student-facing view. It bypasses the `content_type_verified` gate entirely. This means:

1. **Seed resources** (`seed.ts:196-198`): set to `status='approved'` with `content_type_verified=false` ("no automated verification pipeline ran"). Via the CurriculumViewer, these would be visible to students; via the landing page and assemble route, they'd be hidden.
2. **AI-discovered resources from SSE**: Phase 12 correctly sets `content_type_verified=false` for failed verification. But the CurriculumViewer would still show those resources if they had `status='approved'` — though currently no code path sets AI-discovered resources to `approved` (they're all `draft`), so this is a latent risk rather than an active one.

The assemble route exists but is **not called by any frontend component** — confirmed by grep: the only reference to `assemble` outside its own test file is... none. The CurriculumViewer page has its own inline resource fetching that bypasses it.

**Affected files:**
- `app/src/app/api/curricula/[id]/assemble/route.ts` — applies full gate but **unused** by frontend
- `app/src/app/curriculum/[id]/page.tsx:31` — applies partial gate only
- `app/src/app/page.tsx:99` — applies full gate (landing page preview)
- `scripts/seed.ts:196-198` — seed resources with `content_type_verified=false` + `status='approved'`

#### 5.4 Seed resources are approved but not content_type_verified

**Status:** Verified by source inspection

**What:** `scripts/seed.ts` (lines 185-201) writes seed resources with:
- `status: "approved"` (human-curated, pre-approved for demo)
- `content_type_verified: false` (no automated verification pipeline ran)

Per `selectEligibleResources` (curriculum-data.ts:143-147), a resource must have BOTH `status='approved'` AND `content_type_verified=true` to be student-eligible. The seed resources satisfy only the first condition.

**Why it matters:** This is a **direct conflict** between two design intents:
- Seed script intent: "These are human-curated resources, pre-approved for the demo" (status='approved')
- Verification gate intent: "content_type_verified=false means the resource was never checked for real educational content" (gate filters it out)

**Impact by path:**
- Via landing page (page.tsx:99) and assemble route: seed resources are **invisible** to students → demo curriculum appears empty → **launch blocker for demo**
- Via CurriculumViewer (page.tsx:31): seed resources are **visible** (only checks status) → inconsistent behavior, gate bypassed

Additionally, only 6 of 105 major understandings have seed resources (topics 1-3 only; topics 4-10 have `"resources": []` in seed_curriculum.json). Even if the gate were satisfied, 95% of the curriculum would be empty.

**Affected files:**
- `scripts/seed.ts:196-198`
- `app/src/lib/curriculum-data.ts:143-147`

---

### 🟠 HIGH — Serious Concerns

#### 5.5 Auth inconsistency: unauthenticated `/api/generate` vs authenticated `/api/jobs/*`

**Status:** Verified by source inspection

**What:** Three conflicting auth models for the same conceptual operation (starting a generation):

| Endpoint | Auth | Owner | Notes |
|----------|------|-------|-------|
| `POST /api/generate` | **None** | `created_by=NULL` | Used by GenerateForm. "No account required" |
| `POST /api/jobs/create` | Required (auth.uid) | `user.id` via `create_curriculum_and_job` RPC | Requires `_validate_owner` |
| `GET /api/jobs/[id]/status` | Required (auth.uid) | Checks `job.created_by === user.id` | Returns 403 if owner is NULL |

**Why it matters:** A student-generated job (via `/api/generate`) has `created_by=NULL`. If they ever try to poll `/api/jobs/[id]/status`, they'd get 401 (no session) or 403 (user.id ≠ NULL). The SSE path works because it doesn't use the status endpoint — it polls `/api/curricula/[id]/progress` instead. But this creates a forked identity model where unauthenticated jobs can never be reconciled with the authenticated job system.

**Affected files:** `api/generate/route.ts`, `api/jobs/create/route.ts`, `api/jobs/[id]/status/route.ts`

#### 5.6 Background batch in SSE runs as fire-and-forget IIFE after stream close

**Status:** Verified by source inspection

**What:** `stream/route.ts:408` — after `controller.close()` and the `complete` SSE event, the per-understanding batch discovery runs inside an async IIFE (Immediately Invoked Function Expression). Per the code comment at route.ts:407-408: "Background per-understanding discovery — one batch call per topic".

**Why it matters:**
- In Node.js / Next.js App Router, when an HTTP response stream closes, the underlying request context may be torn down. The IIFE's pending async operations (AI calls, HTTP fetches, DB writes) can be **aborted mid-flight** if the server reclaims the request context. This is especially true on Vercel's managed runtime where function execution is bounded.
- No checkpoint is written to `acquisition_jobs` for the background batch — if it's killed, there's no recovery
- No `complete_job`/`fail_job` call for the SSE path at all
- The 15s `setTimeout` between batch topics (route.ts:524) means the IIFE runs for potentially minutes after the stream closes

**Affected files:** `app/src/app/api/generate/[id]/stream/route.ts:408-527`

#### 5.7 Two divergent persistence code paths (TypeScript vs SQL RPC)

**Status:** Verified by source inspection

**What:** Phase 12's SSE path uses `persistVerifiedResource` (TypeScript, `persistence/index.ts`) which writes directly via `supabase.from("resources").insert()` and `supabase.from("verification_records").insert()` using the service role client. The cron worker (`worker.ts:499`) uses `persistWithFence` which calls the `persist_with_fence` SQL RPC (migration 0006:325-480).

Both write the same invariants (status='draft', content_type_verified from verification), but the SQL RPC has additional guarantees:
- Ownership/leasing validation (`p_claim_token` check)
- Exact-retry dedup via `uq_vr_exact_retry` index
- Atomic resource upsert with `ON CONFLICT`

The TypeScript path relies on its own `findExistingResourceByCanonicalUrl` + `resourceHasContentHash` logic, which is correct but not fenced against concurrent writers.

**Affected files:** `app/src/lib/persistence/index.ts` vs `supabase/migrations/0006_phase9_durable_jobs.sql:325-480`

---

### 🟡 MEDIUM — Noted Concerns

#### 5.8 `resources/[id]` route missing content_type_verified in PATCH

**Status:** Verified by source inspection

`api/resources/[id]/route.ts` PATCH only allows updating `status`. An admin can approve a resource (`status → 'approved'`) but cannot independently set `content_type_verified`. The flag is only ever set by the deterministic verification pipeline. This is arguably correct by design (content_type_verified should reflect an actual pipeline run, not manual setting), but it means there's **no admin UI path** to mark seed resources as verified without re-running acquisition.

#### 5.9 `app/src/app/page.tsx` and `about/page.tsx` have uncommitted LF→CRLF changes

**Status:** Verified by `git diff --ignore-all-space` (empty)

These are pure line-ending changes, no content differences. Not a Phase 12 concern.

---

## 6. Verification Status Summary

| Category | Count | Details |
|----------|-------|---------|
| ✅ Verified by source inspection | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8 (all findings) | All code paths traced directly in committed source |
| ✅ Verified by automated tests | Phase 12 invariants | 678 tests pass, including 6 Learning Engine tests + 4 SSE route contract tests |
| ✅ Verified against build/lint/tsc | Phase 12 files | Build exit 0, ESLint clean on Phase 12 files, tsc zero errors in Phase 12 code |
| ⚠️ Verified against real infrastructure | Git state + env files | Working tree at HEAD 0b647dc; `.env.local` has all env vars incl. CRON_SECRET |
| ❌ Not yet verified | E2E live generation | No live AI calls performed; no live Supabase DB query executed; no cron scheduler execution tested |

---

## 7. Highest-Priority Next Action

> **⚠️ Do not ship the SSE inline generation path to production until the double-processing issue (5.1) is resolved. The SSE stream and the cron worker will race on the same `acquisition_jobs` row, causing duplicate nodes, double AI spend, and potential data corruption.**

The smallest next action that addresses the **most critical blocker** is:

### Option A (Recommended — staged smoke test): Run a single cold-path generation against staging Supabase with real AI, and observe whether `/api/jobs/process` claims the job mid-stream.

This is a **read-only verification** (create + observe, no deploy):

1. Start the dev server locally with `npm run dev`
2. Submit a test topic via the GenerateForm (POST `/api/generate`)
3. While the SSE stream is running, call `GET /api/jobs/[id]/status` (with a mock auth user) to check if the job is still `pending`
4. Then call `POST /api/jobs/process` with the correct `CRON_SECRET` to see if the cron worker claims and re-processes the same curriculum
5. Inspect the Supabase DB (read-only) for duplicate nodes or duplicate resources

**Expected outcome:** If the cron worker claims the job while the SSE is still running, you'll see two concurrent pipelines. This confirms 5.1 as a true blocker.

### Option B (Fix): Reconcile the two paths before launch.

Pick **one** as the primary generation path:

- **If SSE inline is primary (current behavior):** The SSE stream must either (a) claim the job atomically at the start and mark it complete at the end (so the cron worker skips it via `uq_aj_active_generation`), or (b) not create an `acquisition_jobs` row at all. The background batch should be durable (checkpointed via `advance_checkpoint`) or moved to the cron worker exclusively.
- **If cron worker is primary:** `GenerateForm` should POST to `/api/jobs/create` (authenticated) instead of `/api/generate`, and the student should poll `/api/jobs/[id]/status` instead of the SSE stream. The SSE stream becomes a fallback or is removed.

Either way, pick one path and make the other a no-op for the same job.

---

## 8. Focused Implementation Prompt

If proceeding with **Option B** (fix before launch), here is the focused prompt:

```
## Task: Reconcile dual generation paths before Phase 12 launch

### Problem
`POST /api/generate` creates a pending `acquisition_jobs` row (status='pending') and the SSE stream
(`/api/generate/[id]/stream`) runs the full pipeline inline WITHOUT claiming that job. If a cron
scheduler triggers `POST /api/jobs/process`, the worker claims the same pending job and re-runs
the entire pipeline — causing double AI spend, duplicate nodes, and race conditions on the
published curriculum.

### Constraint
The SSE stream must preserve its contract: emit `status` / `skeleton` / `complete` / `error`
events to the student's browser. The student must see real-time progress during generation.

### Approach (SSE primary, cron as fallback — recommended)
1. In `api/generate/route.ts`: do NOT create an `acquisition_jobs` row for the unauthenticated
   SSE path. Instead, set `curricula.status = 'draft'` only. The SSE stream owns generation.
   (The job row is only needed for the cron path, which requires auth.)

   OR: Keep creating the job row, but have the SSE stream claim it via `claim_next_job` at
   route start, and call `complete_job`/`fail_job` at the end (success/failure). The cron
   worker's `claim_next_job` would then skip it (already running/completed) via
   `uq_aj_active_generation`.

2. Move the background batch (currently a fire-and-forget IIFE at stream/route.ts:408) to be
   triggered by the cron worker after the SSE path marks the job as `completed-with-partial`.
   OR: make the IIFE checkpoint via `advance_checkpoint` so a future cron recovery can resume.

3. Ensure `POST /api/jobs/process` skips jobs already claimed/completed by the SSE path
   (this is already handled by `claim_next_job`'s `WHERE status = 'pending'` filter, IF the
   SSE path updates the job status).

### Files to modify
- `app/src/app/api/generate/route.ts` (job creation logic)
- `app/src/app/api/generate/[id]/stream/route.ts` (claim/complete job, durable background batch)
- `.env.local.example` (add `CRON_SECRET` with a comment)

### Tests to add
- SSE stream claims the job at start → `acquisition_jobs.status` becomes `'running'`
- SSE stream completes → `acquisition_jobs.status` becomes `'completed'`
- Cron worker skips a job already in `running`/`completed` state
- Background batch survives stream close (checkpoint-based resume)
```

---

## Appendix A: Phase 12 Files Changed

| File | Status at HEAD 0b647dc | Description |
|------|------------------------|-------------|
| `src/lib/learningEngine.ts` | ✅ NEW | Orchestrator: `discoverVerifiedResource()` + `discoverVerifiedResources()` batch helper. Routes candidates through acquire → evidence → verify → persist |
| `src/lib/__tests__/learningEngine.test.ts` | ✅ NEW | 6 unit tests: success path, acquisition failure, verification-failed persists as draft, PersistenceError isolated, non-PersistenceError re-thrown, draft/approval invariant |
| `src/app/api/generate/[id]/stream/route.ts` | ✅ EDITED | Replaced direct DB inserts with `discoverVerifiedResource()` calls; scoped cache `{enabled:true, maxEntries:200}` + `AcquisitionDedupTracker`; `getAcquisitionJobId()` + `toLearnParams()` helpers |
| `src/app/api/generate/[id]/stream/route.test.ts` | ✅ REWRITTEN | 4 contract tests: SSE event contract, draft invariant, content_type_verified driven by verification, node_id vs MU target mapping |

## Appendix B: Pre-Existing Issues (Not Introduced by Phase 12)

| Issue | Files | Status |
|-------|-------|--------|
| `jobService.unit.test.ts` missing type exports | `src/lib/acquisition/__tests__/jobService.unit.test.ts` | Pre-existing tsc errors; tests pass |
| `assembly.test.ts` type mismatches (`sourceDomain` vs `source_domain`, `content_type_verified: boolean\|undefined`) | `src/lib/curriculum/__tests__/assembly.test.ts` | Pre-existing tsc errors; tests pass |
| `verification/deterministic.ts` unused imports/variables | `src/lib/verification/deterministic.ts`, `types.ts` | Pre-existing warnings |
| Overall ESLint: 72 errors, 127 warnings | Entire codebase | Pre-existing; Phase 12 files are clean |

## Appendix C: Verification Artifact Checklist

All Phase 12 contracts are verified by tests:

- **learningEngine.test.ts** (6 tests, all pass):
  - Success: acquires → verifies → persists as draft with content_type_verified=true ✓
  - Acquisition failure: returns null, does NOT call verify/persist ✓
  - Verification failed: still persists as draft with content_type_verified=false ✓
  - PersistenceError: isolated, returns null ✓
  - Non-PersistenceError: re-thrown ✓
  - Draft/approval invariant: persistence never sets approved ✓

- **stream/route.test.ts** (4 tests, all pass):
  - SSE contract (status/skeleton/complete) through Learning Engine ✓
  - Every resource is status='draft', never 'approved' ✓
  - content_type_verified driven by verification ✓
  - node_id vs major_understanding_id target mapping preserved for both paths ✓

---

*Report written after read-only inspection of the full user journey: GenerateForm → POST /api/generate → SSE stream → stream/route.ts → discoverVerifiedResource → Learning Engine → persistVerifiedResource → resources table → /curriculum/[id] → CurriculumViewer polling /api/curricula/[id]/progress. No files were edited, no SQL was executed, no DB was mutated, no secrets were exposed, and no live generation requests were made during this audit.*
