# Phase 10 — Warm-Path Curriculum Lookup

**Status:** CLOSED

**Date:** 2026-10-17

## What was done

**Problem:** The warm-path cache check in `generate/route.ts` used a fuzzy `ilike("title", "%normalized%")` substring match, which could return the wrong curriculum (e.g. a request for "Chemistry" could match "Organic Chemistry" or "Biochemistry"). No reliable exact lookup existed without a new DB column (migrations prohibited).

**Solution — smallest correct improvement:**

1. **`app/src/lib/curriculum/finder.ts`** — Added three pure (no-DB) helpers:
   - `CurriculumRequest` interface — canonical identity of a GenerateForm submission (6 form fields, topic is in `title`).
   - `parseNotesJson(notes)` — safely parse `curricula.notes` text; returns null for non-JSON / seed-style free text.
   - `notesMatchRequest(notes, fields)` — exact match of all 6 persisted fields against a request. Pure, never throws.

2. **`app/src/app/api/generate/route.ts`** — Replaced the cache check:
   - **Before:** `ilike("title", "%${normalized}%")` — case-insensitive substring match. Could match wrong curriculum.
   - **After:** 
     - `ilike("title", topic.trim())` — case-insensitive exact match on title only (no `%` wildcards).
     - Loop all published matches; for each, `notesMatchRequest(row.notes, requestFields)`.
     - On first exact title+notes match → `{curriculum_id, cached: true}` (warm path).
     - On no match → proceeds to create new draft (identical to original cold path).

3. **Tests added:**
   - `app/src/lib/curriculum/__tests__/finder.test.ts` — 15 pure unit tests covering `parseNotesJson`/`notesMatchRequest` edge cases.
   - `app/src/app/api/generate/route.test.ts` — 5 integration tests mocking Supabase client:
     - Warm-path hit (identical re-submission → `cached: true`)
     - Cache miss (same title, different grade → `cached: false`, new draft created)
     - Substring title doesn't false-hit (Organic Chemistry ≠ Chemistry)
     - Same-title disambiguation by notes fields
     - HTTP 400 for missing topic

**Results:** 615 tests pass (595 original + 20 new) across 31 files. Zero DB changes, zero migrations, zero touches to `stream/route.ts`, no new infrastructure, no AI calls, no secrets exposed.

## Remaining limitations

- Exact match on all 6 notes fields means a student changing even an optional field (e.g. `added_context`) triggers regeneration instead of cache hit. Correct by design — different request ≠ warm path.
- Two published curricula with *identical* title AND identical notes but different content would be ambiguous; currently returns most recent via `order("created_at", { ascending: false })`. Extremely unlikely in practice.
- Relies on the invariant that `notes` JSON was persisted via `JSON.stringify({grade_level, difficulty, existing_knowledge, learning_goal, time_available, added_context})` at creation time — guaranteed by current `/api/generate` code.

## Next smallest Phase 10 task

The next logical step is to either (a) add an assembly endpoint that finalizes a draft curriculum after warm-path lookup, or (b) introduce an `identity_hash` column via a new migration to enable deterministic exact matching without JSON parse ambiguity. Both require either new API surface or a new DB migration — scope depends on project priority. The warm-path cache itself is now production-ready.