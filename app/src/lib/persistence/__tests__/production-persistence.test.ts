/**
 * Production Persistence Regression Tests
 * These tests exercise the ACTUAL production persistVerifiedResource function
 * with a mocked Supabase client, verifying the real database payloads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockSupabaseClient } from "@/lib/phase6-integration/mock-supabase";
import type { PersistenceInput } from "../types";
import type { AcquiredPage } from "@/lib/acquisition/types";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";
import type { VerificationResult } from "@/lib/verification/types";
import { CanonicalUrl } from "@/lib/deterministic/url";

// ============================================================
// Mock @supabase/supabase-js to return our MockSupabaseClient
// ============================================================

const mockClient = new MockSupabaseClient();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockClient),
  createServiceClient: vi.fn(() => mockClient),
}));

// Import AFTER mock is set up
const { persistVerifiedResource } = await import("../index");
const { PersistenceError } = await import("../types");

// ============================================================
// Test Fixture Builders
// ============================================================

function makeCanonicalUrl(url: string): CanonicalUrl {
  return { url, parsed: new URL(url), original: url };
}

function makeAcquiredPage(overrides: Partial<AcquiredPage> = {}): AcquiredPage {
  return {
    finalUrl: "https://example.com/page",
    canonicalUrl: makeCanonicalUrl("https://example.com/page"),
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
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

function makeStructuredContent(overrides: Partial<StructuredContent> = {}): StructuredContent {
  return {
    source: { cleanedHash: "cleaned-hash-abc", contentHash: "abc123hash" },
    metadata: { title: "Test Resource", description: "A test resource", author: "Test Author", datePublished: "2024-01-15", language: "en" },
    headings: [{ level: 1, text: "Test Resource" }],
    blocks: [{ text: "Test content here", tagName: "p" }],
    links: [],
    statistics: {
      wordCount: 100,
      headingCount: 1,
      headingCountsByLevel: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      paragraphCount: 1,
      linkCount: 0,
      externalLinkCount: 0,
    },
    ...overrides,
  };
}

function makeEducationalEvidence(overrides: Partial<EducationalEvidence> = {}): EducationalEvidence {
  return {
    source: { cleanedHash: "cleaned-hash-abc", contentHash: "abc123hash" },
    interpreted: { explicitLearningObjectives: [], explicitDefinitions: [], explicitExercises: [] },
    ...overrides,
  };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    status: "verified",
    deterministicChecks: { cleanedContentNonEmpty: true },
    advisorySignals: { titlePresent: true, educationalEvidencePresent: false, wordCount: 100, headingCount: 1, paragraphCount: 1 },
    contentHash: "abc123hash",
    canonicalUrl: "https://example.com/page",
    verifiedAt: "2024-01-15T10:00:00.000Z",
    ...overrides,
  };
}

function makePersistenceInput(overrides: Partial<PersistenceInput> = {}): PersistenceInput {
  return {
    acquiredPage: makeAcquiredPage(),
    structuredContent: makeStructuredContent(),
    educationalEvidence: makeEducationalEvidence(),
    verificationResult: makeVerificationResult(),
    target: { nodeId: "node-123" },
    acquisitionJobId: "job-123",
    callerMetadata: { resourceType: "text", licenseStatus: "link_only", aiNote: "Test note" },
    ...overrides,
  };
}

// ============================================================
// Helper: Pre-populate mock database with an existing verified resource
// ============================================================

function setupExistingVerifiedResource(mockClient: MockSupabaseClient, overrides: {
  resourceId?: string;
  canonicalUrl?: string;
  contentHash?: string;
  title?: string;
  jobId?: string;
} = {}) {
  const resourceId = overrides.resourceId ?? "existing-resource-1";
  const canonicalUrl = overrides.canonicalUrl ?? "https://example.com/page";
  const contentHash = overrides.contentHash ?? "abc123hash";
  const title = overrides.title ?? "Test Resource";
  const jobId = overrides.jobId ?? "job-verified";

  // Insert the resource
  mockClient.insert("resources", {
    id: resourceId,
    node_id: "node-123",
    major_understanding_id: null,
    url: canonicalUrl,
    title,
    source_domain: "example.com",
    resource_type: "text",
    license_status: "link_only",
    embed_allowed: false,
    content_type_verified: true,
    ai_note: "Test note",
    status: "draft",
    created_at: "2024-01-15T10:00:00.000Z",
  });

  // Insert the verification record
  mockClient.insert("verification_records", {
    id: "existing-vr-1",
    resource_id: resourceId,
    url: canonicalUrl,
    canonical_url: canonicalUrl,
    content_hash: contentHash,
    http_status: 200,
    page_title: title,
    page_metadata: { description: "A test resource", author: "Test Author", date_published: "2024-01-15", language: "en" },
    content_evidence: "{}",
    fetched_at: "2024-01-15T10:00:00.000Z",
    verified_at: "2024-01-15T10:00:00.000Z",
    verification_method: "deterministic_v1",
    deterministic_checks: JSON.stringify({ cleanedContentNonEmpty: true, titlePresent: true, educationalEvidencePresent: false, wordCount: 100, headingCount: 1, paragraphCount: 1 }),
    ai_verified: false,
    ai_verification_notes: null,
    human_reviewed: false,
    expires_at: null,
    status: "verified",
    notes: JSON.stringify({ acquisition_job_id: jobId }),
    acquisition_job_id: jobId,
    created_at: "2024-01-15T10:00:00.000Z",
  });
}

// ============================================================
// Tests
// ============================================================

describe("Production persistVerifiedResource - Regression Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockClient.reset();
  });

  it("New resource + failed verification → insert payload contains content_type_verified: false", async () => {
    const input = makePersistenceInput({
      verificationResult: makeVerificationResult({ status: "failed" }),
    });

    const result = await persistVerifiedResource(input);

    // Verify the resource was created
    expect(result.resource.isNew).toBe(true);
    expect(result.resource.contentTypeVerified).toBe(false);

    // Verify the actual insert payload in mock database
    const resources = mockClient.getRows("resources");
    expect(resources).toHaveLength(1);
    expect(resources[0].content_type_verified).toBe(false);
    expect(resources[0].status).toBe("draft");

    // Verify verification record was created with failed status
    const vrRows = mockClient.getRows("verification_records");
    expect(vrRows).toHaveLength(1);
    expect(vrRows[0].status).toBe("failed");
  });

  it("New resource + successful verification → insert payload contains content_type_verified: true", async () => {
    const input = makePersistenceInput({
      verificationResult: makeVerificationResult({ status: "verified" }),
    });

    const result = await persistVerifiedResource(input);

    expect(result.resource.isNew).toBe(true);
    expect(result.resource.contentTypeVerified).toBe(true);

    const resources = mockClient.getRows("resources");
    expect(resources).toHaveLength(1);
    expect(resources[0].content_type_verified).toBe(true);
    expect(resources[0].status).toBe("draft");

    const vrRows = mockClient.getRows("verification_records");
    expect(vrRows).toHaveLength(1);
    expect(vrRows[0].status).toBe("verified");
  });

  it("Existing verified resource + failed verification → no resource update; state unchanged", async () => {
    // Pre-populate with an existing verified resource
    setupExistingVerifiedResource(mockClient, {
      resourceId: "existing-resource-1",
      canonicalUrl: "https://example.com/page",
      contentHash: "abc123hash",
      title: "Test Resource",
      jobId: "job-verified",
    });

    // Capture the resource state after first creation
    const resourcesAfterFirst = mockClient.getRows("resources");
    expect(resourcesAfterFirst).toHaveLength(1);
    expect(resourcesAfterFirst[0].content_type_verified).toBe(true);
    const originalTitle = resourcesAfterFirst[0].title;
    const originalId = resourcesAfterFirst[0].id;

    // Second: same target, but failed verification (different job ID)
    const failedInput = makePersistenceInput({
      verificationResult: makeVerificationResult({ status: "failed" }),
      acquisitionJobId: "job-failed",
    });
    const result = await persistVerifiedResource(failedInput);

    // Verify resource was NOT updated (same ID, same title, content_type_verified still true)
    const resources = mockClient.getRows("resources");
    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe(originalId);
    expect(resources[0].title).toBe(originalTitle);
    expect(resources[0].content_type_verified).toBe(true);
    expect(resources[0].status).toBe("draft");

    // Two verification records: one verified, one failed
    const vrRows = mockClient.getRows("verification_records");
    expect(vrRows).toHaveLength(2);
    expect(vrRows.some((r) => r.status === "verified")).toBe(true);
    expect(vrRows.some((r) => r.status === "failed")).toBe(true);

    // The failed verification record should be for the same resource
    const failedVR = vrRows.find((r) => r.status === "failed");
    expect(failedVR).toBeDefined();
    expect(failedVR!.resource_id).toBe(originalId);
  });

  it("Existing resource + verified result with changed content hash → update payload contains content_type_verified: true", async () => {
    // First: create a verified resource
    setupExistingVerifiedResource(mockClient, {
      resourceId: "existing-resource-2",
      canonicalUrl: "https://example.com/page",
      contentHash: "hash-old",
      title: "Test Resource Old",
      jobId: "job-A",
    });

    // Second: different content hash, verified
    const inputB = makePersistenceInput({
      verificationResult: makeVerificationResult({ status: "verified", contentHash: "hash-new" }),
      acquiredPage: makeAcquiredPage({ contentHash: "hash-new" }),
      acquisitionJobId: "job-B",
    });
    const resultB = await persistVerifiedResource(inputB);

    // Resource should be updated (not new)
    expect(resultB.resource.isNew).toBe(false);
    expect(resultB.resource.contentTypeVerified).toBe(true);

    // Verify the mock database has the updated content_type_verified = true
    const resources = mockClient.getRows("resources");
    expect(resources).toHaveLength(1);
    expect(resources[0].content_type_verified).toBe(true);

    // Two verification records for same resource
    const vrRows = mockClient.getRows("verification_records");
    expect(vrRows).toHaveLength(2);
    expect(vrRows[0].content_hash).toBe("hash-old");
    expect(vrRows[1].content_hash).toBe("hash-new");
    expect(vrRows[0].resource_id).toBe(vrRows[1].resource_id);
  });

  it("Exact retry → no unintended resource mutation", async () => {
    // Pre-populate with an existing resource and verification record for exact retry
    setupExistingVerifiedResource(mockClient, {
      resourceId: "existing-resource-3",
      canonicalUrl: "https://example.com/page",
      contentHash: "abc123hash",
      title: "Test Resource",
      jobId: "job-exact-retry",
    });

    // Now call with same job ID and content hash (exact retry)
    const input = makePersistenceInput({
      verificationResult: makeVerificationResult({ status: "verified" }),
      acquisitionJobId: "job-exact-retry",
    });

    const result = await persistVerifiedResource(input);

    // Should detect exact retry and NOT create new resource/VR
    expect(result.resource.isNew).toBe(false);
    expect(result.resource.contentTypeVerified).toBe(true);
    expect(result.verificationRecord.isExactRetry).toBe(true);

    // Only ONE resource and ONE verification record in database
    const resources = mockClient.getRows("resources");
    expect(resources).toHaveLength(1);

    const vrRows = mockClient.getRows("verification_records");
    expect(vrRows).toHaveLength(1); // Exact retry reuses existing VR
  });
});