/**
 * Phase 11 Cache Key Generators
 * Generate versioned cache keys from input values using contentCacheKey().
 *
 * Key format: `${type}:${version}:${contentHash}` (see deterministic/hash.ts)
 *
 * Distinction between base curriculum and student assembly:
 * - Base curriculum: keyed by topic + grade level — reusable across all students
 * - Student assembly: keyed by ALL 7 GenerateForm fields — changes per request
 */

import { contentCacheKey, sha256, sha256Json } from "@/lib/deterministic/hash";
import type { AcquisitionOptions } from "@/lib/acquisition/types";

/**
 * Generate a resource extraction cache key from a URL.
 * Cache holds AcquisitionResult for a given URL.
 * When options are provided, the hash includes them so the key differs
 * if extraction settings change (timeout, content type limits, etc.).
 */
export function resourceExtractionKey(
  url: string,
  options?: AcquisitionOptions
): string {
  const hashInput = options
    ? sha256Json({ url, optionsHash: sha256(JSON.stringify(options)) })
    : sha256(url);
  return contentCacheKey(hashInput, "resource-extraction");
}

/**
 * Distinguish base curriculum cache from student-specific assembly.
 * Base curriculum is reusable across all student requests for the same topic + grade.
 * Student assembly must include all 7 form fields to avoid silent input omission.
 */

/** Fields captured from GenerateForm — the canonical identity of a student request */
export interface AssemblyRequest {
  topic: string;
  grade_level: string;
  difficulty: string;
  existing_knowledge: string;
  learning_goal: string;
  time_available: string;
  added_context: string | null;
}

/** Base curriculum cache key: topic + grade level (reusable across students) */
export function baseCurriculumKey(topic: string, gradeLevel: string | undefined): string {
  const input = gradeLevel ? `${topic}::${gradeLevel}` : topic;
  return contentCacheKey(sha256(input), "curriculum-extraction");
}

/**
 * Student-specific assembly cache key: all 7 form fields.
 * Must include EVERY field per architecture §15:
 * "key for assembly must include all inputs that affect output"
 * Added_context is optional but when present must be in the hash.
 */
export function studentAssemblyKey(request: AssemblyRequest): string {
  // Build an object sorted deterministically so identical values produce identical keys
  // even if passed as different property orders (sha256Json handles this)
  return contentCacheKey(
    sha256Json({
      topic: request.topic,
      grade_level: request.grade_level,
      difficulty: request.difficulty,
      existing_knowledge: request.existing_knowledge,
      learning_goal: request.learning_goal,
      time_available: request.time_available,
      added_context: request.added_context ?? "",
    }),
    "curriculum-extraction"
  );
}

/** Resource verification cache key from content hash */
export function resourceVerificationKey(contentHash: string): string {
  return contentCacheKey(contentHash, "resource-verification");
}