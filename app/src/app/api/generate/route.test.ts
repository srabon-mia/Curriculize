/**
 * Regression tests for POST /api/generate warm-path cache lookup (Phase 10).
 *
 * Covers the replace of the fuzzy `%normalized%` ilike title match with an
 * EXACT title + exact notes match, so different student inputs never match.
 *
 * Mocks @supabase/supabase-js so no network, no AI calls, no database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockSupabaseClient } from "@/lib/phase6-integration/mock-supabase";
import { type CurriculumRequest } from "@/lib/curriculum/finder";

const mockClient = new MockSupabaseClient();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockClient),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({})),
}));

// Dynamic import so mockClient is defined before route.ts runs at module load.
const { POST } = await import("./route");

const FIELDS = {
  grade_level: "AP / IB level",
  difficulty: "Advanced / rigorous",
  existing_knowledge: "completed Algebra 2",
  learning_goal: "Pass an exam (Regents, AP, IB, SAT, etc.)",
  time_available: "1 month",
  added_context: "focus on the math-heavy parts",
};

const topic = "AP Chemistry";

function bodyFor(topicValue: string, overrides: Partial<typeof FIELDS> = {}) {
  return {
    topic: topicValue,
    ...FIELDS,
    ...overrides,
  };
}

function canonicalNotes(fields: Partial<typeof FIELDS>) {
  return JSON.stringify({
    grade_level: fields.grade_level ?? FIELDS.grade_level,
    difficulty: fields.difficulty ?? FIELDS.difficulty,
    existing_knowledge: fields.existing_knowledge ?? FIELDS.existing_knowledge,
    learning_goal: fields.learning_goal ?? FIELDS.learning_goal,
    time_available: fields.time_available ?? FIELDS.time_available,
    added_context: fields.added_context ?? FIELDS.added_context,
  });
}

function post(body: Partial<CurriculumRequest>) {
  return POST(new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function seededCurriculumCount() {
  return mockClient.getRows("curricula").length;
}

describe("POST /api/generate warm-path cache lookup", () => {
  beforeEach(() => {
    mockClient.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached: true for an identical re-submission (exact title + exact notes)", async () => {
    mockClient.insert("curricula", {
      id: "curriculum-hit-1",
      title: topic,
      subject: "chemistry",
      source_type: "ai_organized",
      status: "published",
      notes: canonicalNotes(FIELDS),
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const response = await post(bodyFor(topic));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ curriculum_id: "curriculum-hit-1", cached: true });

    // No new curriculum row created on a cache hit.
    expect(mockClient.getRows("curricula")).toHaveLength(1);
  });

  it("returns cached: false and creates a draft when notes fields differ (same title, different grade level)", async () => {
    mockClient.insert("curricula", {
      id: "curriculum-miss-1",
      title: topic,
      subject: "chemistry",
      source_type: "ai_organized",
      status: "published",
      notes: canonicalNotes({ ...FIELDS, grade_level: "High school (9-12)" }),
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const before = seededCurriculumCount();
    const response = await post(bodyFor(topic));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.cached).toBe(false);
    expect(json.curriculum_id).toBeDefined();
    expect(typeof json.curriculum_id).toBe("string");

    // A new draft was created for the new request.
    const rows = mockClient.getRows("curricula");
    expect(rows).toHaveLength(before + 1);

    // The new row has status "draft" and the canonical notes for the request.
    const createdDraft = rows.find((r) => r.notes === canonicalNotes(FIELDS));
    expect(createdDraft).toBeDefined();
    expect(createdDraft!.status).toBe("draft");
    expect(createdDraft!.source_type).toBe("ai_organized");
    expect(createdDraft!.title).toBe(topic);

    // The original published row still exists unchanged.
    const originalPublished = rows.find((r) => r.notes === canonicalNotes({ ...FIELDS, grade_level: "High school (9-12)" }));
    expect(originalPublished).toBeDefined();
    expect(originalPublished!.status).toBe("published");
  });

  it("does NOT false-hit on a topic that is a substring of another curriculum's title", async () => {
    // Seed an Organic Chemistry curriculum — the OLD `%chemistry%` ilike would
    // have matched a request for "Chemistry" against it.
    mockClient.insert("curricula", {
      id: "curriculum-organic-1",
      title: "Organic Chemistry",
      subject: "organic chemistry",
      source_type: "ai_organized",
      status: "published",
      notes: canonicalNotes(FIELDS),
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const response = await post(bodyFor("Chemistry"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.cached).toBe(false);
    expect(json.curriculum_id).toBeDefined();
    // The Organic Chemistry row is untouched; a fresh draft for "Chemistry" was created.
    expect(mockClient.getRows("curricula")).toHaveLength(2);
    const organic = mockClient.getRows("curricula").find((r) => r.title === "Organic Chemistry");
    expect(organic).toBeDefined();
    expect(organic!.status).toBe("published");
  });

  it("disambiguates same-title curricula by notes fields (grade level tiebreak)", async () => {
    mockClient.insert("curricula", {
      id: "curriculum-hs-1",
      title: topic,
      subject: "chemistry",
      source_type: "ai_organized",
      status: "published",
      notes: canonicalNotes({ ...FIELDS, grade_level: "High school (9-12)" }),
      created_at: "2024-01-01T00:00:00.000Z",
    });
    mockClient.insert("curricula", {
      id: "curriculum-ap-1",
      title: topic,
      subject: "chemistry",
      source_type: "ai_organized",
      status: "published",
      notes: canonicalNotes(FIELDS),
      created_at: "2024-01-02T00:00:00.000Z", // most recent first
    });

    const response = await post(bodyFor(topic));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.cached).toBe(true);
    expect(json.curriculum_id).toBe("curriculum-ap-1"); // matching grade, most recent
  });

  it("returns HTTP 400 when topic is missing", async () => {
    const response = await post({} as Partial<CurriculumRequest>);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("topic is required");
  });
});
