/**
 * Phase 11 Cache Key Tests
 * Verify versioned cache key generation and the base-curriculum vs
 * student-specific assembly distinction.
 */

import {
  resourceExtractionKey,
  baseCurriculumKey,
  studentAssemblyKey,
  resourceVerificationKey,
} from "@/lib/cache/keys";

describe("Cache key generators", () => {
  test("resourceExtractionKey uses resource-extraction:v1 prefix", () => {
    const key = resourceExtractionKey("https://example.com");
    expect(key).toMatch(/^resource-extraction:v1:[a-f0-9]{64}$/);
  });

  test("resourceExtractionKey is deterministic", () => {
    expect(resourceExtractionKey("https://example.com")).toBe(
      resourceExtractionKey("https://example.com")
    );
  });

  test("resourceExtractionKey differs for different URLs", () => {
    expect(resourceExtractionKey("https://example.com")).not.toBe(
      resourceExtractionKey("https://example.org")
    );
  });

  test("baseCurriculumKey uses curriculum-extraction:v1 prefix", () => {
    const key = baseCurriculumKey("Chemistry", "high school");
    expect(key).toMatch(/^curriculum-extraction:v1:[a-f0-9]{64}$/);
  });

  test("baseCurriculumKey is deterministic", () => {
    expect(baseCurriculumKey("Chemistry", "high school")).toBe(
      baseCurriculumKey("Chemistry", "high school")
    );
  });

  test("baseCurriculumKey differs for different topics", () => {
    expect(baseCurriculumKey("Chemistry", "high school")).not.toBe(
      baseCurriculumKey("Biology", "high school")
    );
  });

  test("baseCurriculumKey differs for different grade levels", () => {
    expect(baseCurriculumKey("Chemistry", "high school")).not.toBe(
      baseCurriculumKey("Chemistry", "college")
    );
  });

  test("baseCurriculumKey handles undefined grade level", () => {
    const key = baseCurriculumKey("Chemistry", undefined);
    expect(key).toMatch(/^curriculum-extraction:v1:[a-f0-9]{64}$/);
    expect(key).not.toBe(baseCurriculumKey("Chemistry", "high school"));
  });

  test("resourceVerificationKey uses resource-verification:v1 prefix", () => {
    const key = resourceVerificationKey("abc123");
    expect(key).toMatch(/^resource-verification:v1:/);
  });

  test("resourceVerificationKey is deterministic", () => {
    expect(resourceVerificationKey("abc123")).toBe(
      resourceVerificationKey("abc123")
    );
  });

  test("resourceVerificationKey differs for different hashes", () => {
    expect(resourceVerificationKey("abc123")).not.toBe(
      resourceVerificationKey("def456")
    );
  });
});

describe("Base curriculum vs student assembly", () => {
  const baseRequest = {
    topic: "Chemistry",
    grade_level: "high school",
    difficulty: "standard",
    existing_knowledge: "",
    learning_goal: "understand the subject",
    time_available: "no time pressure",
    added_context: null,
  };

  test("studentAssemblyKey includes all 7 form fields", () => {
    const key = studentAssemblyKey(baseRequest);
    expect(key).toMatch(/^curriculum-extraction:v1:[a-f0-9]{64}$/);
  });

  test("studentAssemblyKey differs when any field changes", () => {
    const changed = { ...baseRequest, added_context: "extra info" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey differs when topic changes", () => {
    const changed = { ...baseRequest, topic: "Biology" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey differs when grade level changes", () => {
    const changed = { ...baseRequest, grade_level: "college" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey differs when difficulty changes", () => {
    const changed = { ...baseRequest, difficulty: "advanced" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey differs when existing_knowledge changes", () => {
    const changed = { ...baseRequest, existing_knowledge: "some background" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey differs when learning_goal changes", () => {
    const changed = { ...baseRequest, learning_goal: "pass exams" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey differs when time_available changes", () => {
    const changed = { ...baseRequest, time_available: "2 hours" };
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      studentAssemblyKey(changed)
    );
  });

  test("studentAssemblyKey is deterministic", () => {
    expect(studentAssemblyKey(baseRequest)).toBe(
      studentAssemblyKey(baseRequest)
    );
  });

  test("studentAssemblyKey differs from baseCurriculumKey", () => {
    // baseCurriculumKey only uses topic + grade_level
    // studentAssemblyKey uses all 7 fields
    expect(studentAssemblyKey(baseRequest)).not.toBe(
      baseCurriculumKey(baseRequest.topic, baseRequest.grade_level)
    );
  });
});