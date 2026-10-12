/**
 * Phase 6 Comprehensive Integration Test
 * Tests the composition of Phase 5 → 6A → 6B → 6C → 6D
 *
 * Uses REAL implementations of:
 * - Phase 5: buildCleanedDocument, serializeCleanedDocument
 * - Phase 6A: extractStructuredContentFromDoc
 * - Phase 6B: extractEducationalEvidence
 * - Phase 6C: verifyContent, validateVerificationInput
 *
 * Uses a mock Supabase client for Phase 6D persistence tests.
 */

import { runPipeline, runFullPipelineWithMockDb } from "./pipeline";
import { ALL_FIXTURES, FIXTURE_MAP } from "./fixtures";
import { MockSupabaseClient } from "./mock-supabase";

describe("Phase 6 Integration Pipeline (5 → 6A → 6B → 6C → 6D)", () => {
  // =========================================================================
  // Pure Pipeline Tests (5 → 6A → 6B → 6C)
  // These exercise the REAL implementations with NO mocking.
  // =========================================================================
  describe("Pure Pipeline (5 → 6A → 6B → 6C)", () => {
    test.each(ALL_FIXTURES)(
      "runs pipeline correctly for fixture",
      (fixture) => {
        const pipeline = runPipeline(fixture);

        // Validate hashes are preserved across phases
        expect(pipeline.structuredContent.source.contentHash).toBe(
          fixture.contentHash
        );
        expect(pipeline.educationalEvidence.source.contentHash).toBe(
          fixture.contentHash
        );

        // Cleaned hash should be a valid SHA-256 (64 hex chars)
        expect(pipeline.structuredContent.source.cleanedHash).toHaveLength(64);
        expect(pipeline.educationalEvidence.source.cleanedHash).toHaveLength(64);
      }
    );

    test("Phase 6A resolves relative URLs correctly", () => {
      const pipeline = runPipeline(FIXTURE_MAP.RELATIVE_LINKS);
      const links = pipeline.structuredContent.links;

      const chapter2Link = links.find((l) => l.text === "Chapter 2");
      const appendixLink = links.find((l) => l.text === "Appendix");
      const externalLink = links.find((l) => l.text === "Other Site");

      expect(chapter2Link?.href).toBe("https://example.com/chapter2");
      expect(appendixLink?.href).toBe("https://example.com/appendix");
      expect(externalLink?.href).toBe("https://other.com/resource");
    });

    test("Phase 6A resolves relative links against correct base URL", () => {
      const pipeline = runPipeline(FIXTURE_MAP.RELATIVE_LINKS);

      // Verify the canonical URL base is preserved
      expect(pipeline.verificationResult.canonicalUrl).toBe(
        FIXTURE_MAP.RELATIVE_LINKS.canonicalUrl.url
      );

      // 6D should not replace canonical source URL with page links
      const links = pipeline.structuredContent.links;
      const allHrefs = links.map((l) => l.href);
      expect(allHrefs).not.toContain(
        FIXTURE_MAP.RELATIVE_LINKS.canonicalUrl.url
      );
    });

    test("Phase 6B extracts educational evidence correctly", () => {
      const pipeline = runPipeline(FIXTURE_MAP.STANDARD_EDUCATIONAL);

      const {
        explicitLearningObjectives,
        explicitDefinitions,
        explicitExercises,
      } = pipeline.educationalEvidence.interpreted;

      expect(explicitLearningObjectives).toHaveLength(2);
      expect(explicitLearningObjectives[0].text).toContain(
        "Students will be able to solve quadratic equations"
      );
      expect(explicitLearningObjectives[0].confidence).toBe("high");

      expect(explicitDefinitions).toHaveLength(2);
      expect(explicitDefinitions[0].text).toContain(
        "A quadratic equation is defined as"
      );

      // 4 matches: "Practice Problems:" heading + 3 numbered problems
      expect(explicitExercises).toHaveLength(4);
      expect(explicitExercises[0].text).toBe("Practice Problems:");
      expect(explicitExercises[1].text).toMatch(/^1\. Solve x²/);
    });

    test("Phase 6B detects definitions-only content", () => {
      const pipeline = runPipeline(FIXTURE_MAP.DEFINITIONS_ONLY);
      const evidence = pipeline.educationalEvidence.interpreted;

      expect(evidence.explicitDefinitions.length).toBeGreaterThan(0);
      expect(evidence.explicitLearningObjectives.length).toBe(0);
      expect(evidence.explicitExercises.length).toBe(0);
    });

    test("Phase 6B detects exercises-only content", () => {
      const pipeline = runPipeline(FIXTURE_MAP.EXERCISES_ONLY);
      const evidence = pipeline.educationalEvidence.interpreted;

      expect(evidence.explicitExercises.length).toBeGreaterThan(0);
      expect(evidence.explicitLearningObjectives.length).toBe(0);
    });

    test("Phase 6C verification — verified for non-empty content", () => {
      const pipeline = runPipeline(FIXTURE_MAP.STANDARD_EDUCATIONAL);
      expect(pipeline.verificationResult.status).toBe("verified");
      expect(
        pipeline.verificationResult.deterministicChecks.cleanedContentNonEmpty
      ).toBe(true);
    });

    test("Phase 6C verification — failed for empty content", () => {
      const pipeline = runPipeline(FIXTURE_MAP.EMPTY_CONTENT);
      expect(pipeline.verificationResult.status).toBe("failed");
      expect(
        pipeline.verificationResult.deterministicChecks.cleanedContentNonEmpty
      ).toBe(false);
    });

    test("Phase 6C verification — minimal content (1 word) still verified", () => {
      const pipeline = runPipeline(FIXTURE_MAP.MINIMAL_CONTENT);
      expect(pipeline.verificationResult.status).toBe("verified");
      expect(pipeline.verificationResult.advisorySignals.wordCount).toBe(1);
    });

    test("Phase 6A title precedence: <title> tag wins", () => {
      const pipeline = runPipeline(FIXTURE_MAP.STANDARD_EDUCATIONAL);
      expect(pipeline.structuredContent.metadata.title).toBe(
        "Quadratic Equations - Complete Lesson"
      );
    });

    test("Phase 6C hashes trace correctly through pipeline", () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const pipeline = runPipeline(fixture);

      const rawHash = fixture.contentHash;

      expect(pipeline.structuredContent.source.contentHash).toBe(rawHash);
      expect(pipeline.educationalEvidence.source.contentHash).toBe(rawHash);
      expect(pipeline.verificationResult.contentHash).toBe(rawHash);

      // Cleaned hash must be a different value
      const cleanedHash = pipeline.structuredContent.source.cleanedHash;
      expect(cleanedHash).not.toBe(rawHash);
    });
  });

  // =========================================================================
  // Persistence Tests (6D) with Mock Database
  // =========================================================================
  describe("Persistence (6D) with Mock Database", () => {
    test("TEST 1 — Happy-path full pipeline (5 → 6A → 6B → 6C → 6D)", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-123" };
      const mockClient = new MockSupabaseClient();

      const { result, pipeline } = await runFullPipelineWithMockDb(
        fixture,
        target,
        "job-123",
        undefined,
        5, // domain score 5
        mockClient
      );

      // Verify resource was created
      expect(result.resource.isNew).toBe(true);
      expect(result.resource.title).toBe("Quadratic Equations - Complete Lesson");
      expect(result.resource.url).toBe(fixture.finalUrl);
      expect(result.resource.nodeId).toBe("node-123");
      expect(result.resource.majorUnderstandingId).toBeNull();

      // Verify verification record was created
      expect(result.verificationRecord.isExactRetry).toBe(false);
      expect(result.verificationRecord.status).toBe("verified");
      expect(result.verificationRecord.contentHash).toBe(fixture.contentHash);
      expect(result.verificationRecord.canonicalUrl).toBe(fixture.canonicalUrl.url);

      // Verify hash invariants
      const hash = fixture.contentHash;
      expect(pipeline.structuredContent.source.contentHash).toBe(hash);
      expect(pipeline.educationalEvidence.source.contentHash).toBe(hash);
      expect(result.verificationRecord.contentHash).toBe(hash);

      // Cleaned hash is preserved and distinct
      expect(pipeline.structuredContent.source.cleanedHash).toBe(
        pipeline.educationalEvidence.source.cleanedHash
      );
      expect(pipeline.structuredContent.source.cleanedHash).not.toBe(hash);

      // Verify content evidence was persisted
      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(1);
      expect(vrRows[0].content_evidence).toContain(
        JSON.stringify(pipeline.educationalEvidence.interpreted)
      );

      // Verify advisory signals persisted
      const checks = JSON.parse(vrRows[0].deterministic_checks as string);
      expect(checks.titlePresent).toBe(true);
      expect(checks.educationalEvidencePresent).toBe(true);
      expect(checks.wordCount).toBe(pipeline.structuredContent.statistics.wordCount);
    });

    test("TEST 2 — Empty-content / failed verification persists evidence", async () => {
      const fixture = FIXTURE_MAP.EMPTY_CONTENT;
      const target = { nodeId: "node-456" };
      const mockClient = new MockSupabaseClient();

      const { result, pipeline } = await runFullPipelineWithMockDb(
        fixture,
        target,
        "job-empty",
        undefined,
        undefined,
        mockClient
      );

      // Should have failed verification
      expect(pipeline.verificationResult.status).toBe("failed");
      expect(
        pipeline.verificationResult.deterministicChecks.cleanedContentNonEmpty
      ).toBe(false);

      // Should still create resource (to hold evidence)
      expect(result.resource.isNew).toBe(true);
      expect(result.resource.status).toBe("draft");

      // Verification record should reflect failed status
      expect(result.verificationRecord.status).toBe("failed");
      expect(result.verificationRecord.isExactRetry).toBe(false);

      // content_type_verified should be false for failed verification (bug fix)
      expect(result.resource.contentTypeVerified).toBe(false);

      // Evidence persisted even for failed
      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(1);
      expect(vrRows[0].content_evidence).toBe(
        JSON.stringify(pipeline.educationalEvidence.interpreted)
      );
    });

    test("TEST 2b — New resource + successful verification → content_type_verified is true", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-verified-new" };
      const mockClient = new MockSupabaseClient();

      const { result, pipeline } = await runFullPipelineWithMockDb(
        fixture,
        target,
        "job-verified-new",
        undefined,
        5,
        mockClient
      );

      expect(pipeline.verificationResult.status).toBe("verified");
      expect(result.resource.isNew).toBe(true);
      expect(result.resource.contentTypeVerified).toBe(true);
      expect(result.verificationRecord.status).toBe("verified");
    });

    test("TEST 2c — Existing verified resource + failed verification → content_type_verified remains true", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-fail-existing" };
      const mockClient = new MockSupabaseClient();

      // First: create a verified resource
      const { result: verifiedResult } = await runFullPipelineWithMockDb(
        fixture, target, "job-verified", undefined, 5, mockClient
      );
      expect(verifiedResult.resource.isNew).toBe(true);
      expect(verifiedResult.resource.contentTypeVerified).toBe(true);
      const originalTitle = verifiedResult.resource.title;

      // Second: same target, but empty content (fails verification)
      const { result: failedResult } = await runFullPipelineWithMockDb(
        FIXTURE_MAP.EMPTY_CONTENT, target, "job-failed", undefined, 5, mockClient
      );

      // Existing resource should NOT be updated or downgraded
      expect(failedResult.resource.isNew).toBe(false);
      expect(failedResult.resource.title).toBe(originalTitle);
      expect(failedResult.resource.status).toBe("draft");
      expect(failedResult.resource.contentTypeVerified).toBe(true); // unchanged
      expect(failedResult.verificationRecord.status).toBe("failed");

      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(2);
      expect(vrRows.some((r) => r.status === "verified")).toBe(true);
      expect(vrRows.some((r) => r.status === "failed")).toBe(true);
    });

    test("TEST 2d — Existing resource + successful verification with new content hash → content_type_verified is true", async () => {
      const target = { nodeId: "node-content-change" };
      const mockClient = new MockSupabaseClient();

      // First acquisition with verified content
      const { result: resultA } = await runFullPipelineWithMockDb(
        FIXTURE_MAP.STANDARD_EDUCATIONAL, target, "job-content-A", undefined, 5, mockClient
      );
      expect(resultA.resource.isNew).toBe(true);
      expect(resultA.resource.contentTypeVerified).toBe(true);

      // Second acquisition: different content (verified) → resource should be updated
      const { result: resultB } = await runFullPipelineWithMockDb(
        FIXTURE_MAP.CHANGED_CONTENT, target, "job-content-B", undefined, 5, mockClient
      );

      expect(resultB.resource.isNew).toBe(false);
      expect(resultB.resource.contentTypeVerified).toBe(true);
      expect(resultB.resource.title).toBe("Quadratic Equations - Updated");

      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(2);
      expect(vrRows[0].content_hash).toBe(FIXTURE_MAP.STANDARD_EDUCATIONAL.contentHash);
      expect(vrRows[1].content_hash).toBe(FIXTURE_MAP.CHANGED_CONTENT.contentHash);

      // Same resource, different VRs
      expect(vrRows[0].resource_id).toBe(vrRows[1].resource_id);
    });

    test("TEST 3 — Same acquisition job + same content hash (exact retry)", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-789" };
      const mockClient = new MockSupabaseClient();
      const jobId = "job-repeat";

      // First acquisition
      const { result: firstResult } = await runFullPipelineWithMockDb(
        fixture, target, jobId, undefined, 5, mockClient
      );

      // Second acquisition: same job + same content = exact retry
      const { result: secondResult } = await runFullPipelineWithMockDb(
        fixture, target, jobId, undefined, 5, mockClient
      );

      expect(firstResult.resource.isNew).toBe(true);
      expect(firstResult.verificationRecord.isExactRetry).toBe(false);
      expect(secondResult.resource.isNew).toBe(false);
      expect(secondResult.verificationRecord.isExactRetry).toBe(true);

      // Resource should NOT be updated on retry
      expect(firstResult.resource.title).toBe(secondResult.resource.title);

      // Only one verification record (reused)
      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(1);
    });

    test("TEST 4 — Different job + same content hash (new verification record)", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-999" };
      const mockClient = new MockSupabaseClient();

      const { result: resultA } = await runFullPipelineWithMockDb(
        fixture, target, "job-A", undefined, 5, mockClient
      );
      const { result: resultB } = await runFullPipelineWithMockDb(
        fixture, target, "job-B", undefined, 5, mockClient
      );

      expect(resultA.resource.isNew).toBe(true);
      expect(resultA.verificationRecord.isExactRetry).toBe(false);

      // Second: same content, different job → NOT exact retry, resource unchanged
      expect(resultB.resource.isNew).toBe(false);
      expect(resultB.verificationRecord.isExactRetry).toBe(false);

      expect(resultA.resource.title).toBe(resultB.resource.title);

      // Two verification records, both point to same resource
      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(2);
      expect(vrRows[0].id).not.toBe(vrRows[1].id);
      expect(vrRows[0].content_hash).toBe(fixture.contentHash);
      expect(vrRows[1].content_hash).toBe(fixture.contentHash);
      expect(vrRows[0].resource_id).toBe(vrRows[1].resource_id);
    });

    test("TEST 5 — Different content hash (resource updated)", async () => {
      const fixtureA = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const fixtureB = FIXTURE_MAP.CHANGED_CONTENT;
      const target = { nodeId: "node-content-change" };
      const mockClient = new MockSupabaseClient();

      const { result: resultA } = await runFullPipelineWithMockDb(
        fixtureA, target, "job-content-A", undefined, 5, mockClient
      );
      const { result: resultB } = await runFullPipelineWithMockDb(
        fixtureB, target, "job-content-B", undefined, 5, mockClient
      );

      expect(resultA.resource.isNew).toBe(true);
      expect(resultA.verificationRecord.isExactRetry).toBe(false);

      // Different content → update resource representation
      expect(resultB.resource.isNew).toBe(false);
      expect(resultB.verificationRecord.isExactRetry).toBe(false);

      expect(resultA.resource.title).toBe("Quadratic Equations - Complete Lesson");
      expect(resultB.resource.title).toBe("Quadratic Equations - Updated");

      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(2);
      expect(vrRows[0].content_hash).toBe(fixtureA.contentHash);
      expect(vrRows[1].content_hash).toBe(fixtureB.contentHash);

      // Same resource, different VRs — different VR IDs, same resource_id
      expect(vrRows[0].id).not.toBe(vrRows[1].id);
      expect(vrRows[0].resource_id).toBe(vrRows[1].resource_id);
    });

    test("TEST 6 — Failed verification against existing resource (no downgrade)", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-fail-test" };
      const mockClient = new MockSupabaseClient();

      // Create verified resource
      const { result: verifiedResult } = await runFullPipelineWithMockDb(
        fixture, target, "job-verified", undefined, 5, mockClient
      );
      expect(verifiedResult.resource.isNew).toBe(true);
      const originalTitle = verifiedResult.resource.title;

      // Same target, but empty content (fails verification)
      const { result: failedResult } = await runFullPipelineWithMockDb(
        FIXTURE_MAP.EMPTY_CONTENT, target, "job-failed", undefined, 5, mockClient
      );

      // Existing resource should NOT be updated or downgraded
      expect(failedResult.resource.isNew).toBe(false);
      expect(failedResult.resource.title).toBe(originalTitle);
      expect(failedResult.resource.status).toBe("draft");
      expect(failedResult.verificationRecord.status).toBe("failed");

      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(2);
      expect(vrRows.some((r) => r.status === "verified")).toBe(true);
      expect(vrRows.some((r) => r.status === "failed")).toBe(true);
    });

    test("TEST 7 — Node target attaches to node_id only", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-111", understandingId: undefined };
      const mockClient = new MockSupabaseClient();

      const { result } = await runFullPipelineWithMockDb(
        fixture, target, "job-node", undefined, 5, mockClient
      );

      expect(result.resource.nodeId).toBe("node-111");
      expect(result.resource.majorUnderstandingId).toBeNull();

      // No mapping created for node target
      const mappings = mockClient.getRows("resource_mappings");
      expect(mappings.length).toBe(0);
    });

    test("TEST 8 — Understanding target creates mapping with medium confidence", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { understandingId: "mu-222", nodeId: undefined };
      const mockClient = new MockSupabaseClient();

      const { result } = await runFullPipelineWithMockDb(
        fixture, target, "job-mu", undefined, 5, mockClient
      );

      expect(result.resource.nodeId).toBeNull();
      expect(result.resource.majorUnderstandingId).toBe("mu-222");

      // Mapping should be created with coverage_confidence = "medium"
      const mappings = mockClient.getRows("resource_mappings");
      expect(mappings.length).toBe(1);
      expect(mappings[0].resource_id).toBe(result.resource.id);
      expect(mappings[0].understanding_id).toBe("mu-222");
      expect(mappings[0].coverage_confidence).toBe("medium");
    });

    test("TEST 8b — Duplicate mapping not inserted (unique constraint)", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { understandingId: "mu-333", nodeId: undefined };
      const mockClient = new MockSupabaseClient();

      const { result: r1 } = await runFullPipelineWithMockDb(
        fixture, target, "job-mu-dup-1", undefined, 5, mockClient
      );
      const { result: r2 } = await runFullPipelineWithMockDb(
        fixture, target, "job-mu-dup-2", undefined, 5, mockClient
      );

      const mappings = mockClient.getRows("resource_mappings");
      // Same resource_id + understanding_id → unique constraint should prevent duplicate
      // Since same content, r2 reuses resource, and mapping already exists
      expect(mappings.length).toBe(1);
      expect(r2.resourceMapping?.isNew).toBe(false);
    });

    test("TEST 9 — Invalid target combinations rejected", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;

      // nodeId + understandingId
      await expect(
        runFullPipelineWithMockDb(
          fixture,
          { nodeId: "node-1", understandingId: "mu-1" },
          "job-invalid"
        )
      ).rejects.toThrow("cannot target both");

      // null + null
      await expect(
        runFullPipelineWithMockDb(
          fixture,
          { nodeId: undefined, understandingId: undefined },
          "job-invalid"
        )
      ).rejects.toThrow("must target either");
    });

    test("TEST 10 — Canonical URL deduplication finds existing resource", async () => {
      const baseUrl = "https://example.com/same-canonical";
      const trackingUrl1 = `${baseUrl}?utm_source=test&id=123`;
      const trackingUrl2 = `${baseUrl}?utm_source=other&id=456`;
      const fixture1 = {
        ...FIXTURE_MAP.STANDARD_EDUCATIONAL,
        finalUrl: trackingUrl1,
        canonicalUrl: {
          url: baseUrl,
          parsed: new URL(baseUrl),
          original: baseUrl,
        },
        contentHash: "same-content-hash",
      };
      const fixture2 = {
        ...FIXTURE_MAP.STANDARD_EDUCATIONAL,
        finalUrl: trackingUrl2,
        canonicalUrl: {
          url: baseUrl,
          parsed: new URL(baseUrl),
          original: baseUrl,
        },
        contentHash: "same-content-hash",
      };

      const target = { nodeId: "node-dedup-test" };
      const mockClient = new MockSupabaseClient();

      // First acquisition
      const { result: result1 } = await runFullPipelineWithMockDb(
        fixture1, target, "job-dedup-1", undefined, 5, mockClient
      );
      expect(result1.resource.isNew).toBe(true);

      // Second acquisition: different URL, same canonical URL, same content
      const { result: result2 } = await runFullPipelineWithMockDb(
        fixture2, target, "job-dedup-2", undefined, 5, mockClient
      );

      // Should find existing resource via canonical_url lookup
      expect(result2.resource.isNew).toBe(false);
      expect(result2.verificationRecord.isExactRetry).toBe(false); // Different job, same content

      // Both should point to same resource
      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(2);
      expect(vrRows[0].resource_id).toBe(vrRows[1].resource_id);
      expect(vrRows[0].canonical_url).toBe(baseUrl);
      expect(vrRows[1].canonical_url).toBe(baseUrl);
    });

    test("TEST 10b — Canonical URL same but different target → separate resource", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const mockClient = new MockSupabaseClient();

      const { result: r1 } = await runFullPipelineWithMockDb(
        fixture, { nodeId: "node-A" }, "job-target-A", undefined, 5, mockClient
      );
      const { result: r2 } = await runFullPipelineWithMockDb(
        fixture, { understandingId: "mu-B" }, "job-target-B", undefined, 5, mockClient
      );

      // Different targets → different resources
      expect(r1.resource.id).not.toBe(r2.resource.id);
      expect(r1.resource.nodeId).toBe("node-A");
      expect(r2.resource.majorUnderstandingId).toBe("mu-B");

      const resources = mockClient.getRows("resources");
      expect(resources.length).toBe(2);
    });

    test("TEST 11 — Hash distinction invariant", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const mockClient = new MockSupabaseClient();

      const { pipeline } = await runFullPipelineWithMockDb(
        fixture, { nodeId: "node-hash" }, "job-hash", undefined, 5, mockClient
      );

      const contentHash = fixture.contentHash;
      const cleanedHash = pipeline.structuredContent.source.cleanedHash;

      // ContentHash must be consistent across all phases
      expect(contentHash).toBe(pipeline.structuredContent.source.contentHash);
      expect(contentHash).toBe(pipeline.educationalEvidence.source.contentHash);
      expect(contentHash).toBe(pipeline.verificationResult.contentHash);
      expect(contentHash).toBe("standard-educational-content-hash");

      // Cleaned hash must be separate
      expect(cleanedHash).toBe(pipeline.structuredContent.source.cleanedHash);
      expect(cleanedHash).toBe(pipeline.educationalEvidence.source.cleanedHash);
      expect(cleanedHash).not.toBe(contentHash);
    });

    test("TEST 12 — Phase 6B evidence survives persistence", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const mockClient = new MockSupabaseClient();

      const { pipeline } = await runFullPipelineWithMockDb(
        fixture, { nodeId: "node-ev" }, "job-evidence", undefined, 5, mockClient
      );

      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(1);

      const contentEvidence = vrRows[0].content_evidence as string;
      expect(contentEvidence).toBe(
        JSON.stringify(pipeline.educationalEvidence.interpreted)
      );

      expect(contentEvidence).toContain("explicitLearningObjectives");
      expect(contentEvidence).toContain("explicitDefinitions");
      expect(contentEvidence).toContain("explicitExercises");
    });

    test("TEST 13 — Advisory verification signals survive persistence", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const mockClient = new MockSupabaseClient();

      const { pipeline } = await runFullPipelineWithMockDb(
        fixture,
        { nodeId: "node-signals" },
        "job-signals",
        undefined,
        5,
        mockClient
      );

      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows.length).toBe(1);
      const checks = JSON.parse(vrRows[0].deterministic_checks as string);

      expect(checks.titlePresent).toBe(true);
      expect(checks.educationalEvidencePresent).toBe(true);
      expect(checks.wordCount).toBe(
        pipeline.structuredContent.statistics.wordCount
      );
      expect(checks.headingCount).toBe(
        pipeline.structuredContent.statistics.headingCount
      );
      expect(checks.paragraphCount).toBe(
        pipeline.structuredContent.statistics.paragraphCount
      );
    });

    test("TEST 14 — Relative links survive 6A, canonical URL NOT replaced", async () => {
      const fixture = FIXTURE_MAP.RELATIVE_LINKS;
      const mockClient = new MockSupabaseClient();

      const { pipeline, result } = await runFullPipelineWithMockDb(
        fixture, { nodeId: "node-links" }, "job-links", undefined, 5, mockClient
      );

      // 6A resolved relative links correctly
      const links = pipeline.structuredContent.links;
      const chapter2Link = links.find((l) => l.text === "Chapter 2");
      const appendixLink = links.find((l) => l.text === "Appendix");

      expect(chapter2Link?.href).toBe("https://example.com/chapter2");
      expect(appendixLink?.href).toBe("https://example.com/appendix");

      // 6D persisted the correct canonical URL, not a page link
      expect(result.verificationRecord.canonicalUrl).toBe(
        fixture.canonicalUrl.url
      );
    });

    test("TEST 15 — Repeated complete pipeline produces correct final state", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const target = { nodeId: "node-repeat-final" };
      const mockClient = new MockSupabaseClient();

      // Scenario 1: same job + same content (exact retry)
      const { result: r1a } = await runFullPipelineWithMockDb(
        fixture, target, "job-s1a", undefined, 5, mockClient
      );
      const { result: r1b } = await runFullPipelineWithMockDb(
        fixture, target, "job-s1a", undefined, 5, mockClient
      );

      // Scenario 2: different job + same content
      const { result: r2a } = await runFullPipelineWithMockDb(
        fixture, target, "job-s2a", undefined, 5, mockClient
      );

      // Scenario 3: different job + changed content
      const { result: r3a } = await runFullPipelineWithMockDb(
        FIXTURE_MAP.CHANGED_CONTENT, target, "job-s3a", undefined, 5, mockClient
      );

      // Scenario 4: failed content (same target)
      const { result: r4a } = await runFullPipelineWithMockDb(
        FIXTURE_MAP.EMPTY_CONTENT, target, "job-s4a", undefined, 5, mockClient
      );

      // Scenario 1: exact retry
      expect(r1a.resource.isNew).toBe(true);
      expect(r1a.verificationRecord.isExactRetry).toBe(false);
      expect(r1b.resource.isNew).toBe(false);
      expect(r1b.verificationRecord.isExactRetry).toBe(true);

      // Scenario 2: new job, same content, new verification record
      expect(r2a.resource.isNew).toBe(false);
      expect(r2a.verificationRecord.isExactRetry).toBe(false);
      expect(r1a.resource.title).toBe(r2a.resource.title);

      // Scenario 3: different content, resource updated
      expect(r3a.resource.isNew).toBe(false);
      expect(r3a.verificationRecord.isExactRetry).toBe(false);
      expect(r3a.resource.title).toBe("Quadratic Equations - Updated");

      // Scenario 4: failed verification, resource NOT downgraded
      expect(r4a.resource.isNew).toBe(false);
      expect(r4a.resource.title).toBe("Quadratic Equations - Updated"); // Unchanged
      expect(r4a.resource.status).toBe("draft");
      expect(r4a.verificationRecord.status).toBe("failed");

      // Final state check
      const resources = mockClient.getRows("resources");
      const vrs = mockClient.getRows("verification_records");

      expect(resources.length).toBe(1);

      // Verification records:
      // r1a creates VR (verified), r1b reuses (exact retry → no new VR)
      // r2a creates VR (verified, different job)
      // r3a creates VR (verified, different content hash)
      // r4a creates VR (failed)
      // Total: 4 (r1a, r2a, r3a, r4a)
      expect(vrs.length).toBe(4);

      // All VRs point to same resource
      const resourceIds = vrs.map((v: any) => v.resource_id);
      expect(new Set(resourceIds).size).toBe(1);
    });
  });

  // =========================================================================
  // Explicit Hash Invariant Test (TEST 17 from requirements)
  // =========================================================================
  describe("Hash Invariant Test", () => {
    test("raw content hash traces through all phases, cleaned hash stays separate", async () => {
      const fixture = FIXTURE_MAP.STANDARD_EDUCATIONAL;
      const mockClient = new MockSupabaseClient();

      const { result, pipeline } = await runFullPipelineWithMockDb(
        fixture, { nodeId: "node-hash-trace" }, "job-trace", undefined, 5, mockClient
      );

      const H1 = fixture.contentHash;
      const H2 = pipeline.structuredContent.source.cleanedHash;

      // All content hashes must equal H1 (the raw acquired content hash)
      expect(pipeline.structuredContent.source.contentHash).toBe(H1);
      expect(pipeline.educationalEvidence.source.contentHash).toBe(H1);
      expect(pipeline.verificationResult.contentHash).toBe(H1);
      expect(result.verificationRecord.contentHash).toBe(H1);

      // All cleaned hashes must equal H2 (hash of cleaned representation)
      expect(pipeline.structuredContent.source.cleanedHash).toBe(H2);
      expect(pipeline.educationalEvidence.source.cleanedHash).toBe(H2);

      // H1 ≠ H2
      expect(H1).not.toBe(H2);

      // Final database verification_records.content_hash must be H1
      const vrRows = mockClient.getRows("verification_records");
      expect(vrRows[0].content_hash).toBe(H1);
    });
  });
});
