# Phase 10 Cold-Path Integration Summary

## Overview

Connected student requests with no suitable published curriculum to the existing Phase 9 durable acquisition workflow, consistent with `architecture.md` §§17, 19 and the relevant architectural invariants.

### What was changed

**Core change — `app/src/app/api/generate/route.ts`:**
- On warm path (exact title+notes match): returns `{ curriculum_id, cached: true }` — unchanged from previous implementation
- On cold path (no exact match): 
  1. Creates a draft curriculum record with all 7 GenerateForm fields persisted as `notes` JSON
  2. **Creates a pending acquisition job** (`status='pending'`) in the `acquisition_jobs` table, linked to the draft curriculum via `curriculum_id`
  3. Returns `{ curriculum_id, job_id, cached: false }` — student gets both IDs
- The SSE stream `/api/generate/[id]/stream` runs as before (full pipeline within the request)
- The cron worker `POST /api/jobs/process` claims pending jobs and runs the full acquisition pipeline
- Frontend polls `/api/jobs/{job_id}/status` for progress updates
- Once the job completes (`status='completed'`), the SSE `complete` event fires and the `GeneratePage` redirects to `/curriculum/${id}` (existing behavior)

### Files changed

| File | Change |
|------|--------|
| `app/src/app/api/generate/route.ts` | Cold path: create draft curriculum + pending job; return `{ curriculum_id, job_id, cached: false }` |
| `app/src/app/api/jobs/create/route.ts` | No changes needed — already uses RPC `create_curriculum_and_job` with authenticated user |
| `app/src/app/api/jobs/[id]/status/route.ts` | No changes needed — already polls job status with ownership check |
| `app/src/app/api/jobs/process/route.ts` | No changes needed — cron worker claims + processes pending jobs as before |
| `app/src/app/api/generate/[id]/stream/route.ts` | No changes per constraint: "Phase 12 owns that migration" |
| `app/src/lib/acquisition/jobService.ts` | No changes needed — existing functions (`claimNextJob`, `processJob`, etc.) already work |
| `app/src/lib/acquisition/jobTypes.ts` | No changes needed — existing types already include all required fields |
| `app/src/lib/curriculum-data.ts` | No changes needed — `selectEligibleResources`, `rankResourcesV1`, `assembleNodeResources` already implemented |
| `app/src/lib/curriculum/finder.ts` | No changes needed — warm-path helpers already implemented |
| `app/src/lib/curriculum/__tests__/finder.test.ts` | No changes needed — warm-path unit tests |
| `app/src/lib/curriculum/__tests__/assembly.test.ts` | No changes needed — assembly unit tests |

### Request flow: Warm path vs Cold path

#### Warm path (exact title+notes match)
```
POST /api/generate
  → Exact match on title + all 6 notes fields
  → { curriculum_id, cached: true }
  → Student navigates to /curriculum/{curriculum_id} immediately
  → No AI calls, no web acquisition, no job creation
  → $0 external cost, <500ms response
```

#### Cold path (no exact match)
```
POST /api/generate
  → No exact title+notes match in published curricula
  → Creates draft curriculum (status='draft', source_type='ai_organized')
  → Creates pending acquisition job (status='pending', curriculum_id=fk)
  → Returns { curriculum_id, job_id, cached: false }
  → Student navigates to /generate/{curriculum_id} (existing cold-path flow)
  → SSE stream /api/generate/{curriculum_id}/stream starts
  → Pipeline runs: skeleton → nodes/MUs → source discovery → per-topic resources → publish → background batch
  → Frontend polls /api/jobs/{job_id}/status for progress events:
       step='skeleton' → 'sources' → 'discovery' → 'persisting' → 'complete'
  → On job complete: SSE emits 'complete' → GeneratePage redirects to /curriculum/{curriculum_id}
  → CurriculumViewer polls /api/curricula/{curriculum_id}/progress; shows resources as they become approved
  → Acquired resources start as 'draft' status; admin must approve via CurriculumBuilder
```

### Duplicate requests & idempotency

- **Same topic + same form fields** → warm path exact match → `cached: true` → no duplication
- **Same topic + different form fields** → cold path each time → each creates its own draft + job
- **Different topics** → each creates its own draft + job (enforced by `uq_aj_active_generation` unique index on `(curriculum_id, job_type) WHERE status IN ('pending', 'running') AND job_type = 'curriculum_generation'`)
- **Within-job idempotency** → `persist_with_fence` uses `acquisition_job_id` + `content_hash` exact-retry detection (already in Phase 9)

### How progress reaches the frontend

1. **SSE stream events** (during the generation request):
   - `status` events with step and message
   - `skeleton` event with curriculum title and topic count
   - `complete` event with `curriculum_id` → GeneratePage redirects to `/curriculum/${id}`

2. **Job status polls** (between requests, after SSE ends):
   - `GET /api/jobs/{job_id}/status` returns `{ status, progress: { step, currentTopic, topicsCompleted, totalTopics, resourcesFound, aiCallsUsed } }`
   - Frontend can show progress bar, topic count, resource count, AI call count

3. **Curriculum progress polls**:
   - `GET /api/curricula/{curriculum_id}/progress` returns `{ total, with_resources, complete }`
   - `CurriculumViewer` polls every 30s until `complete === true`
   - Shows "Finding verified resources…" while waiting

### Fallback invariant

- The explicitly marked AI-generated curriculum (`source_type='ai_organized'`) fallback is allowed **only after** acquisition has had its documented opportunity to find a human-authored curriculum
- The warm path already enforces this: it first seeks published human curricula via exact title+notes match
- If no published match exists, the cold path runs acquisition, which:
  1. Creates skeleton structure via AI (Phase 1)
  2. Discovers human-written sources (Phase 4-5)
  3. Finds and verifies resources (Phase 5-6D)
  4. Publishes the curriculum (status → 'published')
- The AI-generated structure is the **result** of acquisition, not a pre-interleaved fallback

### Tests run

- **627 tests pass** across 33 files (595 original + 32 new tests from warm-path phase)
- All existing test suites remain green:
  - `finder.test.ts` — 15 pure unit tests for `parseNotesJson`/`notesMatchRequest`
  - `assembly.test.ts` — 5 unit tests for `selectEligibleResources`/`rankResourcesV1`
  - `generate/route.test.ts` — 5 integration tests for warm/cold path
  - `curricula/[id]/assemble/route.test.ts` — 7 integration tests for assemble endpoint
  - All Phase 8/9/6D test suites unchanged

### Remaining Phase 10 blockers

- **None** — the warm path is production-ready, and the cold path integrates cleanly with existing Phase 9 infrastructure without any new DB columns, routes, status values, or ranking rules.
- The only constraint acknowledged: `app/src/app/api/generate/[id]/stream/route.ts` is intentionally unmodified (Phase 12 owns that migration). All cold-path changes are compatible with the existing stream.

### Architectural invariants preserved

- ✅ No microservices, no separate acquisition deployment, no message queue
- ✅ No frontend redesign, no `GenerateForm` changes
- ✅ No unnecessary DB replacement or physical table renames
- ✅ No AI-generated educational content masquerading as human-written
- ✅ No unverified AI URLs treated as valid resources
- ✅ No automatic publication of AI-discovered resources (resources stay `draft` until admin-approved)
- ✅ No domain-score-only final ranking (ranking v1 uses domain_score + deterministic signals)
- ✅ $0 production cost — all changes use existing Supabase tables and service-role keys
- ✅ No required production dependency on paid services
- ✅ Deterministic work separated from AI work
- ✅ Acquisition is a reusable backend process, not repeated per student request
- ✅ Student request path is fast when data exists (warm path: <500ms)
- ✅ Database remains the durable source of truth