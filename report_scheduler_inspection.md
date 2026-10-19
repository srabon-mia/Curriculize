# Scheduler Requirement & Configuration Inspection Report

**Repository:** Curriculum Generator
**Date of inspection:** 2026-10-18
**Scope:** Read-only. No files modified, no SQL executed, no DB mutated, no AI credits spent, no deploys.

---

## TL;DR

| Question | Answer |
|----------|--------|
| **Is a scheduler required by the intended architecture?** | **No.** `architecture.md` (§16, §848–850, §1319) explicitly allows *either* "request-triggered processing" or "scheduled claim-and-process" — both are valid, and §1319 lists "Database-based job polling" under "$0-capable" with "No message queue or external scheduler required." However, **stale-job recovery** (`recover_stale_jobs`) and **automated retry** of interrupted jobs can *only* execute via `POST /api/jobs/process`, which has no in-repo trigger. |
| **Is an external scheduler already configured in the repo?** | **No.** No `vercel.json`, no `.github/workflows/`, no `cron.config`/`crontab*`, no `supabase/functions/`, `next.config.ts` is empty `{}`, `package.json` has no scheduled scripts. |
| **Can ordinary guest generation finish without a scheduler?** | **Yes, mostly — but job-state never reaches `completed`.** The SSE stream runs the entire pipeline inline. The in-progress `claimOrFindJob()` fix attempt changes the job-registration behavior (see §3). |
| **What happens if no scheduler calls the worker?** | Stale-job recovery never runs; interrupted/background batches have no recovery; the `acquisition_jobs` table is inert (jobs left `pending`). Student path still works via SSE. |
| **Smallest safe next step?** | See §5. |

---

## 1. Is a scheduler required by the intended architecture?

### Design doc (`architecture.md` — the *target* architecture)

`architecture.md` (dated 2026-09-27, header: **"DESIGN ONLY — no implementation has occurred"**) treats scheduling as **optional**:

- **§16 (Acquisition Jobs), lines 848–850:**
  > "A later processing invocation (triggered by the same request **or a separate scheduled job**) checks the job status, resumes if incomplete, and completes the acquisition."
  >
  > "**Scheduled claim-and-process/retry:** A separate scheduled task (e.g., a cron job in the existing application) **can** claim incomplete jobs by `status = 'pending'` or `status = 'failed'`…" — "can," not "must."

- **§16, lines 852–858 (key invariants):**
  > "The job STATE is durable in PostgreSQL/Supabase."
  > "No separate worker service, Redis, or message queue is required."
  > Concurrency-safe claiming is *required as a capability*, but who performs it (request vs. schedule) is left open.

- **§27 (external dependencies), line 1319:**
  > `| Scheduling | Database-based job polling | No message queue or external scheduler required |`

- **§1176 (Phase 9):** "Processing may be request-triggered **or scheduled**; the DB record is the durable source of truth."

**Conclusion from design doc:** A scheduler is **not** architecturally required. The system is explicitly designed to operate without one: job state lives durably in Supabase, and a later request invocation can resume. Scheduling is presented as an *alternative* for stale-job recovery and retry, not a hard dependency.

### Actual installed code (`worker.ts`, `jobService.ts`, `jobs/process/route.ts`)

The worker code exists and is functional, but it is **only reachable** through `POST /api/jobs/process`:

- `processJob()` (`worker.ts:228`) — the full acquisition pipeline (claim → skeleton → nodes → sources → topic discovery → batch → complete/fail). Calls `claimNextJob`, `reserveAICall`, `persistWithFence`, `advanceCheckpoint`, `completeJob`/`failJob`.
- `claimNextJob()` (`jobService.ts:99`) — calls the `claim_next_job` SQL RPC (atomic `pending → running` with `FOR UPDATE SKIP LOCKED`).
- `recoverStaleJobs()` (`jobService.ts:276`) — calls the `recover_stale_jobs` SQL RPC (returns expired-lease `running` jobs to `pending` or `failed`).

**The only caller of `processJob`/`claimNextJob`:**
- `app/api/jobs/process/route.ts:24` — `await processJob(job);`
- That endpoint requires `CRON_SECRET` validation (`process/route.ts:8-11`).

`claim_next_job` is called **only** from `jobService.ts` (`jobService.ts:102`), which is called **only** from `jobs/process/route.ts:17`. There is **no other caller** anywhere in the codebase (confirmed by grep). The worker and `claim_next_job` are therefore **dead code unless an external scheduler pings the endpoint.**

### What "required" functions are only reachable via the scheduler?

| Function | Called by SSE stream path? | Called by cron worker? |
|----------|---------------------------|----------------------|
| `claim_next_job` | **No** (SSE uses its own `claimOrFindJob`, see §3) | **Yes** |
| `reserve_ai_call` | **No** | **Yes** |
| `persist_with_fence` | **No** (SSE uses TypeScript `persistVerifiedResource`) | **Yes** |
| `recover_stale_jobs` | **No** | **Yes** |
| `advance_checkpoint` | Yes (inline `advanceCheckpoint`, but see §3 for whether it succeeds) | Yes |
| `complete_job` / `fail_job` | Yes (inline wrappers, but see §3) | Yes |

**Net:** `claim_next_job`, `reserve_ai_call`, `persist_with_fence`, and `recover_stale_jobs` are **exclusively cron-path functions**. The SSE path has its own inline wrappers for checkpoint/complete/fail.

---

## 2. Is an external scheduler already configured in the repository?

**No. Verified by exhaustive file-system search:**

| Check | Result | Evidence |
|-------|--------|----------|
| `vercel.json` | **Not present** | `Glob("vercel.json")` → "No files found" |
| `.github/workflows/` | **Not present** | `Glob(".github/**")` → "No files found" |
| `.github/` directory (any) | **Not present** | Same Glob |
| `cron.config.*` / `crontab.*` | **Not present** | grep "cron-job\|cronjob\|crontab" across repo (excluding node_modules) → only matches in `phase12_launch_audit.md` (audit prose), zero config files |
| `supabase/functions/` | **Not present** | `Glob("supabase/functions/**/*")` → "No files found"; `supabase/` dir contains only `migrations/` + `.temp/` |
| Cron expressions (e.g. `0 9 * * *`) | **None in repo** | grep for cron-pattern strings → no matches in source/config |
| `next.config.ts` | Empty `{}` | `next.config.ts:3-5` — no `cron` / `schedule` / `experimental` config. Next.js 16 does not natively support cron; requires third-party integration. |
| `package.json` scripts | No scheduled scripts | Only `dev`, `build`, `start`, `lint`, `seed`. No `cron`, `worker`, or `schedule` script. |
| `supabase/config.toml` / `supabase.json` | **Not present** | `Glob` → "No files found" |
| `cron-job.org` dashboard config | **Not in repo (by definition)** | Cannot be verified from repo. The only mentions of cron are: (a) `phase12_launch_audit.md` (audit report prose, lines 75, 120, 125, 128, 130), (b) code comments in `worker.ts` and `jobService.ts`. No dashboard config file exists. |

### CRON_SECRET environment variable

| File | CRON_SECRET present? |
|------|---------------------|
| `app/.env.local` | **Yes** — `CRON_SECRET=aa259d207c047ccfcfe55df84c6a7c6a73061bf5846998dfc0256dc3aab57360` |
| `app/.env.local.example` | **No** — only lists `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`. Missing `CRON_SECRET`. |

**Compounding issue:** Even if an operator *did* configure a scheduler, the endpoint would return **HTTP 401** in any standard deployment because `.env.local.example` (the template operators copy) omits `CRON_SECRET`. The value exists only in the local `.env.local`.

### The `.claude/settings.local.json` red herring

A grep for "cron" in config-like files matched `.claude/settings.local.json:22`:
```
"Bash(curl -s \"http://localhost:3000/api/cron/scrape?secret=test\")"
```
This is **NOT** a scheduler configuration for the Curriculum Generator. It is a stale permissions allowlist from a **different, unrelated project** (a DSE stocks application — references to `dsestocks.com`, `dsebd.org`, Prisma, `api/stocks/*`, etc. throughout the file). The `/api/cron/scrape` endpoint does not exist anywhere in the Curriculum Generator codebase. This file is workspace cruft, not project configuration.

---

## 3. What exactly happens if no scheduler calls the worker?

There are **two generation paths** in the current (uncommitted, in-progress) code:

### Path A — SSE inline (student-facing, primary): `generate/[id]/page.tsx → stream/route.ts`

This is the path activated when a student submits the `GenerateForm` and no warm-cache match exists.

**Flow (from `stream/route.ts`, lines 219–730):**
1. `claimOrFindJob(curriculumId)` (line 227, def lines 105–173) — attempts to register/reuse a job record.
2. Skeleton generation via AI (`callAI`) → parse JSON → update curriculum (line 265–317).
3. Insert nodes + major understandings (lines 331–354).
4. Source discovery via AI (lines 371–390).
5. Per-topic resource discovery through `discoverVerifiedResource` (Learning Engine) (lines 407–524).
6. Publish curriculum: `curricula.status = 'published'` (line 527–530).
7. Emit `complete` SSE event (line 532).
8. **Background batch** — fire-and-forget async IIFE after stream close (lines 538–676): per-understanding resource discovery via `buildTopicBatchPrompt` + `discoverVerifiedResource`. Calls `advanceCheckpoint` per topic as it goes.
9. After background batch resolves: `completeJob` (if success) or `failJob` (if failure) (lines 684–706).

**Key issue with `claimOrFindJob()` (lines 105–173) — this is an in-progress fix with bugs:**

- If an existing `pending`/`running` job is found → returns that row's `claim_token` (which is **`NULL`** for `pending` jobs, since `claim_next_job` is the only thing that generates a real token, and the SSE path never calls it).
- If no existing job → calls `create_curriculum_and_job` RPC with **`p_owner: null`**. The RPC (`migration 0006:211-232`) calls `_validate_owner(p_owner)` which does `EXISTS(SELECT 1 FROM auth.users WHERE id = NULL)` → **always false** with NULL → returns `{error: 'invalid_owner'}` → `claimOrFindJob` returns `null` → the SSE stream emits an `error` event and closes.
- If a job was somehow created (e.g., by a prior invocation) with `claim_token = NULL` and `status = 'pending'`, then subsequent RPC calls (`advance_checkpoint`, `complete_job`, `fail_job`) all filter on `claim_token = p_claim_token AND status = 'running'`. With `p_claim_token = NULL`:
  - **SQL three-valued logic:** `claim_token = NULL` evaluates to `NULL` (unknown) → **WHERE never matches** → these RPCs are **silent no-ops** (return `false`).
  - Additionally, `status` is `'pending'`, not `'running'`, so the `status = 'running'` filter also fails.

**Consequence if no scheduler is active:**
- Job state never progresses: stays `pending` with `claim_token = NULL`.
- `advance_checkpoint` calls during the background batch (line 658–664) are no-ops — no checkpoint is recorded.
- `complete_job` / `fail_job` at the end (lines 686–700) are no-ops — job never reaches `completed`/`failed`.
- **Stale-job recovery never runs** — `recover_stale_jobs()` is only called from `jobs/process/route.ts` (cron path).

So: **the student-facing generation pipeline runs entirely inline and works** (resources persist via the Learning Engine → `persistVerifiedResource` → TypeScript Supabase client). But **the durable job record is never finalized** — it's left `pending` indefinitely.

### Path B — Cron worker: `jobs/process/route.ts → worker.ts`

This path is **only activated by an external scheduler** calling `POST /api/jobs/process` with the correct `CRON_SECRET`. It:
1. Calls `recoverStaleJobs()` — reclaims expired-lease `running` jobs.
2. Calls `claimNextJob('curriculum_generation')` — atomically claims the oldest `pending` job.
3. Calls `processJob(job)` — runs the full pipeline using `reserveAICall` (budget enforcement), `persistWithFence` (SQL RPC with concurrency fencing), `advanceCheckpoint`, `completeJob`/`failJob`.

**If a scheduler IS active and calls this:** it will find the SSE-created `pending` job (which the SSE stream never finalized) and **claim + re-process it** — causing double-processing (the audit's finding 5.1, still present in this form).

### What fails or becomes unreliable without a scheduler:

| Feature | Works without scheduler? | Consequence without scheduler |
|---------|------------------------|------------------------------|
| Student cold-path generation (skeleton, nodes, resource discovery, publish) | ✅ Yes (inline SSE) | None for the student — they see progress + complete event |
| Resource persistence (via Learning Engine) | ✅ Yes | Resources persist as `draft` |
| `max_ai_calls` budget enforcement | ❌ No (only `reserve_ai_call` in worker.ts enforces it) | SSE path can exceed budget; no hard ceiling |
| Lease-based claiming / concurrency safety | ❌ No | No atomic `pending→running` claim; race window between SSE SELECT and cron claim |
| Stale-job recovery (`recover_stale_jobs`) | ❌ No — only called from cron endpoint | Interrupted jobs (SSE context killed mid-background-batch) are never recovered or retried |
| Checkpoint-based resume of background batch | ❌ No (checkpoint RPC is a no-op with NULL token + pending status) | Background batch that dies after stream close has no resumption |
| Job retry on AI failure | ❌ No — only `recover_stale_jobs` handles retries | Failed jobs are never retried automatically |
| Lease heartbeat / renewal | ❌ No — only worker.ts sets up the 60s heartbeat | No stale detection possible |
| Job status transitions (`pending→running→completed/failed`) | ❌ No (SSE's RPC calls are no-ops due to NULL token) | Jobs stay `pending` forever |

**Note:** These are reliability/durability gaps, not student-facing outages (under the assumption that the SSE stream completes within Vercel's function timeout of `maxDuration = 300s` / 5 minutes — `stream/route.ts:14`).

---

## 4. Which job types need periodic processing or recovery?

From `architecture.md` §16 and the SQL migration `0006_phase9_durable_jobs.sql`:

### Job type: `curriculum_generation`

The only job type currently produced. Created by:
- `POST /api/generate` (student cold path) → creates `curricula` row, **does not** create an `acquisition_jobs` row (generate/route.ts, lines 60–77). The SSE stream's `claimOrFindJob()` creates the job if missing.
- `POST /api/jobs/create` (authenticated) → calls `createJobAndCurriculum()` → `create_curriculum_and_job` RPC → creates both curriculum + job (`status='pending'`).

### Status transitions:

```
pending ──claim_next_job──► running ──complete_job──► completed
                │              ├──fail_job──► failed ──recover_stale_jobs──► pending (retry)
                │              └──(lease expires)──► recover_stale_jobs ──► pending/failed
                └──(reuse by SSE claimOrFindJob)──► running (but claim_token may be NULL — bug)
```

### What needs periodic processing:

1. **`recover_stale_jobs()`** — must run periodically to reclaim `running` jobs whose `claim_expires_at` has passed (lease not renewed). This catches jobs where the worker/SSE stream died mid-processing. Called **only** from `jobs/process/route.ts` (cron endpoint). **No in-repo trigger.**

2. **`claim_next_job`** — claims `pending` jobs. A `pending` job sits idle until either:
   - (a) the cron worker claims it via `jobs/process`, OR
   - (b) a student re-opens the SSE stream (which calls `claimOrFindJob`, but see bug: it reuses without atomic claiming).

3. **Retry of `failed` jobs** — `recover_stale_jobs` returns `running` jobs with expired leases to `pending` (if `retry_count < max_retries`). `pending` jobs are then picked up by the next `claim_next_job`. **Only via cron endpoint.** No `failed`-to-`pending` transition for jobs that failed due to budget exhaustion (those are terminal `failed` unless manually reset).

### Checkpoint-resume logic:

- `advance_checkpoint` (migration 0006:483-498) appends `p_completed_topic_id` to `result_data.checkpoint.completedTopicIds[]`.
- The cron worker (`worker.ts:519`) calls `advanceCheckpoint(job.id, job.claim_token, job.claim_version, nodeId, 0)` with a **real claim token** (because it went through `claim_next_job`).
- The SSE stream (`stream/route.ts:658`) calls `advanceCheckpoint` with `jobRecord.claim_token` which is **`NULL`** for SSE-created jobs → **no-op**.
- **There is NO resume logic** — neither `worker.ts` nor `stream/route.ts` checks `checkpoint.completedTopicIds` to skip already-completed topics. `processJob` (worker.ts:228) always starts from skeleton. The checkpoint is recorded but never used for resumption. This is noted as a gap in the audit (§5.2: "Background per-understanding discovery runs after publish — no UI feedback").

---

## 5. Endpoint, method, auth, and intended schedule

### `POST /api/jobs/process`

- **File:** `app/src/app/api/jobs/process/route.ts:5`
- **HTTP method:** `POST`
- **Auth mechanism:** Bearer token in `Authorization` header — validated against `process.env.CRON_SECRET`:
  ```ts
  const cronSecret = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  ```
  (line 8–11)
- **What it does:**
  1. `recoverStaleJobs()` — reclaims expired lease jobs (line 14)
  2. `claimNextJob('curriculum_generation')` — atomically claims next pending job (line 17)
  3. `processJob(job)` — full pipeline with budget enforcement + fenced persistence (line 24)
  4. Returns `{ processed: 1, jobId: job.id }`
- **Intended schedule:** **Not specified anywhere in the repository.** `architecture.md` §850 says "e.g., a cron job" — an example, not a definition. No cron expression, no frequency, no interval is given in any config file, comment, or doc in the repo.
- **Test file:** `app/src/app/api/jobs/process/route.test.ts` — mocks all deps, tests auth rejection (401) and empty-queue (200, `processed: 0`). Does NOT test happy-path processing (all mocked).

### `GET /api/jobs/[id]/status`

- **File:** `app/src/app/api/jobs/[id]/status/route.ts:5`
- **HTTP method:** `GET`
- **Auth mechanism:** Supabase session auth — requires `user` from `supabase.auth.getUser()` (line 11). **403** if `job.created_by !== user.id` (line 25).
- **Note:** SSE-path jobs have `created_by = NULL` (via `claimOrFindJob` → `create_curriculum_and_job` with `p_owner: null`). This means **SSE-created jobs are inaccessible via this status endpoint** — a 403 for any authenticated student. This is audit finding 5.5 (auth inconsistency). **Unverified** whether this is still the case with the current `claimOrFindJob` code (since `create_curriculum_and_job` with `p_owner: null` returns `invalid_owner` error, the job may not be created at all — see §3).

### Student-facing path (no auth, no scheduler):

| Endpoint | Method | Auth | Trigger |
|----------|--------|------|---------|
| `/api/generate` | POST | None | Student form submit |
| `/api/generate/[id]/stream` | GET (SSE) | None | `generate/[id]/page.tsx` opens EventSource |
| `/api/curricula/[id]/progress` | GET | None (anon) | `CurriculumViewer.tsx` polls every 30s |
| `/curriculum/[id]` | GET (page) | None (anon) | Student navigates after `complete` event |

---

## 6. What remains unverified about the live deployment

| Item | Why unverified | Risk level |
|------|----------------|------------|
| The live Supabase DB has migration 0006 applied (with `_validate_owner`, `create_curriculum_and_job`, `claim_next_job`, etc.) | Cannot inspect live DB; user instructed not to run SQL | High — if 0006 is not applied, `claim_next_job`/job system doesn't exist and the cron endpoint would 500 |
| `claimOrFindJob()`'s `create_curriculum_and_job(p_owner: null)` call succeeds or fails live | Logic analysis says it fails (`_validate_owner(NULL)` → false), but the test mocks it as succeeding (route.test.ts:175) | **High** — if it fails, every cold-path SSE generation errors immediately at job-registration with "Unable to register generation job" |
| Whether SSE-created jobs' `complete_job`/`fail_job` RPC calls are no-ops live | SQL three-valued logic analysis says NULL token → no-op, but untested against live DB | Medium — if true, jobs stay `pending` forever; if a scheduler later runs, double-processing risk |
| Whether any external scheduler (cron-job.org, GitHub Actions, cron, etc.) is configured in the **deployment platform** (Vercel dashboard, Supabase project, cron-job.org account, etc.) | Cannot access external dashboards/accounts; user instructed not to deploy | **Unknown** — this is the single most important unverified item. The repo contains zero scheduler config, but the deployment platform may have a UI-configured cron |
| Whether `.env.local` values (especially `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) are propagated to the deployment platform's environment | Cannot inspect deployment platform env vars | High — `.env.local` is local-only; production platforms use their own env config |
| Whether the uncommitted working-tree changes (to `generate/route.ts`, `stream/route.ts`, `stream/route.test.ts`, `curriculum/[id]/page.tsx`) are intended to be shipped | Git status shows 4 modified files + 2 untracked test files; changes are in-progress | High — these appear to be an attempt to reconcile the SSE/cron split (audit finding 5.1/5.2) but `claimOrFindJob` has the NULL-owner and NULL-claim-token bugs identified above |

---

## 7. Summary of job creation paths and status transitions

### Job creation paths:

| Path | Entry point | Creates job? | Creates curriculum? | Auth |
|------|------------|-------------|---------------------|------|
| Student SSE (cold) | `POST /api/generate` → `GET /generate/[id]/stream` | Yes, but **inside** `claimOrFindJob()` via `create_curriculum_and_job(p_owner: null)` — **likely fails** (invalid_owner) | `generate/route.ts` creates curriculum; `claimOrFindJob` creates **duplicate orphan curriculum** if RPC succeeds | None (guest) |
| Authenticated job API | `POST /api/jobs/create` | Yes, via `createJobAndCurriculum(user.id, ...)` — `p_owner` = real user | Yes (same RPC) | Required (Supabase session) |
| Cron worker | `POST /api/jobs/process` (no creation; **claims** existing) | No — claims via `claim_next_job` | No | `CRON_SECRET` bearer |

### Status transition coverage:

| Transition | SSE path triggers it? | Cron path triggers it? | Notes |
|-----------|---------------------|----------------------|-------|
| `pending → running` | ❌ No | ✅ Yes (via `claim_next_job` RPC) | SSE's `claimOrFindJob` does NOT call `claim_next_job` — leaves job `pending` |
| `running → completed` | ❌ No-op (NULL claim_token) | ✅ Yes (via `complete_job` RPC) | SSE calls `complete_job` but RPC returns false due to NULL token + status≠running |
| `running → failed` | ❌ No-op (NULL claim_token) | ✅ Yes (via `fail_job` RPC) | Same issue |
| `running → pending` (stale recovery) | ❌ No | ✅ Yes (via `recover_stale_jobs` RPC) | Only callable from cron endpoint |
| Checkpoint advancement | ❌ No-op (NULL claim_token) | ✅ Yes (via `advance_checkpoint` RPC) | SSE's checkpoint calls silently fail |

---

## 8. Smallest safe next step

Given the findings, the **smallest safe next step** depends on which path is intended as primary:

### If SSE inline is primary (current apparent intent — student path needs no scheduler):

1. **Fix `claimOrFindJob()` in `stream/route.ts`** so it properly registers a job the cron worker will skip:
   - Either call the atomic `claim_next_job` RPC (instead of SELECT + `create_curriculum_and_job` with `p_owner: null`), OR
   - Do not create an `acquisition_jobs` row at all for the SSE path (per architecture.md §848 "request-triggered processing" — the SSE stream owns generation; the job row is optional), OR
   - Make `create_curriculum_and_job` accept `p_owner: null` (fix the RPC / `_validate_owner` to allow NULL for guest-generated jobs), and ensure `claimOrFindJob` sets `status='running'` + a real `claim_token` so subsequent RPCs succeed and the cron worker's `claim_next_job` skips it via `status != 'pending'`.

2. **Add `CRON_SECRET` to `.env.local.example`** with a comment (so any future scheduler config has the env var it needs).

3. **Verify the fix with a live DB** (read-only): run `POST /api/generate` + open the SSE stream, then `SELECT * FROM acquisition_jobs WHERE curriculum_id = ?` to confirm the job transitions to `running`/`completed` and the cron worker would skip it.

### If cron worker is primary (fallback for when SSE times out):

4. Configure a scheduler (Vervel cron, GitHub Actions scheduled workflow, or cron-job.org) to call `POST /api/jobs/process` with `Authorization: Bearer <CRON_SECRET>`, and add the config to the repo (e.g., a GitHub Actions workflow).

### Recommended minimal verification sequence (read-only, no deploy):

| Step | Action | Tool |
|------|--------|------|
| 1 | Confirm no scheduler config exists | ✅ Done — see §2 |
| 2 | Confirm `claim_next_job`/`processJob` only reachable via cron endpoint | ✅ Done — see §1 |
| 3 | Confirm `.env.local.example` missing `CRON_SECRET` | ✅ Done — see §2 |
| 4 | **TODO (unverified):** Ask the operator: "Is a scheduler configured in the Vercel/Supabase/cron-job.org dashboard?" | — |
| 5 | **TODO (unverified):** Read-only DB query: `SELECT status, claim_token, created_by FROM acquisition_jobs ORDER BY created_at DESC LIMIT 10` to see if any jobs exist and what state they're in | Supabase SQL editor |
| 6 | **TODO (unverified):** Call `POST /api/jobs/process` manually with the `CRON_SECRET` from `.env.local` to see if the worker claims an SSE-created pending job (confirms double-processing risk) | `curl` |

---

*Report prepared from read-only inspection of: `architecture.md`, `phase12_launch_audit.md`, `audit.md`, `app/.env.local`, `app/.env.local.example`, `app/package.json`, `app/next.config.ts`, `app/src/app/api/generate/route.ts`, `app/src/app/api/generate/[id]/stream/route.ts`, `app/src/app/api/generate/[id]/stream/route.test.ts`, `app/src/app/api/generate/[id]/stream/jobLifecycle.test.ts`, `app/src/app/api/jobs/process/route.ts` (+ test), `app/src/app/api/jobs/create/route.ts`, `app/src/app/api/jobs/[id]/status/route.ts`, `app/src/lib/acquisition/worker.ts`, `app/src/lib/acquisition/jobService.ts`, `app/src/lib/acquisition/jobTypes.ts`, `app/src/lib/learningEngine.ts`, `app/src/lib/__tests__/eligibility.test.ts`, `app/src/app/curriculum/[id]/page.tsx`, `app/src/app/generate/[id]/page.tsx`, `supabase/migrations/0006_phase9_durable_jobs.sql`. No files were edited, no SQL executed, no DB mutated, no AI credits spent, no deploys made.*
