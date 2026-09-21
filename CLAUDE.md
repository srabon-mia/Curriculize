# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Curriculum Generator** — an AI-powered tool that builds study guides by compiling human-curated resources from the web (not AI-generated content). The system:
1. Takes a user's subject/topic request
2. Uses Claude with web search to find or adapt an existing curriculum structure (official syllabi, university courses)
3. Searches for high-quality free resources per topic/concept
4. Stores everything in Supabase for review and publishing

**Key principle**: AI organizes and finds resources; humans review and approve. No AI-generated explanations or practice problems.

## Tech Stack

- **Framework**: Next.js 16.2.9 (App Router) with React 19
- **Language**: TypeScript (strict)
- **Styling**: Tailwind CSS v4
- **Database**: Supabase (PostgreSQL) with RLS
- **Auth**: Supabase Auth (email/password)
- **AI**: Anthropic Claude API (Haiku 4.5) with web search tool
- **Package Manager**: npm

## Common Commands

Run from the `app/` directory:

```bash
# Development
npm run dev          # Start dev server (Next.js)

# Build & Production
npm run build        # Production build
npm run start        # Start production server

# Linting
npm run lint         # ESLint (flat config)

# Database seeding (one-time setup)
npm run seed         # Load seed_curriculum.json + domain_scorelist.json into Supabase
                     # Uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS)
                     # Idempotent — safe to re-run after editing JSON files
```

## Project Structure

```
app/                          # Next.js application (working directory)
├── src/
│   ├── app/                  # App Router pages & API routes
│   │   ├── page.tsx          # Landing page with GenerateForm
│   │   ├── layout.tsx        # Root layout
│   │   ├── globals.css       # Tailwind + custom design tokens
│   │   ├── admin/            # Admin dashboard (auth required)
│   │   │   ├── page.tsx      # Curricula list
│   │   │   └── curriculum/[id]/page.tsx  # CurriculumBuilder UI
│   │   ├── curriculum/       # Public curriculum viewing
│   │   │   ├── page.tsx      # Published curricula index
│   │   │   └── [id]/page.tsx # CurriculumViewer (read-only)
│   │   ├── generate/         # User curriculum generation flow
│   │   │   ├── page.tsx      # GenerateForm (POSTs to /api/generate)
│   │   │   └── [id]/page.tsx # SSE progress page during generation
│   │   ├── api/
│   │   │   ├── generate/route.ts           # Create curriculum record
│   │   │   ├── generate/[id]/stream/route.ts  # SSE: skeleton → nodes → resources
│   │   │   ├── curricula/route.ts          # List/create curricula (RLS)
│   │   │   ├── curricula/[id]/progress/    # Resource completion check
│   │   │   ├── discover/route.ts           # Admin: AI resource discovery
│   │   │   └── resources/route.ts          # CRUD for resources (RLS)
│   ├── components/
│   │   ├── GenerateForm.tsx    # User input form
│   │   ├── CurriculumViewer.tsx # Public read-only view (with polling)
│   │   ├── CurriculumBuilder.tsx # Admin: topic tree + resource management
│   │   ├── ResourceCard.tsx    # Admin: approve/reject/delete
│   │   ├── AddResourceForm.tsx # Admin: manual resource entry
│   │   └── LogoutButton.tsx
│   ├── lib/
│   │   ├── curriculum-data.ts  # Server-side Supabase queries (typed)
│   │   ├── prompts/            # Prompt templates for AI
│   │   │   ├── skeleton.ts     # Curriculum structure generation
│   │   │   ├── discover.ts     # Resource discovery (topic + batch)
│   │   │   └── sources.ts      # Source domain discovery
│   │   └── supabase/
│   │       ├── client.ts       # Browser client (anon key)
│   │       └── server.ts       # Server client (cookies for RLS)
│   └── proxy.ts                # Next.js proxy config
├── scripts/
│   └── seed.ts                 # Idempotent DB seed from JSON files
├── package.json
├── tsconfig.json
├── next.config.ts
├── eslint.config.mjs
└── .env.local                  # Local env (not committed)
```

## Database Schema (Supabase)

Key tables (see `supabase/migrations/0001_init.sql`):

| Table | Purpose |
|-------|---------|
| `curricula` | Top-level curriculum (title, subject, source_type, status) |
| `nodes` | Topics within a curriculum (order_index, exam_weight_pct) |
| `major_understandings` | Fine-grained concepts (code, description) — primary resource attachment level |
| `resources` | Curated links attached to node OR major_understanding (status: draft/approved/rejected) |
| `domain_scores` | Reputation scores (1-5) for source domains — used for ranking |
| `progress` | Per-user completion tracking |
| `admins` | Allowlist for admin RLS policies |

**RLS policies** (`0002_rls.sql`): Published content is public; drafts/admin writes require `is_admin()` check against `admins` table.

## AI Generation Pipeline (`/api/generate/[id]/stream/route.ts`)

SSE stream with these steps:

1. **Skeleton** — `buildSkeletonPrompt()` → Claude searches for official curricula (AP, NYSED, MIT OCW) → returns structured JSON (6-12 topics, 4-8 understandings each)
2. **Insert nodes & MUs** — Persist to Supabase
3. **Source discovery** — `buildSourceDiscoveryPrompt()` → Claude identifies 10-15 best free domains for subject/difficulty (no web search needed)
4. **Topic-level resource discovery** — `buildDiscoverPrompt()` per topic → Claude searches web → returns 3-5 learning + 2-4 practice resources
5. **Publish** — Set curriculum status to `published`
6. **Background batch** — `buildTopicBatchPrompt()` per topic → finds per-understanding resources (runs async after stream closes)

**Model**: `claude-haiku-4-5-20251001` with `web_search_20250305` tool. Retries with exponential backoff on 429.

## Admin Resource Curation (`CurriculumBuilder.tsx`)

- Topic tree with expandable major understandings
- Three discovery modes: single topic, single understanding, bulk (all MUs in topic)
- Resources default to `draft` status → admin approves/rejects
- Embed eligibility: only if `license_status === "cc_open"` AND `domain_score >= 4`
- Manual `AddResourceForm` for human-curated additions

## Environment Variables

Required in `app/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxx
SUPABASE_SERVICE_ROLE_KEY=xxx          # Server-only, bypasses RLS
ANTHROPIC_API_KEY=sk-ant-xxx           # For AI generation
```

## Design System (Tailwind v4)

Custom color palette in `globals.css`:
- Background: `#FAFAF7` (warm off-white)
- Text: `#1A1A18` (near-black)
- Muted: `#5A564A`, `#8A8578`
- Accent: `#B8753D` (gold/amber)
- Borders: `#E7E3D7`, `#D8D4C8`, `#F0EDE3`
- Semantic: `#3D7A4F` (success), `#B8453D` (error), `#3D5FA0` (video), `#6B4A8A` (reference)

Fonts: `font-sans` (system UI), `font-serif` (headings), `font-mono` (codes).

## Key Files for Common Tasks

| Task | Files to Modify |
|------|-----------------|
| Add new API route | `app/src/app/api/<name>/route.ts` |
| Change AI prompts | `app/src/lib/prompts/*.ts` |
| Modify database queries | `app/src/lib/curriculum-data.ts` |
| Update UI components | `app/src/components/*.tsx` |
| Change data model | `supabase/migrations/` (new migration) |
| Seed new curriculum | Edit `seed_curriculum.json`, run `npm run seed` |
| Adjust domain scores | Edit `domain_scorelist.json`, run `npm run seed` |

## Development Notes

- **Server Components by default** — Use `"use client"` only when needed (interactivity, hooks)
- **SSE for long-running generation** — `/api/generate/[id]/stream` returns `text/event-stream`
- **Polling in CurriculumViewer** — Refetches resources every 30s until all MUs have resources
- **Idempotent seeding** — Uses `upsert` with `onConflict` on `external_key`
- **Rate limiting** — Claude API calls wait 30s/60s/90s on 429; bulk discovery spaces requests 60s apart
- **No tests yet** — Add test infrastructure when needed

## Current Limitations / Known Issues

1. Generation can take 3-5 minutes (sequential topic discovery with 15s delays)
2. Background per-understanding discovery runs after publish — no UI feedback
3. Single admin user (allowlist in `admins` table)
4. No automated tests
5. Domain scores are static JSON — no learning from search results yet