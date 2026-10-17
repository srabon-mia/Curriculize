/**
 * Phase 10 warm-path lookup regression tests.
 *
 * These cover the pure helpers in finder.ts (parseNotesJson / notesMatchRequest)
 * that determine whether a published curriculum was built from the SAME student
 * request. They make no DB calls and consume no AI credits.
 */

import { describe, it, expect, vi } from "vitest";
import { parseNotesJson, notesMatchRequest } from "../finder";

// finder.ts imports @/lib/supabase/server at module top-level; tests only need
// the pure helpers, so stub it out (no Next.js dependency, no real client).
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({})),
}));

const FULL_REQUEST = {
  topic: "AP Chemistry",
  grade_level: "AP / IB level",
  difficulty: "Advanced / rigorous",
  existing_knowledge: "completed Algebra 2",
  learning_goal: "Pass an exam (Regents, AP, IB, SAT, etc.)",
  time_available: "1 month",
  added_context: "focus on the math-heavy parts",
};

// Exactly what /api/generate persists via JSON.stringify of the 6 non-topic fields:
const MATCHING_NOTES = JSON.stringify({
  grade_level: FULL_REQUEST.grade_level,
  difficulty: FULL_REQUEST.difficulty,
  existing_knowledge: FULL_REQUEST.existing_knowledge,
  learning_goal: FULL_REQUEST.learning_goal,
  time_available: FULL_REQUEST.time_available,
  added_context: FULL_REQUEST.added_context,
});

describe("parseNotesJson", () => {
  it("parses a valid JSON object string", () => {
    expect(parseNotesJson(MATCHING_NOTES)).toEqual({
      grade_level: "AP / IB level",
      difficulty: "Advanced / rigorous",
      existing_knowledge: "completed Algebra 2",
      learning_goal: "Pass an exam (Regents, AP, IB, SAT, etc.)",
      time_available: "1 month",
      added_context: "focus on the math-heavy parts",
    });
  });

  it("returns null for null / undefined / empty", () => {
    expect(parseNotesJson(null)).toBeNull();
    expect(parseNotesJson(undefined)).toBeNull();
    expect(parseNotesJson("")).toBeNull();
    expect(parseNotesJson("   ")).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(parseNotesJson(42)).toBeNull();
    expect(parseNotesJson({ grade_level: "x" })).toBeNull();
    expect(parseNotesJson(["not", "an", "object"])).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseNotesJson("not json")).toBeNull();
    expect(parseNotesJson("{grade: 1}")).toBeNull();
    expect(parseNotesJson('{"grade":}')).toBeNull();
  });

  it("returns null for JSON primitives and arrays", () => {
    expect(parseNotesJson('"a string"')).toBeNull();
    expect(parseNotesJson("123")).toBeNull();
    expect(parseNotesJson("true")).toBeNull();
    expect(parseNotesJson("null")).toBeNull();
    expect(parseNotesJson('["a","b"]')).toBeNull();
  });

  // Seed curricula store free-text notes (not JSON) — these must NOT match.
  it("returns null for seed-style free-text notes", () => {
    expect(
      parseNotesJson(
        "Topic structure and major understandings are official NYSED content..."
      )
    ).toBeNull();
  });
});

describe("notesMatchRequest", () => {
  const fields = {
    grade_level: FULL_REQUEST.grade_level,
    difficulty: FULL_REQUEST.difficulty,
    existing_knowledge: FULL_REQUEST.existing_knowledge,
    learning_goal: FULL_REQUEST.learning_goal,
    time_available: FULL_REQUEST.time_available,
    added_context: FULL_REQUEST.added_context,
  };

  it("matches when all six persisted fields are identical", () => {
    expect(notesMatchRequest(MATCHING_NOTES, fields)).toBe(true);
  });

  it("returns false for non-JSON / seed-style notes", () => {
    expect(notesMatchRequest("NYSED free text notes...", fields)).toBe(false);
    expect(notesMatchRequest(null, fields)).toBe(false);
    expect(notesMatchRequest("", fields)).toBe(false);
  });

  it("returns false when a single field differs (e.g. different grade level)", () => {
    const differentNotes = JSON.stringify({
      ...fields,
      grade_level: "High school (9-12)",
    });
    expect(notesMatchRequest(differentNotes, fields)).toBe(false);
  });

  it("returns false when a single field differs (e.g. different difficulty)", () => {
    const differentNotes = JSON.stringify({
      ...fields,
      difficulty: "Standard",
    });
    expect(notesMatchRequest(differentNotes, fields)).toBe(false);
  });

  it("returns false when an existing_knowledge refinement differs", () => {
    const differentNotes = JSON.stringify({
      ...fields,
      existing_knowledge: "completed Biology",
    });
    expect(notesMatchRequest(differentNotes, fields)).toBe(false);
  });

  it("ignores unrelated extra keys stored in notes (only the 6 fields gate the match)", () => {
    const withExtra = JSON.stringify({
      grade_level: fields.grade_level,
      difficulty: fields.difficulty,
      existing_knowledge: fields.existing_knowledge,
      learning_goal: fields.learning_goal,
      time_available: fields.time_available,
      added_context: fields.added_context,
      extra_key_from_future_version: "ignored",
    });
    expect(notesMatchRequest(withExtra, fields)).toBe(true);
  });

  it("returns true for a partial field set that still matches", () => {
    const partial = { grade_level: fields.grade_level, difficulty: fields.difficulty };
    expect(notesMatchRequest(MATCHING_NOTES, partial)).toBe(true);
    expect(
      notesMatchRequest(MATCHING_NOTES, { grade_level: "wrong" })
    ).toBe(false);
  });

  it("is robust to key ordering in stored notes (compares by value, not string)", () => {
    const reordered = JSON.stringify({
      added_context: fields.added_context,
      time_available: fields.time_available,
      learning_goal: fields.learning_goal,
      existing_knowledge: fields.existing_knowledge,
      difficulty: fields.difficulty,
      grade_level: fields.grade_level,
    });
    expect(notesMatchRequest(reordered, fields)).toBe(true);
  });

  it("returns false when a persisted field is missing entirely", () => {
    const missingField = JSON.stringify({
      grade_level: fields.grade_level,
      difficulty: fields.difficulty,
      existing_knowledge: fields.existing_knowledge,
      learning_goal: fields.learning_goal,
      time_available: fields.time_available,
      // added_context omitted — JSON.stringify drops undefined, which is what
      // the route would store if the field arrived as undefined.
    });
    expect(notesMatchRequest(missingField, fields)).toBe(false);
  });
});
