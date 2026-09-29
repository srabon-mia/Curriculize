# Architecture Document — Curriculum Generator

**Status:** DESIGN ONLY — no implementation has occurred.
**Date:** 2026-09-27
**Based on:** Actual repository inspection, `audit.md`, and the architecture migration map.

---

## 1. Architecture Status

This document describes the **target architecture** for an upcoming rewrite.

- No target architecture has been implemented by this task.
- No source files have been modified.
- No database migrations have been run.
- No new dependencies have been installed.
- The existing application remains fully functional.
- Future implementation will happen incrementally, one phase at a time.
- This document requires human/AI review before implementation begins.

---

## 2. Product Contract — MUST NOT CHANGE

### Student UX (existing, locked)

The student uses the existing `GenerateForm` with these fields:

| Field | Current Type |
|-------|-------------|
| `topic` | text input |
| `grade_level` | select (5 options) |
| `difficulty` | select (3 options) |
| `existing_knowledge` | text input (optional) |
| `learning_goal` | select (5 options) |
| `time_available` | select (5 options) |
| `added_context` | textarea (optional) |

The frontend must not be redesigned as part of architecture work.

### Educational philosophy (locked)

1. Student asks for a topic.
2. System first seeks a human-written curriculum.
3. If found, use/adapt its structure.
4. If not found, AI may generate a curriculum **structure only**.
5. Structure = Curriculum → Units → Understandings.
6. Understandings contain **human-written** educational resources.
7. Resources must come from reliable sources.
8. Resources must be **verified** before being treated as valid.
9. Resources should be ranked by reliability/quality.
10. Unit-wide resources allowed.
11. Practice problems may be added later; if added, must be human-written.
12. AI is NOT the educational content source.
13. AI is an organizational/discovery/extraction/classification/evaluation component.
14. System favors real educational knowledge already on the web.
15. Optimize for FAST student experience + very low/free operating cost.

---

## 3. Architectural Goals

- Modular monolith (no microservices, no separate deployments, no message queues).
- AI behind a provider abstraction (not hardcoded throughout business logic).
- Search and web acquisition behind replaceable abstractions.
- Deterministic work separated from AI work.
- Acquisition is a reusable backend process, not repeated per student request.
- Student request path is fast when data exists.
- Database remains the durable source of truth.
- Existing Supabase foundation retained (auth, RLS).
- Incremental implementation — feature by feature.
- **Production must not fundamentally require a paid AI API.** The AI layer is provider-agnostic (Application → AIProvider → provider implementation). Possible implementations include local/open-weight models, legitimately free inference, optional paid providers for development/testing/fallback. Do NOT assume any student credit program is available. The goal is to minimize AI usage through deterministic preprocessing, deduplication, content hashing, caching, reusable acquisition, and smaller/cheaper models where adequate.

---

## 4. Non-Negotiable Constraints

* No microservices.
* No separate acquisition deployment.
* No message queue for first implementation.
* No frontend redesign.
* No `GenerateForm` changes.
* No unnecessary database replacement.
* No unnecessary physical table renames.
* No AI-generated educational content masquerading as human-written.
* No unverified AI URLs treated as valid resources.
* No automatic publication of AI-discovered resources.
* No domain-score-only final ranking.
* No giant one-pass rewrite.
* No unnecessary dependencies.
* No rebuilding working functionality.

### $0 Production Cost — Hard Architectural Constraint

The available production budget for this project is **$0**. This is a hard architectural constraint, not a preference or optimization target.

The architecture MUST be designed so that the application can operate in production without requiring payment for any external service.

There must be a **genuinely viable $0-cost production path** for the complete system. No required production component may fundamentally depend on a paid service.

**When applying this rule:** if the proposed architecture requires spending money for the production system to function, the architecture is incorrect and must be redesigned.

### No automatic paid fallback

If a free provider reaches a quota, becomes unavailable, or cannot process a request:

1. Use already-persisted verified information.
2. Use cached/acquired results.
3. Defer or queue acquisition when necessary.
4. Gracefully show a loading/unavailable state.
5. Avoid repeated retries or rediscovery.

The system must NEVER silently create a bill because a free dependency stopped being available.

### Cost-minimization through architecture

1. Reuse existing verified database information.
2. Reuse cached acquisition results.
3. Deduplicate URLs/content.
4. Avoid unnecessary web requests.
5. Perform deterministic processing before AI.
6. Avoid AI when deterministic processing is sufficient.
7. Persist extracted and verified information.
8. Reuse information across students.
9. Batch work where appropriate.
10. Bound searches, candidates, fetches, retries, and AI calls.
11. Only invoke semantic AI reasoning when genuinely necessary.

### AI-call minimization (architectural invariant)

**AI calls are an expensive and slow operation and MUST be minimized.** Every pipeline stage must prefer deterministic logic, existing persisted data, caching, deduplication, content hashing, and reusable acquisition before invoking AI. AI must only be invoked when deterministic methods cannot adequately perform the required operation.

### Warm-path requirement

A student request satisfied by already-verified data must require **$0** in new external AI/search/acquisition cost. The warm path performs only database lookup, assembly, filtering, personalization, and local application work.

### Cold-path requirement

A new topic requiring acquisition must have a **$0-capable acquisition path**. The architecture must not assume paid search APIs, scrapers, or AI models. Acquisition must prioritize direct HTTP, free/legitimate discovery, deterministic extraction, reusable persisted results, and free/local AI.

### Dependency classification

Every external dependency is classified as one of:
- **REQUIRED AND $0-CAPABLE** — must have a viable $0 production path
- **OPTIONAL AND $0-CAPABLE** — can be omitted or replaced with a $0 option
- **OPTIONAL PAID DEVELOPMENT/TESTING ONLY** — must never be required in production

**Required $0-capable dependencies:**
- Database: Supabase free tier (1GB storage, auth, RLS) — sufficient for Phase 1
- AI: Local/open-weight or genuinely free provider — required path must work without paid APIs
- Search: Direct HTTP to educational websites, seed data, deterministic crawling — required path must work without paid search APIs
- Web acquisition: Node.js HTTP fetch (built into runtime) — required path must work without paid browser infrastructure
- Caching: In-memory Map — required path must work without paid caching
- Hosting: Static export / free-tier hosting
- Auth: Supabase free-tier auth
- Monitoring/logging: Console / file logging (no external paid service required)

There must be **NO** required production dependency whose normal operation requires payment.

Optional paid development/testing dependencies (NOT available in production):
- Claude API (development/testing only)
- OpenAI API (development/testing only)
- Paid search APIs (development/testing only)
- Paid browser automation (development/testing only)

---

## 5. Current System Context (Verified from Repository)

### What exists today

**Framework:** Next.js 16.2.9, React 19, TypeScript strict, Tailwind CSS v4.

**Database:** Supabase PostgreSQL with 7 tables:
- `curricula` — title, subject, source_type (`adapted` | `ai_organized`), source_attribution, source_url, status, notes
- `nodes` — curriculum_id, parent_node_id (unused), external_key, title, order_index, claim_statement, exam_weight_pct
- `major_understandings` — node_id, external_key, code, description, order_index
- `resources` — node_id OR major_understanding_id, url, title, source_domain, resource_type, license_status, embed_allowed, content_type_verified (hardcoded true), ai_note, status
- `domain_scores` — domain, score (1-5), category, notes
- `progress` — user_id, node_id, major_understanding_id, status
- `admins` — user_id allowlist

**AI provider:** Anthropic Claude Haiku 4.5 only. `callClaude()` defined inside `stream/route.ts` and near-duplicated in `discover/route.ts`.

**API routes (7 active):**
- `POST /api/generate` — creates draft curriculum, weak cache check
- `GET /api/generate/[id]/stream` — SSE generation pipeline
- `POST /api/discover` — admin-triggered AI resource discovery
- `GET/POST /api/curricula` — CRUD curricula
- `GET /api/curricula/[id]/progress` — MU resource-count check
- `GET/POST /api/resources` — CRUD resources
- `PATCH/DELETE /api/resources/[id]` — update/delete resource
- `GET/POST /api/nodes` — CRUD nodes (ORPHANED — no frontend calls it)

**Frontend pages (6):** landing, login, generate progress, curriculum viewer, admin list, admin detail.

**Components:** GenerateForm, CurriculumViewer, CurriculumBuilder, ResourceCard, AddResourceForm, LogoutButton.

**Seed data:** `seed_curriculum.json` (NYS Regents Chemistry, 10 topics, 104 MUs), `domain_scorelist.json` (14 domains).

### What the current code actually does (verified, not intended)

**The SSE stream route (`stream/route.ts`) does the following:**
1. Calls Claude with web search → curriculum skeleton JSON
2. Calls Claude (no search) → domain list
3. For each topic: calls Claude with web search → resources JSON → **inserts as `approved` with `content_type_verified: true`**
4. Publishes curriculum
5. Fires background batch → per-understanding resources inserted as `draft`

**Critical bug (confirmed in code, not a design flaw):**
Step 3 inserts AI-discovered resources as `approved`, bypassing the admin review queue that the RLS policies and admin UI are built around. This contradicts the product contract ("resources must be verified"). The `content_type_verified` column is hardcoded `true` with no actual verification. This MUST be fixed during implementation.

### Known secrets

`app/.env.local` contains live `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY`. These are referenced in the code but must NOT be reproduced in any document.

---

## 6. Target Architecture

```text
                         EDUCATIONAL WEB
                                |
                                v
                    +------------------------+
                    |   ACQUISITION ENGINE   |
                    |  discovery, acquisition,|
                    |  cleaning, extraction,  |
                    |  verification, ranking, |
                    |  persistence            |
                    +-----------+------------+
                                |
                                v
                    +------------------------+
                    |  EDUCATIONAL DATABASE  |
                    |  curricula, sources,    |
                    |  units, understandings, |
                    |  resources, mappings,   |
                    |  verification metadata, |
                    |  reliability metadata   |
                    +-----------+------------+
                                |
                                v
                    +------------------------+
                    |     LEARNING ENGINE    |
                    |  curriculum lookup,     |
                    |  selection, adaptation, |
                    |  fallback structure,    |
                    |  resource assembly,     |
                    |  future personalization |
                    +-----------+------------+
                                |
                                v
                         STUDENT UX
```

### Infrastructure layer (underneath)

```text
AI provider abstraction
Search provider abstraction
Web acquisition/browser abstraction
Database access
Caching
Logging
Schemas/types
```

### Layer dependency rules (prevents cycles)

| Layer | May depend on | Must NOT depend on |
|-------|--------------|-------------------|
| Infrastructure | nothing below | — |
| Educational Domain | Infrastructure | Acquisition, Learning |
| Acquisition | Infrastructure, Educational Domain | Learning |
| Learning | Infrastructure, Educational Domain, Acquisition | — |
| Frontend/UI | Learning (via HTTP) | all internal layers directly |

---

## 7. Module Boundaries (Proposed New Files)

```
app/src/lib/ai/provider.ts          — AI provider abstraction
app/src/lib/search/provider.ts      — search provider abstraction
app/src/lib/acquisition/
  discovery.ts                      — curriculum discovery
  browser.ts                        — page acquisition + cleaning + verification (single owner for the pipeline stage)
  ranker.ts                         — resource ranking
  persister.ts                      — acquisition → DB persistence
app/src/lib/learning/
  orchestrator.ts                   — generation orchestration
  curriculum-finder.ts              — existing curriculum lookup
app/src/lib/domain/                  — shared domain types
```

**Consolidated responsibility:** The acquisition module (`app/src/lib/acquisition/browser.ts`) owns the full pipeline stage from URL → CleanedPage → VerifiedSource for a single candidate. It does not duplicate the browser/provider abstraction already defined in the infrastructure layer — it consumes the BrowserProvider interface and applies cleaning, extraction, verification, and ranking for one candidate at a time. Do not create separate scraper/verifier/classifier modules that each partially own the same pipeline stage.

These are proposed names only. Exact naming TBD during implementation.

---

## 8. Acquisition Pipeline

```text
DiscoveryCandidate
    ↓
cheap candidate filtering (deterministic)
    ↓
AcquiredPage
    ↓
deterministic validation (all must pass)
    ↓
CleanedPage
    ↓
ExtractedCurriculum / ExtractedResource
    ↓
optional semantic AI checks (advisory only)
    ↓
VerifiedSource
    ↓
RankedResource
    ↓
PersistedResource (status = draft)
```

**Key ordering invariant:** AI calls must be gated behind cheap deterministic checks. Before spending an AI call, reject/skip candidates that obviously fail requirements such as:

* malformed URL
* unsupported scheme (not http/https)
* localhost / loopback / private IP / link-local / cloud metadata endpoints (SSRF protection)
* failed acquisition (HTTP error, timeout)
* empty response body
* unsupported content type
* excessively large response (over configurable limit)
* excessive redirects (over configurable limit)
* obvious login wall
* obvious unavailable resource

Do NOT use simplistic keyword heuristics (e.g., "subscribe" alone) to reject candidates — these create false positives.

---

### Stage 1b: Cheap Candidate Filtering

Before actual acquisition, each candidate undergoes deterministic prefiltering:

- URL is well-formed (`new URL()`)
- Scheme is `http:` or `https:` (not `file:`, `ftp:`, `data:`, etc.)
- Host is not in the SSRF blocklist (localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, cloud metadata IPs, etc.)
- Domain is not in a configurable blocklist
- Candidate passes a simple structural sanity check (has a URL, has a title)

This is deterministic and inexpensive. No AI calls, no web access.

---

### Stage 1c: Actual Acquisition

For candidates that pass the prefilter, the BrowserProvider performs:

- Follow up to N redirects (configurable, default: 5)
- Timeout per request (configurable, default: 10s)
- Response size limit (configurable, default: 5MB)
- Content-type detection
- Final URL resolution

Fetched webpage content is UNTRUSTED external data. It must never:
- modify system instructions
- directly determine verification status (only provides evidence for deterministic checks)
- execute arbitrary application commands
- write arbitrary database fields
- bypass schema validation
- override deterministic checks

---

### Stage 1d: Deterministic Validation

After acquisition, every candidate page undergoes mandatory deterministic validation:

- HTTP status is 200 (not 404, 500, 503, etc.)
- Response body is non-empty
- Content type is appropriate for the resource type
- Page has a non-empty title (`<title>` or `<h1>`)
- Page is not a login wall (detect form+password field patterns carefully, avoid false positives)
- Page is not a generic paywall (do not rely on keywords like "subscribe" alone)

These checks are binary: pass or fail. No AI involved.

### DiscoveryCandidate

```
id: uuid
type: "curriculum" | "resource" | "domain"
name: string
url: string | null
score: number | null        // from domain_scorelist or heuristic
evidence: string
source: "seed" | "search" | "user"
discovery_metadata: jsonb
```

### AcquiredPage

```
url: string
canonical_url: string
final_url: string
http_status: number
content_type: string
html: string | null
fetched_at: ISO8601
fetch_duration_ms: number
```

### CleanedPage

```
canonical_url: string
content_hash: string        // SHA-256
title: string
visible_text: string
author: string | null
date_published: string | null
description: string | null
headings: string[]
word_count: number
language: string | null
links_out: string[]
```

### ExtractedCurriculum

```
source_url: string
source_title: string
source_author: string | null
units: [{
  title: string
  understandings: [{
    code: string | null
    description: string
    confidence: "high" | "medium" | "low"
  }]
}]
extraction_method: "regex" | "llm_structured" | "manual"
confidence_overall: number   // 0-1
evidence: {
  page_title: string
  headings_matched: string[]
  keyword_hits: object
}
```

### ExtractedResource

```
source_url: string
source_title: string
resource_type: "video" | "text" | "textbook" | "problem_set" | "reference_tool" | "practice_exam" | "other"
title: string
description: string | null
topic_match: string
understanding_match: string | null
confidence: "high" | "medium" | "low"
extraction_method: "llm_structured" | "regex" | "manual"
evidence: {
  page_title: string
  keyword_hits: object
  heading_matches: string[]
}
```

### VerifiedSource

```
entity_id: uuid
entity_type: "curriculum" | "resource"
verification_status: "verified" | "needs_review" | "rejected"
deterministic_checks: {
  http_200: boolean
  content_nonempty: boolean
  title_nonempty: boolean
  content_hash_stable: boolean
  url_resolves: boolean
}
ai_checks: {
  educational_content: boolean | null   // advisory only
  author_identified: boolean | null     // advisory only
  topic_relevance: boolean | null       // advisory only
}
authorship_status: "verified" | "likely_human" | "unknown" | "likely_ai" | "rejected"
  // Evidence classification, NOT mathematical proof of authorship.
  // AI may provide an advisory inference, but this must NEVER be the sole basis
  // for declaring a resource human-written. AI cannot reliably detect AI-generated text.
human_reviewed: boolean
verified_at: ISO8601
verification_expires_at: ISO8601
verification_notes: string | null
```

**Invariant:** Deterministic checks MUST all pass before AI checks are consulted. AI checks are advisory. A resource failing deterministic checks is REJECTED regardless of AI results.

### RankedResource

```
resource_id: uuid
domain_score: number          // from domain_scores table — PRIMARY signal in v1
authority_score: number       // 1-5, deterministic signals
relevance_score: number       // 1-5
quality_score: number         // 1-5
final_score: number           // computed from score_breakdown
score_breakdown: {
  domain_score: number,
  authority_score: number,
  relevance_score: number,
  quality_score: number,
  weights: { domain: 0.3, authority: 0.2, relevance: 0.3, quality: 0.2 }
}
ranked_at: ISO8601
ranking_method: "v1"
```

**Ranking v1:** Domain reputation is the primary ranking signal, supplemented by cheap deterministic signals (verification status, HTTPS, author metadata, publication date, resource type, stable URL, content availability, provenance). These are all deterministic — no AI calls. The ranking model is designed to incorporate additional content-level signals in Ranking v2+.

**Ranking v2+ (future extensibility):** May incorporate authority, relevance, educational quality, freshness, stability, content depth, and resource type weighting. But Phase 1 MUST NOT require AI-generated relevance/quality/authority scores. Ranking v1 uses only domain_score + available deterministic signals.

### PersistedResource

Writes to:
- `resources` row (url, title, source_domain, resource_type, license_status, status=`draft`)
- `verification_records` rows (all verification data)
- `resource_mappings` rows (understanding associations)
- `curriculum_sources` row (provenance, if curriculum)

---

## 9. Curriculum Discovery

```text
Topic request
    ↓
existing curriculum lookup (cache + DB)
    ↓
human curriculum candidate discovery
    ↓
acquisition
    ↓
verification
    ↓
structure extraction
    ↓
curriculum persistence
```

### Evidence for human-written curriculum

- Official educational organization domain (`.gov`, `.edu`, known org)
- Domain in `domain_scorelist.json` with `category: 'official_source'`
- Page has recognizable curriculum structure (units with understandings)
- Headings/content match known curriculum patterns
- URL path contains `/curriculum`, `/standards`, `/syllabus`, `/framework`
- Institutional branding, authorship metadata

**What does NOT prove human authorship:**
- Domain extension alone (`.edu` is not proof)
- AI's claim about a source
- A URL that looks plausible

### AI-generated fallback

Must have:
- `source_type = 'ai_generated'`
- `source_url = null`
- `source_attribution = null`

Must NOT:
- Claim a fake human source
- Masquerade as a human-written curriculum
- Be attributed to a human source

---

## 10. Resource Discovery

The current `discover/route.ts` and `stream/route.ts` use Claude web search to find resources. In the new architecture:

1. Discovery produces `DiscoveryCandidate[]`.
2. Each candidate goes through acquisition (fetch → clean → extract → verify → rank → persist).
3. Only verified candidates become `draft` resources.
4. Admin approval still required for public visibility.

The search provider abstraction must be replaceable (e.g., Tavily, Brave, custom crawler, seed data). The current implementation hardcodes Anthropic's `web_search_20250305` tool.

---

## 11. Verification

### Verification flow

```text
AI discovery
    ↓
actual acquisition (HTTP GET)
    ↓
deterministic verification
    ↓
semantic verification (optional AI)
    ↓
ranking
    ↓
DRAFT
    ↓
admin approval
    ↓
PUBLIC
```

### Deterministic checks (all must pass)

- URL well-formed (`new URL()`)
- URL resolves (HTTP, not HEAD alone — HEAD is insufficient)
- Content non-empty
- Content has title
- Content type is appropriate (HTML/text for reading resources)
- Not login-walled (check for login form patterns)
- Not paywalled (check for paywall indicators — carefully, avoid false positives on "subscribe" in non-paywall contexts)

### Semantic checks (AI-assisted, advisory)

- Educational content classification
- Authorship identification
- Topic relevance
- Human-authorship inference

### Edge cases to handle

- JavaScript-heavy pages: may need browser automation, not just HTTP GET
- PDFs: fetch, extract text, verify
- Redirects: follow, verify final URL
- Login walls: detect, flag, skip
- Unavailable pages: 404/500 → reject
- Malformed pages: parse failure → flag for review, don't crash
- Paywall signals: careful detection, avoid false positives
- Missing authorship: flag as `needs_review`, not automatic rejection
- Stale resources: `verification_expires_at` triggers re-verification

---

## 12. Ranking

### Ranking v1 (minimal, no AI calls)

Domain reputation is the PRIMARY ranking signal in Ranking v1, supplemented by cheap deterministic signals where available.

Possible deterministic signals include:
- verification status (`verified` first)
- HTTPS (deterministic: URL scheme)
- author metadata present (deterministic: HTML meta tags)
- publication/update date present (deterministic: meta tags)
- resource type (deterministic: from classification)
- stable URL / canonicalization (deterministic: content hash)
- content availability (deterministic: HTTP 200 + non-empty)
- provenance/source classification (deterministic: `curriculum_sources.source_type`)

Do NOT require AI-generated relevance/quality/authority scores in Ranking v1 merely to make the ranking architecture work.

The ranking architecture is designed to incorporate additional content-level signals in future versions (Ranking v2+), such as:
- authority
- relevance
- educational quality
- freshness
- stability
- content depth
- resource type weighting

But these are future extensibility, not mandatory Ranking v1 AI calls.

### Tie-breaking in Ranking v1

1. `verification_status === "verified"` first
2. More recent `fetched_at`
3. Longer `visible_text`
4. Stable sort (preserve input order)

### Unknown/unscored domains

- Must NOT automatically receive a high-trust score
- Must NOT automatically bypass verification
- Should be treated conservatively in ranking (default score = 2, matching current `domain_scores` default)
- Can remain eligible as candidates if they pass acquisition/verification
- Remain subject to admin approval

Do NOT make `.org`, `.edu`, or any TLD itself proof of reliability. Domain reputation is an input, not the final ranking.

### Explainability

Every ranked resource must include `score_breakdown` explaining why it ranked where it did. A resource scored 5 from `nysed.gov` should explain: "Scored 5 based on domain_scores entry for nysed.gov (category: official_source)."

---

## 13. Provenance

### `curriculum_sources` concept

`curriculum_sources` is the structured provenance authority for the new architecture.

Supports:
- `source_type`: `human_written` | `adapted` | `ai_generated`
- Multiple provenance records per curriculum (DO NOT impose `UNIQUE(curriculum_id)` unless the domain model proves only one can exist)

### Necessary fields

- `curriculum_id` → `curricula`
- `source_type`
- `source_url`
- `source_title`
- `source_author`
- `source_institution`
- `verification_state`
- `structure_match_info`
- `notes`
- timestamps

### Existing provenance fields on `curricula`

The `curricula` table already has `source_type`, `source_attribution`, `source_url` (and a duplicate `source_url` column in the current schema). These are **legacy compatibility fields** — read/display mirrors, or transitional fields populated consistently from the structured `curriculum_sources` data. They must NOT be treated as independent sources of truth. During migration, existing values should be mirrored into `curriculum_sources` and the existing columns kept for backward compatibility with existing curriculum rendering.

Do NOT claim both are independent sources of truth. Do not require a physical table rename. The migration strategy preserves existing data and avoids breaking existing curriculum rendering.

---

## 14. Data Model

### Existing tables (preserve, extend cautiously)

| Table | Status |
|-------|--------|
| `curricula` | KEEP. Add columns? Prefer separate `curriculum_sources` table. |
| `nodes` | KEEP. Semantically "units" but do NOT rename physically. |
| `major_understandings` | KEEP. Semantically "understandings" but do NOT rename physically. |
| `resources` | KEEP. Add: `content_hash`, `canonical_url`. Fix: `content_type_verified` must not be hardcoded. |
| `domain_scores` | KEEP. Input to ranking. |
| `progress` | KEEP. |
| `admins` | KEEP. |

### New tables (REQUIRED NOW)

**`curriculum_sources`** — provenance per curriculum.

**`resource_mappings`** — many-to-many resource ↔ understanding.
- `resource_id` → `resources`
- `understanding_id` → `major_understandings`
- `coverage_confidence`: `high` | `medium` | `low`
- unique on `(resource_id, understanding_id)`

**`verification_records`** — evidence of verification.
- `resource_id` → `resources`
- `url`, `canonical_url`
- `content_hash` (nullable — failed fetches may not have one)
- `http_status`
- `page_title`
- `page_metadata` (JSONB: author, date, description, etc.)
- `content_evidence` (bounded excerpt, e.g., first 500 chars of visible text for debugging/review)
- `fetched_at`, `verified_at`
- `verification_method`
- `deterministic_checks` (JSONB)
- `ai_verified`, `ai_verification_notes`
- `human_reviewed`
- `expires_at`
- `status`: `pending` | `verified` | `failed` | `expired`
- `notes`

**`acquisition_jobs`** — durable job records (required from the beginning).
- `id`, `curriculum_id` (nullable), `unit_id` (nullable), `understanding_id` (nullable)
- `job_type`
- `status`: `pending` | `running` | `completed` | `failed`
- `input_data` (jsonb)
- `result_data` (jsonb)
- `error` (text)
- `created_at`, `started_at`, `completed_at`
- `retry_count` (smallint)
- `budget_limits` (jsonb: max_candidates, max_fetches, max_ai_calls, max_retries)

The job STATE is durable in PostgreSQL/Supabase. The architecture must NOT depend on an in-memory queue as the source of truth. Serverless/process lifetime may terminate after the response. Job records enable retries, resumption, and scheduled claim-and-process patterns without requiring a separate worker service.

### New tables (CAN WAIT)

- `resource_reliability` — detailed reliability scores (Ranking v2+)
- `acquisition_cache` — persistent cache (Phase 2+; in-memory Map OK for Ranking v1)
- Prerequisites/dependencies table (Phase 3+)

---

## 15. Caching

### Cache layers

| Layer | Key | Invalidation | TTL |
|-------|-----|-------------|-----|
| Search/discovery | `sha256(query)` | Source data changes | 7 days |
| Fetched pages | `canonical_url` | Content hash changes | 30 days |
| Cleaned content | `content_hash` | Page updates | 30 days |
| Extractions | `content_hash` | Content changes | 30 days |
| Verification | `content_hash` | `verification_expires_at` | 30 days |
| AI calls | `sha256(prompt)` + prompt version | Prompt version changes | 7 days |
| Curriculum assembly | `sha256(topic + grade_level + difficulty + existing_knowledge + learning_goal + time_available + added_context)` + resource version | Underlying data changes | 24 hours |

**Important distinction: base curriculum identity vs student-specific assembly.**

**Base curriculum cache** — reusable topic/curriculum identity, based on `topic` (+ grade level where applicable). This is the cacheable "curriculum" unit. When a verified human-written or AI-generated curriculum structure is persisted, it is keyed by base identity and reused across all student requests for the same topic.

**Student-specific assembly** — uses ALL seven GenerateForm fields: `topic`, `grade_level`, `difficulty`, `existing_knowledge`, `learning_goal`, `time_available`, `added_context`. This should ideally be a cheap deterministic/application-level assembly step that selects resources from the pool of verified resources, applies personalization filters, and orders them. It should NOT cause expensive web acquisition simply because student preferences differ — the underlying verified resources are already cached in the DB.

### Cache key versioning

```
resource-extraction:v1:<content-hash>
curriculum-extraction:v1:<content-hash>
resource-verification:v1:<content-hash>
```

### Core principle

NEVER PAY TO REDISCOVER OR REPROCESS INFORMATION THAT HAS ALREADY BEEN ACQUIRED AND IS STILL VALID.

### Important distinction: base curriculum identity vs student assembly

**Base curriculum identity** — based on topic + grade/curriculum level. This is what gets cached as a "curriculum."

**Student-specific assembly** — must account for ALL existing form fields: `topic`, `grade_level`, `difficulty`, `existing_knowledge`, `learning_goal`, `time_available`, `added_context`.

DO NOT create a student assembly cache key that silently ignores these fields. The cache key for assembly must include all inputs that affect output.

### Durability

In-memory cache may be used as an optimization. Database must remain the durable source of truth. Do not treat in-memory cache as durable storage.

---

## 16. Acquisition Jobs

`acquisition_jobs` is REQUIRED in the initial architecture/Phase 1 implementation path. Job STATE must be durable in PostgreSQL/Supabase from the beginning. The architecture must NOT depend on an in-memory queue as the source of truth.

Job records are persisted to `acquisition_jobs` table with status and results. The architecture is compatible with both:

- **Request-triggered processing**: The generation request creates/updates a durable acquisition job record, then returns immediately. The SSE stream provides progress events. A later processing invocation (triggered by the same request or a separate scheduled job) checks the job status, resumes if incomplete, and completes the acquisition. This enables the student path to be fast while acquisition continues in the background.

- **Scheduled claim-and-process/retry**: A separate scheduled task (e.g., a cron job in the existing application) can claim incomplete jobs by `status = 'pending'` or `status = 'failed'`, process them, and update the status. This does not require a separate worker deployment — it can run as a background function within the same application process.

**Key invariants:**
- The job record is the durable source of truth. In-memory state is volatile and may be lost on process restart.
- No separate worker service, Redis, or message queue is required.
- Retries are recorded in `retry_count`; after a configurable limit, the job may be flagged for human review.
- Acquisition results are persisted to `verification_records`, `resource_mappings`, `curriculum_sources`, etc. The DB IS the durable storage.
- **Acquisition job claiming must be concurrency-safe/atomic** (e.g., `UPDATE acquisition_jobs SET status = 'running', started_at = now() WHERE id = ? AND status = 'pending'` with a row-count check). Multiple simultaneous processors must not process the same job.

### Acquisition budgets (bounded behavior)

Every acquisition job has a bounded resource budget. A cold curriculum request must not be able to generate unlimited search queries, candidate URLs, fetch attempts, AI calls, or retries.

Configurable per-job/per-cycle limits include:
- `max_candidates_per_understanding`
- `max_total_candidates_per_job`
- `max_fetch_attempts`
- `max_ai_calls`
- `max_retries`

**`max_ai_calls` is a HARD per-job ceiling, not merely monitoring/telemetry.** A job MUST NOT exceed `max_ai_calls`. Once the ceiling is reached, the job must stop making additional AI calls and follow the existing bounded/failure/review behavior already documented (job status transitions to `failed` or `completed` with partial results, retry logic governed by `retry_count`, human review flagging).

Application-level abuse controls / rate limiting must also prevent unbounded acquisition or AI spending during cold-path generation. Authentication/rate-limit details are implementation-specific, but the architecture must explicitly account for them.

### Processing lifecycle example

1. Student request arrives → SSE stream starts → creation/update of acquisition_job with `status = 'pending'`.
2. The generation backend begins acquisition: `status` → `'running'`, acquisition work proceeds.
3. If the SSE stream ends (process response completes) while acquisition is incomplete: `status` stays `'pending'` or transitions to `'completed'` with partial results persisted.
4. A subsequent request or scheduled job checks `acquisition_jobs`:
   - `status = 'completed'` → verified data already exists, serve from cache/DB.
   - `status = 'pending'` → resume acquisition from where it left off.
   - `status = 'failed'` → optionally retry (up to `retry_count` limit) or flag for review.
5. Once acquisition completes with verified data, the curriculum is assembled and the student receives it through the warm path.

---

## 17. Student Request Path

### Warm path (data exists)

```text
Student request
    ↓
lookup existing verified curriculum/data (cache + DB)
    ↓
assemble
    ↓
return quickly
```

No AI calls. No web discovery. Just DB reads + cache reads.

### Cold path (data missing)

```text
Student request
    ↓
lookup existing verified curriculum/data
    ↓
if unavailable: create/locate durable acquisition job
    ↓
begin acquisition (background)
    ↓
student receives loading/progress state through the existing UX/SSE mechanism
    ↓
acquisition discovers and verifies human-written curriculum/resources
    ↓
persist verified data
    ↓
assemble curriculum
    ↓
return it
```

The student does NOT wait for the full acquisition crawl synchronously. The existing SSE stream (`/api/generate/[id]/stream`) provides progress events to the frontend while acquisition runs in the background.

**Invariant:** If a human-written curriculum cannot be found after acquisition has had a chance to run, then and only then may the system use the explicitly marked AI-generated curriculum structure fallback (`source_type = 'ai_generated'`, `source_url = null`, `source_attribution = null`).

The architecture must NEVER show:
- raw search results as educational resources
- unverified resources
- AI-generated educational content masquerading as human-written content

No new frontend UX is invented. The existing GenerateForm, SSE progress page (`generate/[id]/page.tsx`), and curriculum viewer are preserved.

---

## 18. AI Provider Abstraction

```text
Application
    ↓
AIProvider (interface)
    ↓
+-- local/open-weight implementation ($0 required production path)
+-- free inference provider implementation ($0 required production path)
+-- Claude implementation (OPTIONAL PAID — development/testing only)
+-- future providers
+-- mock/test implementation
```

The AIProvider interface must have a **legitimate $0-capable production implementation**. This is a hard architectural requirement, not an optimization.

The AI provider abstraction must support:
- Structured output (JSON)
- Web search tool (where supported) — OR direct HTTP acquisition
- Retry with exponential backoff on 429
- Model selection
- **Graceful degradation when the provider is unavailable**: use cached/persisted verified data, queue acquisition, show loading state. DO NOT silently switch to a paid provider.

Current `callClaude()` in `stream/route.ts` and near-duplicate in `discover/route.ts` must be extracted into a single `AIProvider` interface. The Claude implementation is OPTIONAL PAID DEVELOPMENT/TESTING ONLY. Production must use a $0-capable implementation.

The goal is NOT to find an "unlimited free AI API." The goal is to architect the system so AI usage is minimized and the provider can be replaced.

Same principle applies to search and web acquisition where practical:

```text
SearchProvider (interface)
    ↓
+-- Anthropic web_search implementation
+-- Tavily implementation (future)
+-- Brave implementation (future)
+-- mock/test implementation

BrowserProvider (interface)
    ↓
+-- HTTP fetch implementation
+-- browser automation implementation (future, for JS-heavy pages)
+-- mock/test implementation
```

---

## 19. Search/Web Acquisition Abstractions

These must be replaceable without changing business logic.

**SearchProvider interface:**
- `search(query, options)` → `DiscoveryCandidate[]`
- Each candidate has: type, name, url, score, evidence, source

**BrowserProvider interface:**
- `acquire(url)` → `AcquiredPage`
- Handles: redirects, content-type detection, error handling
- Does NOT do verification — that's a separate stage

**Current state:** Both are hardcoded in `stream/route.ts` (Anthropic web_search + direct fetch). The architecture must abstract them.

### Dependency classification

| Component | Classification | Notes |
|-----------|---------------|-------|
| Anthropic web_search tool | **OPTIONAL PAID** — development/testing only | Current implementation; must be replaceable with $0 option |
| Direct HTTP fetch (Node.js built-in) | **REQUIRED AND $0-CAPABLE** | No external dependency; built into the runtime |
| Seed data (`seed_curriculum.json`, `domain_scorelist.json`) | **REQUIRED AND $0-CAPABLE** | Already in repository; no external cost |
| Paid search APIs (Tavily, Brave, etc.) | **OPTIONAL PAID** — development/testing only | Not required for $0 production path |
| Paid browser automation (Playwright) | **OPTIONAL PAID** — development/testing only | Not required; HTTP fetch is the $0 path |
| Local/open-weight search model | **OPTIONAL AND $0-CAPABLE** | Future possibility for $0 search |

### Phase 1 browser acquisition implementation

Initial acquisition implementation is conceptually: **HTTP fetch + HTML parsing/cleaning** (e.g., Cheerio/Readability or equivalent). The architecture should support a replaceable acquisition abstraction so a future implementation can use Playwright, another browser automation system, or another fetch mechanism for JavaScript-heavy pages.

However, Playwright or any browser automation dependency is NOT required in Phase 1. For Phase 1, if a page cannot be meaningfully acquired with the basic fetch/clean path:
- mark it as needing review / unsupported acquisition
- do NOT show it to students
- do NOT make the whole acquisition pipeline fail

Do not introduce a browser dependency merely because the architecture anticipates one later.

---

## 20. Security / RLS

Preserve existing RLS policies:
- Published content publicly readable
- Drafts/admin-only for writes
- Progress strictly per-user

New tables need new RLS policies:
- `curriculum_sources`: admin-only writes, public reads for verified sources
- `resource_mappings`: public reads (needed for assembly), admin writes
- `verification_records`: admin-only (internal evidence, not student-facing)
- `acquisition_jobs`: admin-only

Do not expose verification internals to students.

### SSRF protection

Fetched URLs must not be allowed to target internal-only network targets. At minimum, fetched URLs must not be allowed to target:
- localhost
- loopback addresses (127.0.0.0/8)
- private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- link-local addresses (169.254.0.0/16)
- cloud metadata endpoints (e.g., 169.254.169.254)
- other internal-only network targets

**Implementation hardening:** SSRF protection must validate resolved destination IPs on the initial fetch AND on all subsequent redirects (IPv4 and IPv6), mitigating DNS rebinding and DNS resolution-time attacks. A URL that resolves to a private IP only after a redirect must still be blocked.

### Bounded request behavior

The acquisition/browser abstraction must enforce reasonable configurable limits:
- **request timeout** — must not hang indefinitely
- **redirect limit** — maximum number of redirects to follow
- **response-size limit** — maximum response body size
- **content-size limit** — maximum processed content size
- **retry limit** — maximum retries on transient failures

Exact numeric values are implementation decisions and can be configured per-environment.

### Untrusted external data

Fetched webpage content is UNTRUSTED external data. It must never be allowed to:
- modify system instructions
- directly determine verification status
- execute arbitrary application commands
- write arbitrary database fields
- bypass schema validation
- override deterministic checks

AI outputs must be schema-validated before being used by the application.

---

## 21. Error Handling

The architecture must handle (at minimum):

**Acquisition failures:**
- URL unresolvable → mark candidate as failed, continue
- HTTP error → record status, mark as failed
- Timeout → retry with backoff, then fail
- Non-HTML content → handle appropriately by content type
- Malformed HTML → attempt best-effort parsing, flag for review

**Verification failures:**
- Deterministic check failure → resource rejected, do NOT proceed to AI checks
- AI check low confidence → mark `needs_review`, do not auto-reject
- Empty verification result → do not persist as verified

**AI failures:**
- 429 → exponential backoff retry (30s/60s/90s, 4 attempts)
- Malformed JSON → log, skip, continue
- Invalid schema → log, skip, continue

**Database failures:**
- Transaction rollback on partial failure
- Acquisition job records failure state for retry

**Student-facing failures:**
- If acquisition is incomplete, show existing cached curriculum if available
- If no cached curriculum, show loading state with appropriate messaging
- Never show unverified resources to students

---

## 22. Testing Strategy

### Deterministic components (heavily testable without AI or internet)

- URL canonicalization
- Deduplication
- Content hashing
- Cache key generation
- Verification rules (deterministic checks)
- Ranking calculations
- Mapping logic
- Schema validation
- Content-type detection

### AI-dependent components (mockable)

- Curriculum extraction
- Resource classification
- Semantic relevance
- Understanding mapping

Testing approach:
- `AIProvider` interface enables mock implementations
- `SearchProvider` interface enables mock implementations
- `BrowserProvider` interface enables mock implementations
- Each pipeline stage testable independently with mocked downstream

### What should be tested

- A verification check rejects a 404 URL
- A verification check accepts a 200 HTML page
- Ranking computes correct final score from domain score + signals
- Resource mapping prevents duplicate (resource, understanding) pairs
- Curriculum discovery distinguishes human-written vs AI-generated
- Cache key versioning invalidates on schema/prompt changes
- Cold path triggers acquisition; warm path serves from cache

---

## 23. Incremental Implementation Strategy

Phases are architectural milestones, NOT instructions to implement them now.

Each phase must be independently reviewable, independently testable, independently reversible, and capable of leaving the existing application functional — no phase may require a later phase to be complete in order to remain functional.

### Phase 1 — AI provider abstraction
Extract `callClaude()` into `AIProvider` interface. No behavior change. Enables future provider swap. Supports: structured output, web search tool, 429 retry with backoff, model selection.

### Phase 2 — Core domain types/contracts
Define shared TypeScript interfaces for `DiscoveryCandidate`, `AcquiredPage`, `CleanedPage`, `ExtractedCurriculum`, `ExtractedResource`, `VerifiedSource`, `RankedResource`, `PersistedResource`. These are NOT DB tables; they are pure type definitions.

### Phase 3 — Minimal database migration + RLS
Add `curriculum_sources`, `resource_mappings`, `verification_records`, `acquisition_jobs` tables. Add RLS policies. Do NOT rename existing tables. Acquire job records are in DB from the start.

### Phase 4 — URL canonicalization, hashing, deterministic utilities
Implement URL normalization, content hashing (SHA-256), deterministic checks (URL well-formed, SSRF blocklist, content type detection). Testable without AI or internet.

### Phase 5 — Acquisition/fetch/clean pipeline
Implement `BrowserProvider` (HTTP fetch + HTML parsing). Produces `CleanedPage`. Deterministic validation stage. Does NOT require Playwright in Phase 1.

### Phase 6 — Verification pipeline
Implements deterministic verification stage (HTTP status, content non-empty, title present, not login-walled, not paywalled). Produces `VerifiedSource`. Resources land as `draft`. Admin approval required for public visibility.

### Phase 7 — Resource discovery integration
Wire existing `discover/route.ts` to use new acquisition pipeline. Replace `content_type_verified: true` hardcode with real verification from `verification_records`.

### Phase 8 — Curriculum discovery/provenance
Implement human curriculum discovery via `curriculum_sources`. AI fallback explicitly marked with `source_type = 'ai_generated'`, `source_url = null`.

### Phase 9 — Durable acquisition job processing
The `acquisition_jobs` table exists from Phase 3. Processing may be request-triggered or scheduled; the DB record is the durable source of truth. Crash recovery via job status.

### Phase 10 — Fast curriculum lookup/assembly
Implement student warm path (DB/cache lookups, fast response). Cold path triggers durable acquisition per Correction 2.

### Phase 11 — Caching/versioning improvements
Add versioned cache keys (`resource-extraction:v1:<hash>`, `curriculum-extraction:v1:<hash>`, `resource-verification:v1:<hash>`). Distinguish base curriculum cache from student-specific assembly. In-memory Map OK; DB is durable source of truth.

### Phase 12 — Cut over existing generation path
Redirect `stream/route.ts` to use new Learning Engine + Acquisition Engine. Preserve SSE events so frontend is unchanged. Fix `approved`/`content_type_verified` bug — resources land as `draft`, pending admin approval.

### Phase 13 — Testing, performance, CAC hardening
Full test suite. Performance benchmarking. CAC demonstration. All 18 architectural corrections reviewed and addressed.

---

## 24. Current → Target Migration Strategy

### Preserve (remain intact)

- Supabase database foundation
- Supabase RLS policies
- Authentication (Supabase Auth)
- Existing admin workflow (approve/reject/delete resources)
- Current `GenerateForm`
- SSE infrastructure (event types unchanged)
- Curriculum viewer
- Existing resource management
- `domain_scorelist.json` and domain score data
- Seed infrastructure
- Existing database schema (no physical renames)

### Adapt (modify in place)

- `stream/route.ts` — replace inline AI calls with provider abstraction; fix `approved`/`content_type_verified` bug; delegate to new learning orchestrator
- `discover/route.ts` — replace inline AI calls with provider abstraction; wire through verification pipeline
- `generate/route.ts` — replace weak cache check with versioned cache key
- `curriculum-data.ts` — add new query functions for new tables
- Admin UI — may need minor additions for verification display

### Eventually replace

- `callClaude()` inline implementations → `AIProvider` abstraction
- Hardcoded Anthropic API calls → provider abstraction
- Inline acquisition logic in routes → acquisition service
- `content_type_verified: true` hardcoding → real verification records
- Inline resource mapping logic → junction table usage

### Do NOT touch initially

- All frontend components
- All frontend pages
- `supabase/client.ts` + `server.ts`
- `proxy.ts`
- `seed_curriculum.json` + `domain_scorelist.json`
- `seed.ts` (update later if new tables need seeding)
- Existing `resources` table data
- Existing `curricula` table data
- Existing `domain_scores` table data

---

## 25. Decisions / Architectural Invariants

1. **AI is not the content source.** AI discovers, organizes, classifies, extracts, evaluates, maps. AI does not generate educational content.

2. **AI URLs are candidates only.** Every AI-discovered URL goes through acquisition + deterministic verification before becoming a valid resource.

3. **Deterministic checks before AI checks.** A resource failing HTTP 200, content non-empty, or title presence is rejected before any AI classifier runs.

4. **HEAD requests are NOT sufficient as sole verification.** Actual GET/browser acquisition establishes the real response. HEAD can be a preliminary check but not the only check.

5. **Admin approval is required for public visibility.** Verification makes a resource trusted; admin approval makes it public. AI-discovered resources never auto-publish.

6. **AI-generated curriculum is explicitly marked.** `source_type = 'ai_generated'`, `source_url = null`, `source_attribution = null`. Never masquerades as human-written.

7. **Domain reputation is an input, not the final ranking.** `domain_score` is one signal among many. Ranking v1 uses domain reputation as the primary signal, supplemented by cheap deterministic signals where available. The architecture supports additional content-level signals in Ranking v2+.

8. **Database is the durable source of truth.** In-memory cache is an optimization, not storage. The system must remain correct if the process restarts, a serverless invocation ends, another instance handles the next request, or an in-memory cache is empty.

9. **Acquisition is reusable.** Canonical URLs + content hashes + versioned cache keys prevent rediscovery.

10. **Modular monolith.** No microservices, no separate deployments, no message queues for the first implementation.

11. **Student request path is fast.** Synchronous student requests never perform full acquisition crawls. Cold path triggers background acquisition; warm path serves from DB/cache.

12. **Incremental implementation.** Feature by feature. Each phase independently reviewable and reversible. No giant rewrite.

13. **Frontend contract is stable.** `GenerateForm`, SSE events, curriculum viewer, admin approval workflow — these are not redesigned during architecture work.

14. **Existing Supabase foundation is retained.** Auth, RLS, database — kept unless concrete reason to change.

15. **No physical table renames in Phase 1.** Conceptual domain language may use "Units" and "Understandings"; physical tables remain `nodes` and `major_understandings` until a deliberate migration.

16. **Curriculum source identity is verified, not assumed.** A `.edu` domain does not prove human authorship. Official branding, authorship metadata, URL path, and structural matching are all part of the evidence.

17. **Paywall/login detection must avoid false positives.** The word "subscribe" in a non-paywall context must not trigger rejection. Detection heuristics must be careful and documented.

18. **Acquisition job state is durable from the beginning.** `acquisition_jobs` is required in the initial architecture. Job records are persisted to PostgreSQL/Supabase. The architecture must NOT depend on an in-memory queue as the source of truth. Serverless/process lifetime may terminate after the response. Unfinished jobs can be retried/resumed by a later processing invocation.

19. **$0 production cost architecture.** The available production budget is **$0**. This is a hard architectural constraint, not a preference or optimization target. The architecture MUST be designed so the application can operate in production without requiring payment for any external service. The AI layer must remain provider-agnostic (Application → AIProvider → provider implementation) and MUST have a legitimate $0-capable production implementation. Possible implementations include local/open-weight models, genuinely free inference, legitimately available infrastructure, or other solutions that do not require spending money. Do NOT assume any student credit program is available. The goal is NOT to find an "unlimited free AI API." The goal is to architect the system so AI usage is minimized and the provider can be replaced. If a free provider reaches a quota or becomes unavailable, the system must use cached/persisted data, queue acquisition, or show a loading state — never silently switch to a paid provider.

20. **Verification ≠ ranking ≠ approval.** These are three separate concepts. Verification asks: "Is the candidate actually reachable, usable, appropriate, and supported by sufficient evidence?" Ranking asks: "Among valid candidates, which should appear first?" Admin approval asks: "Is this resource allowed to become publicly visible in the product?" A high domain score does not mean a resource is automatically verified. A verified resource does not mean it is automatically public. A highly ranked resource does not bypass admin approval.

21. **Human authorship is an evidence classification, not mathematical proof.** AI cannot prove that a resource is human-written. Authorship status is an evidence classification: `verified`, `likely_human`, `unknown`, `likely_ai`, `rejected`. AI may provide an advisory inference, but this must NEVER be the sole basis for declaring a resource human-written. The architecture must never claim that an LLM can reliably detect AI-generated text.

22. **No implementation phase may require a later phase to be complete in order to remain functional.** Every implementation phase must be independently reviewable, independently testable, independently reversible, and capable of leaving the existing application functional.

23. **Every acquisition job has a bounded resource budget.** A cold curriculum request must not be able to generate unlimited search queries, candidate URLs, fetch attempts, AI calls, or retries. The architecture requires configurable per-job/per-cycle limits (max candidates per understanding, max total candidates per acquisition job, max fetch attempts, max AI calls, max retries). Application-level abuse controls/rate limiting must prevent unbounded acquisition or AI spending.

24. **No product philosophy changes.** Do not add automatic publishing, raw web resources shown directly to students, AI-generated educational content presented as if human-written, immediate AI curriculum fallback before human curriculum acquisition has had a chance, a second frontend flow, a redesigned GenerateForm, a new student-facing architecture, microservices, mandatory paid AI, mandatory Playwright, mandatory Redis, or mandatory external queue infrastructure. The goal is a fast, reusable, low-cost acquisition + learning architecture, not maximum infrastructure complexity.

25. **`curriculum_sources` is the structured provenance authority.** Existing `curricula.source_type`, `source_attribution`, and `source_url` fields are treated as legacy compatibility fields, read/display mirrors, or transitional fields populated consistently from the structured provenance data. Do NOT claim both are independent sources of truth. Do not require a physical table rename.

26. **Verification records are bounded, not a permanent webpage mirror.** Persistent storage should be bounded and purposeful: title, metadata, content hash, content type, status, canonical URL, timestamps, deterministic check results, and bounded excerpts/evidence where needed. The purpose of `verification_records` is to provide verification evidence and reproducibility, not to become a permanent mirror of every webpage. The acquisition/cleaning pipeline may temporarily process larger content in memory or transient storage as required.

---

## 27. External Dependencies — $0-Capable Classification

Every external dependency must be classified as one of:

| Classification | Definition |
|---------------|------------|
| **REQUIRED AND $0-CAPABLE** | Must have a viable $0 production path. If the provider becomes unavailable, the system must gracefully degrade, not fail or switch to paid. |
| **OPTIONAL AND $0-CAPABLE** | Can be omitted or replaced with a $0 alternative. Not required for production operation. |
| **OPTIONAL PAID DEVELOPMENT/TESTING ONLY** | Must never be required in production. Development/testing may use paid services, but production must work without them. |

There must be **NO** required production dependency whose normal operation requires payment.

### $0-capable production dependencies (REQUIRED)

| Dependency | $0 Path | Notes |
|------------|---------|-------|
| Database | Supabase free tier (1GB) | Free tier storage/compute sufficient for seed data + student usage |
| AI Inference | Local open-weight models OR genuinely free provider | Must NOT depend on paid Anthropic/OpenAI/etc. |
| Authentication | Supabase Auth free tier | Included with database free tier |
| Search/Discovery | Direct HTTP to educational sites + seed data | No paid search API required |
| Web Page Acquisition | Node.js built-in HTTPS fetch | No browser automation or paid scraping required |
| Caching | In-memory Map (Redis optional for scale) | Free solution exists |
| File Storage | Static export / free hosting (Vercel, Netlify, etc.) | No server-side storage cost |
| Monitoring/Logging | Console / file logging | No external observability service required |
| Scheduling | Database-based job polling | No message queue or external scheduler required |

### Optional $0-CAPABLE alternatives

| Dependency | $0 Alternative | Notes |
|------------|---------------|-------|
| Curated search | Community-maintained lists, seed domains | Pre-curate domain lists |
| AI provider | Local model (e.g., Ollama, LM Studio) | Runs on same host |
| Browser automation | Progressive enhancement | HTTP for basic, manual for JS-heavy |
| Cloud storage | IPFS, Dat, peer-to-peer | Experimental/optional |

### OPTIONAL PAID (development/testing only)

| Dependency | Paid Use | $0 Production Path |
|------------|----------|-------------------|
| Claude API | Development, testing, fallback | Must use $0 alternative in production |
| OpenAI API | Development, testing, fallback | Must use $0 alternative in production |
| Paid search APIs | Development, testing | Must use direct HTTP/seed data in production |
| Paid browser automation | Development, testing | Not required; HTTP fetch is $0 path |
| Premium hosting | Large-scale production | Free tiers or self-host available |
| Advanced analytics | Product insights | Not required for operation |

### Warm path is $0

A student request satisfied by cached or persisted data costs **$0** in new external calls. Only database reads (included in Supabase free tier) and local application processing are involved.

### Cold path is $0-capable

When acquisition is required:
1. Direct HTTP to verified educational URLs (no search API cost)
2. Seed data domain lists (already available)
3. HTTP fetch for page acquisition (no scraper cost)
4. Deterministic extraction (no AI cost)
5. Local/open-weight AI only where semantic reasoning is genuinely necessary

The system must gracefully degrade (loading state, cached fallbacks) when new acquisition cannot proceed at $0.

These are explicitly NOT answered by the repository or this document. They require human/AI review before implementation.

1. **What constitutes a "suitable human-written curriculum"?** The product contract says "when an appropriate one exists" but does not define the matching threshold. Is 50% structural overlap sufficient? 70%? Who decides?

2. **How should the system handle multiple competing human-written curricula for the same topic?** Select the highest-ranked? Present options? Merge?

3. **What is the verification budget?** How many HTTP fetches per resource? What timeout? What retry policy? The current code has no fetching at all.

4. **What browser automation tooling is acceptable?** Puppeteer? Playwright? Cheerio? The repository currently has none. Phase 5 needs a decision.

5. **How should the system handle JavaScript-heavy pages?** The current code cannot execute JS. Many educational sites render content client-side. This is an unsolved problem in the current codebase.

6. **What is the caching infrastructure?** In-memory Map? Upstash? Redis? The repository has no caching layer today. Phase 1 can use in-memory; Phase 2 needs a decision.

7. **Who is the admin?** The current system has a single-admin allowlist (`admins` table). Is this sufficient for CAC, or do multiple curators need access?

8. **How are curriculum updates handled?** If NYSED updates the Chemistry curriculum, does the system detect drift? Re-acquire? Version curricula?

9. **What is the cost budget?** The current architecture makes ~14-26 Claude calls per curriculum. The new architecture should reduce this through caching, but no budget has been specified.

10. **What is the acceptable cold-start time?** If a student requests a topic with no cached curriculum, how long should they wait before seeing a result? The current system takes 3-5 minutes. Is that acceptable for CAC?

11. **Should the `nodes` → `units` rename happen in Phase 1 or later?** The current architecture document says no physical renames in Phase 1. But if new code uses "unit" terminology, there will be a conceptual mismatch.

12. **How should `curriculum_sources` relate to existing `curricula.source_type`/`source_attribution`/`source_url`?** These columns already exist and contain provenance data. Should the new table replace them, complement them, or coexist?

---

## Architecture Lock Status

- This document describes the **TARGET architecture**.
- **No target architecture has been implemented** by this task.
- The document requires human/AI review before implementation.
- Future implementation will happen incrementally, one phase at a time.
- Existing source files, database, and frontend are **unchanged**.
- `architecture.md` is the only file created/updated by this task.
