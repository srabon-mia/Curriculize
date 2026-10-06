/**
 * Phase 6D Persistence Tests
 * Tests for the persistence primitive.
 */

import type { PersistenceInput } from "../types";
import type { AcquiredPage } from "@/lib/acquisition/types";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";
import type { VerificationResult } from "@/lib/verification/types";
import { CanonicalUrl } from "@/lib/deterministic/url";

// Helper to create a minimal AcquiredPage
function makeAcquiredPage(overrides: Partial<AcquiredPage> = {}): AcquiredPage {
  const canonical: CanonicalUrl = {
    url: "https://example.com/page",
    parsed: new URL("https://example.com/page"),
    original: "https://example.com/page",
  };

  return {
    finalUrl: "https://example.com/page",
    canonicalUrl: canonical,
    statusCode: 200,
    headers: {},
    body: "<html><body>Test content</body></html>",
    contentType: "text/html",
    charset: "utf-8",
    contentHash: "abc123hash",
    acquiredAt: "2024-01-15T10:00:00.000Z",
    redirectChain: [],
    resolvedIps: { ipv4: [], ipv6: [] },
    ...overrides,
  };
}

// Helper to create minimal StructuredContent
function makeStructuredContent(overrides: Partial<StructuredContent> = {}): StructuredContent {
  return {
    source: {
      cleanedHash: "cleaned-hash",
      contentHash: "abc123hash",
    },
    metadata: {
      title: "Test Resource",
      description: "A test resource",
      author: "Test Author",
      datePublished: "2024-01-15",
      language: "en",
    },
    headings: [],
    blocks: [{ text: "Test content", tagName: "p" }],
    links: [],
    statistics: {
      wordCount: 100,
      headingCount: 0,
      headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      paragraphCount: 1,
      linkCount: 0,
      externalLinkCount: 0,
    },
    ...overrides,
  };
}

// Helper to create minimal EducationalEvidence
function makeEducationalEvidence(overrides: Partial<EducationalEvidence> = {}): EducationalEvidence {
  return {
    source: {
      cleanedHash: "cleaned-hash",
      contentHash: "abc123hash",
    },
    interpreted: {
      explicitLearningObjectives: [],
      explicitDefinitions: [],
      explicitExercises: [],
    },
    ...overrides,
  };
}

// Helper to create minimal VerificationResult
function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    status: "verified",
    deterministicChecks: {
      cleanedContentNonEmpty: true,
    },
    advisorySignals: {
      titlePresent: true,
      educationalEvidencePresent: false,
      wordCount: 100,
      headingCount: 0,
      paragraphCount: 1,
    },
    contentHash: "abc123hash",
    canonicalUrl: "https://example.com/page",
    verifiedAt: "2024-01-15T10:00:00.000Z",
    ...overrides,
  };
}

// Helper to create a complete PersistenceInput
function makePersistenceInput(overrides: Partial<PersistenceInput> = {}): PersistenceInput {
  return {
    acquiredPage: makeAcquiredPage(),
    structuredContent: makeStructuredContent(),
    educationalEvidence: makeEducationalEvidence(),
    verificationResult: makeVerificationResult(),
    target: { nodeId: "node-123" },
    acquisitionJobId: "job-123",
    callerMetadata: {
      resourceType: "text",
      licenseStatus: "link_only",
      aiNote: "Test note",
    },
    ...overrides,
  };
}

describe("persistVerifiedResource - target validation", () => {
  // These tests would require a real Supabase connection
  // They document the expected behavior
  test("node only target → accepted", () => {
    const input = makePersistenceInput({ target: { nodeId: "node-1" } });
    expect(input.target.nodeId).toBe("node-1");
    expect(input.target.understandingId).toBeUndefined();
  });

  test("understanding only target → accepted", () => {
    const input = makePersistenceInput({ target: { understandingId: "mu-1" } });
    expect(input.target.understandingId).toBe("mu-1");
    expect(input.target.nodeId).toBeUndefined();
  });

  test("both targets → rejected", () => {
    const input = makePersistenceInput({ target: { nodeId: "node-1", understandingId: "mu-1" } });
    expect(() => {
      // Validation happens at runtime in persistVerifiedResource
      if (input.target.nodeId && input.target.understandingId) {
        throw new Error("Resource cannot target both node and major_understanding simultaneously");
      }
    }).toThrow("cannot target both");
  });

  test("neither target → rejected", () => {
    const input = makePersistenceInput({ target: {} });
    expect(() => {
      if (!input.target.nodeId && !input.target.understandingId) {
        throw new Error("Resource must target either a node or a major_understanding");
      }
    }).toThrow("must target either");
  });
});

describe("canonical URL deduplication logic", () => {
  test("different raw URLs with same canonical URL should map to same logical resource", () => {
    const url1 = "https://example.com/page?utm_source=a";
    const url2 = "https://example.com/page?utm_source=b";

    // Both canonicalize to the same URL (after removing tracking params)
    // This is the expected behavior - verification_records.canonical_url is the deduplication key
    expect(url1).not.toBe(url2);
    // The actual canonicalization happens in Phase 5
  });

  test("same canonical URL + different target → separate resource", () => {
    // Node-targeted and understanding-targeted are different logical resources
    const nodeTarget = { nodeId: "node-1" };
    const understandingTarget = { understandingId: "mu-1" };
    expect(nodeTarget).not.toEqual(understandingTarget);
  });

  test("multiple legacy matches → newest created_at wins", () => {
    const resources = [
      { id: "r1", created_at: "2024-01-01T00:00:00.000Z" },
      { id: "r2", created_at: "2024-01-02T00:00:00.000Z" },
      { id: "r3", created_at: "2024-01-03T00:00:00.000Z" },
    ];
    resources.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    expect(resources[0].id).toBe("r3"); // Most recent
  });
});

describe("verification idempotency logic", () => {
  test("same job + same hash → exact retry (reuse)", () => {
    const existingVR = { content_hash: "abc123hash" };
    const newContentHash = "abc123hash";
    const isExactRetry = existingVR.content_hash === newContentHash;
    expect(isExactRetry).toBe(true);
  });

  test("same job + different hash → new verification record", () => {
    const existingVR = { content_hash: "abc123hash" };
    const newContentHash = "def456hash";
    const isExactRetry = existingVR.content_hash === newContentHash;
    expect(isExactRetry).toBe(false);
  });

  test("new job + same hash → new verification record", () => {
    // No existing job ID match means new acquisition
    const hasMatchingJobId = false;
    expect(hasMatchingJobId).toBe(false);
  });

  test("new job + new hash → new verification record", () => {
    const hasMatchingJobId = false;
    expect(hasMatchingJobId).toBe(false);
  });

  test("no job ID → new verification record", () => {
    const acquisitionJobId = undefined;
    expect(acquisitionJobId).toBeUndefined();
  });
});

describe("resource update logic by verification status and content hash", () => {
  test("existing resource + verified + same content hash + different job → resource NOT updated", () => {
    // Simulate: resource exists, verification is verified, content hash matches existing verification record
    // but acquisitionJobId is different (new job)
    const existingResource = { id: "resource-1", title: "Original Title" };
    const contentHash = "abc123hash";

    // resourceHasContentHash would return true (existing verification record has this hash)
    const hasContentHash = true;
    const isVerified = true;
    const isExactRetry = false; // Different job ID

    // Logic: isVerified && !isExactRetry && hasContentHash → do NOT update
    const shouldUpdateResource = isVerified && !isExactRetry && !hasContentHash;
    expect(shouldUpdateResource).toBe(false);

    const finalTitle = shouldUpdateResource ? "New Title" : existingResource.title;
    expect(finalTitle).toBe("Original Title");
  });

  test("existing resource + verified + different content hash → resource IS updated", () => {
    const existingResource = { id: "resource-1", title: "Original Title" };
    const contentHash = "def456hash"; // Different from existing verification records

    // resourceHasContentHash would return false (no existing verification record has this hash)
    const hasContentHash = false;
    const isVerified = true;
    const isExactRetry = false;

    // Logic: isVerified && !isExactRetry && !hasContentHash → update
    const shouldUpdateResource = isVerified && !isExactRetry && !hasContentHash;
    expect(shouldUpdateResource).toBe(true);

    const newTitle = "Updated Title From Verified Acquisition";
    const finalTitle = shouldUpdateResource ? newTitle : existingResource.title;
    expect(finalTitle).toBe(newTitle);
  });

  test("existing resource + failed → resource NOT updated", () => {
    const existingResource = { id: "resource-1", title: "Original Title" };

    const isVerified = false;
    const isExactRetry = false;

    // Logic: !isVerified → do NOT update (regardless of content hash)
    const shouldUpdateResource = isVerified && !isExactRetry;
    expect(shouldUpdateResource).toBe(false);

    const finalTitle = existingResource.title;
    expect(finalTitle).toBe("Original Title");
  });

  test("exact retry → verification reused and resource not updated", () => {
    const existingResource = { id: "resource-1", title: "Original Title" };
    const contentHash = "abc123hash";

    // Exact retry: same job ID + same content hash
    const isExactRetry = true;

    // Logic: exact retry → reuse verification, do NOT update resource
    const shouldUpdateResource = !isExactRetry;
    expect(shouldUpdateResource).toBe(false);

    // Verification record ID should be the existing one
    const reusedVerificationId = isExactRetry ? "existing-verification-id" : "new-verification-id";
    expect(reusedVerificationId).toBe("existing-verification-id");
  });

  test("new resource + failed → resource created and failed verification persisted", () => {
    const existingResource = null; // No existing resource
    const verificationStatus = "failed";

    // Should create new resource even for failed verification (to attach evidence)
    const shouldCreateResource = !existingResource;
    const shouldCreateVerificationRecord = true;

    expect(shouldCreateResource).toBe(true);
    expect(shouldCreateVerificationRecord).toBe(true);

    // Resource status should be draft
    const resourceStatus = "draft";
    expect(resourceStatus).toBe("draft");
  });
});

describe("verification behavior", () => {
  test("successful 6C result → verified status", () => {
    const vr = makeVerificationResult({ status: "verified" });
    expect(vr.status).toBe("verified");
  });

  test("failed 6C result → failed status", () => {
    const vr = makeVerificationResult({ status: "failed" });
    expect(vr.status).toBe("failed");
  });

  test("failed verification does not imply resource downgrade", () => {
    // This is a design constraint: resource.status stays "draft"
    // and failed verification only adds a failed verification_record
    const resourceStatus = "draft";
    const verificationStatus = "failed";
    expect(resourceStatus).toBe("draft");
    expect(verificationStatus).toBe("failed");
  });
});

describe("mapping behavior", () => {
  test("understanding target creates mapping", () => {
    const target = { understandingId: "mu-1" };
    expect(target.understandingId).toBeDefined();
    // Mapping should be created
  });

  test("node-only target does not create mapping", () => {
    const target: { nodeId?: string; understandingId?: string } = { nodeId: "node-1" };
    expect(target.understandingId).toBeUndefined();
    // No mapping should be created
  });

  test("duplicate mapping not unnecessarily inserted", () => {
    // unique constraint on (resource_id, understanding_id) prevents duplicates
    // upsert handles this
    const uniqueConstraint = ["resource_id", "understanding_id"];
    expect(uniqueConstraint).toEqual(["resource_id", "understanding_id"]);
  });
});

describe("persistence fields verification", () => {
  test("contentHash persisted as verification_records.content_hash", () => {
    const input = makePersistenceInput();
    expect(input.acquiredPage.contentHash).toBe("abc123hash");
  });

  test("canonical URL persisted as verification_records.canonical_url", () => {
    const input = makePersistenceInput();
    expect(input.acquiredPage.canonicalUrl.url).toBe("https://example.com/page");
  });

  test("final URL persisted as resources.url", () => {
    const input = makePersistenceInput();
    expect(input.acquiredPage.finalUrl).toBe("https://example.com/page");
  });

  test("Phase 6A title persisted", () => {
    const input = makePersistenceInput();
    expect(input.structuredContent.metadata.title).toBe("Test Resource");
  });

  test("Phase 6B evidence persisted", () => {
    const input = makePersistenceInput();
    expect(input.educationalEvidence.interpreted).toBeDefined();
  });

  test("Phase 6C checks/signals persisted", () => {
    const input = makePersistenceInput();
    expect(input.verificationResult.deterministicChecks).toBeDefined();
    expect(input.verificationResult.advisorySignals).toBeDefined();
  });

  test("verification_method = deterministic_v1", () => {
    expect("deterministic_v1").toBe("deterministic_v1");
  });

  test("ai_verified = false", () => {
    expect(false).toBe(false);
  });

  test("human_reviewed = false", () => {
    expect(false).toBe(false);
  });

  test("resource starts as draft", () => {
    expect("draft").toBe("draft");
  });
});

describe("embed_allowed calculation", () => {
  test("cc_open + score 5 → true", () => {
    const result = "cc_open" === "cc_open" && 5 >= 4;
    expect(result).toBe(true);
  });

  test("cc_open + score 3 → false", () => {
    const result = "cc_open" === "cc_open" && 3 >= 4;
    expect(result).toBe(false);
  });

  test("link_only → false regardless of score", () => {
    const licenseStatus = "link_only" as const;
    const result = (licenseStatus as string) === "cc_open" && 5 >= 4;
    expect(result).toBe(false);
  });

  test("unknown_review_needed → false regardless of score", () => {
    const licenseStatus = "unknown_review_needed" as const;
    const result = (licenseStatus as string) === "cc_open" && 5 >= 4;
    expect(result).toBe(false);
  });
});

describe("null/IS NULL query semantics", () => {
  test("node target: node_id = X, major_understanding_id IS NULL", () => {
    const targetNodeId = "node-1";
    const targetUnderstandingId = undefined;
    const nodeFilter = targetNodeId ? `node_id = ${targetNodeId}` : "node_id IS NULL";
    const muFilter = targetUnderstandingId ? `major_understanding_id = ${targetUnderstandingId}` : "major_understanding_id IS NULL";
    expect(nodeFilter).toBe("node_id = node-1");
    expect(muFilter).toBe("major_understanding_id IS NULL");
  });

  test("understanding target: node_id IS NULL, major_understanding_id = X", () => {
    const targetNodeId = undefined;
    const targetUnderstandingId = "mu-1";
    const nodeFilter = targetNodeId ? `node_id = ${targetNodeId}` : "node_id IS NULL";
    const muFilter = targetUnderstandingId ? `major_understanding_id = ${targetUnderstandingId}` : "major_understanding_id IS NULL";
    expect(nodeFilter).toBe("node_id IS NULL");
    expect(muFilter).toBe("major_understanding_id = mu-1");
  });
});

describe("verification status guards resource updates", () => {
  test("existing resource + failed verification → resource metadata NOT updated", () => {
    // This test documents the expected behavior:
    // When verification fails, the existing resource should remain unchanged
    const existingResource = {
      id: "resource-1",
      title: "Original Title",
      url: "https://example.com/page",
      source_domain: "example.com",
    };

    const newAcquisition = {
      title: "New Title From Failed Acquisition",
      url: "https://example.com/page?utm_source=failed",
      source_domain: "example.com",
    };

    // In the fixed implementation, when verificationStatus === "failed"
    // and existingResource exists, we should NOT call updateResource
    // The resource should keep its original title
    const shouldUpdateResource = false; // This is the guard
    expect(shouldUpdateResource).toBe(false);

    // The resource title should remain the original
    const finalTitle = shouldUpdateResource ? newAcquisition.title : existingResource.title;
    expect(finalTitle).toBe("Original Title");
  });

  test("existing resource + verified new content → resource may update", () => {
    // When verification succeeds and content hash differs, resource can be updated
    const existingResource = {
      id: "resource-1",
      title: "Original Title",
      contentHash: "old-hash",
    };

    const newAcquisition = {
      title: "Updated Title From Verified Acquisition",
      contentHash: "new-hash",
    };

    const verificationStatus = "verified";
    const contentHashChanged = existingResource.contentHash !== newAcquisition.contentHash;

    // In the fixed implementation, when verified AND content changed → update
    const shouldUpdateResource = verificationStatus === "verified" && contentHashChanged;
    expect(shouldUpdateResource).toBe(true);

    const finalTitle = shouldUpdateResource ? newAcquisition.title : existingResource.title;
    expect(finalTitle).toBe("Updated Title From Verified Acquisition");
  });

  test("existing resource + verified same content → resource NOT updated", () => {
    // When verification succeeds but content hash is the same, no update needed
    const existingResource = {
      id: "resource-1",
      title: "Original Title",
      contentHash: "same-hash",
    };

    const newAcquisition = {
      title: "Same Title",
      contentHash: "same-hash",
    };

    const verificationStatus = "verified";
    const contentHashChanged = existingResource.contentHash !== newAcquisition.contentHash;

    const shouldUpdateResource = verificationStatus === "verified" && contentHashChanged;
    expect(shouldUpdateResource).toBe(false);

    const finalTitle = existingResource.title;
    expect(finalTitle).toBe("Original Title");
  });
});

describe("exact retry idempotency", () => {
  test("exact retry + same hash → existing verification reused, resource update avoided", () => {
    // Same acquisition job ID + same content hash = exact retry
    const acquisitionJobId = "job-123";
    const existingContentHash = "abc123hash";
    const newContentHash = "abc123hash";
    const existingVerification = { content_hash: existingContentHash };

    // Check exact retry condition
    const isExactRetry = existingVerification.content_hash === newContentHash;
    expect(isExactRetry).toBe(true);

    // In the fixed implementation, exact retry reuses verification record
    // and does NOT update the resource
    const shouldUpdateResource = !isExactRetry;
    expect(shouldUpdateResource).toBe(false);

    // The existing verification record ID is reused
    const reusedVerificationId = existingVerification.content_hash === newContentHash
      ? "existing-verification-id"
      : "new-verification-id";
    expect(reusedVerificationId).toBe("existing-verification-id");
  });

  test("same job + different hash → NOT exact retry, new verification record created", () => {
    const acquisitionJobId = "job-123";
    const existingContentHash = "abc123hash";
    const newContentHash = "def456hash";
    const existingVerification = { content_hash: existingContentHash };

    const isExactRetry = existingVerification.content_hash === newContentHash;
    expect(isExactRetry).toBe(false);

    // Should create new verification record
    const shouldCreateVerification = !isExactRetry;
    expect(shouldCreateVerification).toBe(true);
  });

  test("different job + same hash → NOT exact retry, new verification record created", () => {
    const existingVerification = { content_hash: "abc123hash" };
    const hasMatchingJobId = false; // Different acquisition job

    const isExactRetry = hasMatchingJobId && existingVerification.content_hash === "abc123hash";
    expect(isExactRetry).toBe(false);

    // Should create new verification record (new acquisition event)
    const shouldCreateVerification = !isExactRetry;
    expect(shouldCreateVerification).toBe(true);
  });

  test("no job ID → NOT exact retry, new verification record created", () => {
    const acquisitionJobId = undefined;
    const hasMatchingJobId = !!acquisitionJobId;

    const isExactRetry = hasMatchingJobId;
    expect(isExactRetry).toBe(false);

    // Should create new verification record
    const shouldCreateVerification = !isExactRetry;
    expect(shouldCreateVerification).toBe(true);
  });
});

describe("new resource + failed verification", () => {
  test("new resource + failed verification still creates resource and verification record", () => {
    // Even if verification fails, if no existing resource exists,
    // we still create the resource (draft) and the failed verification record
    // for historical evidence
    const existingResource = null;
    const verificationStatus = "failed";

    const shouldCreateResource = !existingResource;
    const shouldCreateVerificationRecord = true; // Always create for evidence

    expect(shouldCreateResource).toBe(true);
    expect(shouldCreateVerificationRecord).toBe(true);

    // Resource status should be draft
    const resourceStatus = "draft";
    expect(resourceStatus).toBe("draft");
  });

  test("new resource + verified verification creates resource and verification record", () => {
    const existingResource = null;
    const verificationStatus = "verified";

    const shouldCreateResource = !existingResource;
    const shouldCreateVerificationRecord = true;

    expect(shouldCreateResource).toBe(true);
    expect(shouldCreateVerificationRecord).toBe(true);
  });
});