# Curriculize

Curriculize turns a learning goal into a structured curriculum roadmap by finding and organizing existing authoritative human-written educational resources — not AI-generated content.

[Live at curriculize.org](https://www.curriculize.org)

---

## Why Curriculize

Self-directed learners face a common problem: the internet is full of excellent educational resources, but they're scattered across dozens of sites with no clear progression. A student wanting to learn chemistry might find a great Khan Academy video on atomic structure, a solid practice set on JMAP, and a clear explanation on LibreTexts — but no map showing how these fit together or what order to study them in.

Curriculize solves this by **organizing existing resources into a coherent learning path**. It doesn't generate lessons from scratch. Instead, it:

1. Finds or adapts a reputable curriculum structure (official syllabi, university courses)
2. Searches for high-quality free resources matched to each topic and concept
3. Presents everything as a structured roadmap a learner can actually follow

The goal: less time sorting links, more time learning.

---

## How It Works

**You enter a topic** — e.g., "AP Chemistry," "Calculus AB," "World History" — along with your grade level, difficulty preference, learning goal, and time available.

**Curriculize builds a curriculum** by:
- Searching for an existing human-written syllabus (AP, NYSED, MIT OCW, etc.) and adapting its structure, *or* creating a logical topic sequence if no suitable source exists
- Identifying the best free educational domains for that subject
- Finding specific resources — videos, readings, practice problems, textbooks — for each topic and sub-concept
- Organizing everything into topics → major understandings → curated resources

**You get a structured curriculum** you can browse topic by topic, with resources attached to each concept. No account required. Free to use.

**Core principle**: AI assists with planning and discovery. Humans review and approve resources. The learning content always comes from real educational sources.

---

## Features

- **Generate a curriculum** for any subject in 3–5 minutes
- **Browse published curricula** created by others
- **Resources tied to concepts** — not just topic-level links, but resources matched to specific learning objectives
- **Domain reputation scoring** — sources ranked by quality to prioritize trustworthy content
- **Guest-friendly** — no login needed to generate or view

---

## Tech Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Supabase** (PostgreSQL + Auth + Row Level Security)
- **Azure AI** (production) / Anthropic / OpenRouter (configurable providers)
- **Tailwind CSS v4**
- **Vitest** for testing

---

## Run Locally

### Prerequisites
- Node.js 20+
- npm 10+
- A Supabase project (free tier works)
- An AI provider API key (Azure OpenAI, Anthropic, or OpenRouter)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/your-org/curriculum-generator.git
cd curriculum-generator/app
npm install

# 2. Configure environment
cp .env.local.example .env.local
# Edit .env.local with your Supabase credentials and AI provider keys

# 3. Set up database (run migrations in Supabase SQL Editor or CLI)
npx supabase db push

# 4. (Optional) Seed demo curriculum
npm run seed

# 5. Start development server
npm run dev
```

Visit `http://localhost:3000`.

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-only) |
| `AI_PROVIDER` | `azure` \| `anthropic` \| `openrouter` \| `mock` |
| Corresponding AI API key | `AZURE_OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` |
| `CRON_SECRET` | Secret for job processor endpoint |

> **Production uses Azure AI** (`AI_PROVIDER=azure` with `gpt-4.1-mini`). The code supports multiple providers; configure whichever you have access to.

---

## Contributing

1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run checks: `npm run lint && npm test && npm run build`
5. Open a Pull Request

---

## License

This project currently has no declared license. All rights reserved by the authors.