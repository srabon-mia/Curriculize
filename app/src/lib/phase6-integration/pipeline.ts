/**
 * Phase 6 Pipeline Logic
 * Contains the runPipeline and runFullPipelineWithMockDb functions.
 */

import { buildCleanedDocument, serializeCleanedDocument } from "@/lib/acquisition/cleanedDocument";
import { extractStructuredContentFromDoc } from "@/lib/acquisition/structuredExtract";
import { extractEducationalEvidence } from "@/lib/evidence/deterministic";
import { verifyContent, validateVerificationInput } from "@/lib/verification/deterministic";
import type { AcquiredPage } from "@/lib/acquisition/types";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";
import { MockSupabaseClient } from "@/lib/phase6-integration/mock-supabase";

import type { VerificationResult } from "@/lib/verification/types";

export interface PipelineResult {
  cleanedDocument: ReturnType<typeof buildCleanedDocument>;
  cleanedPage: ReturnType<typeof serializeCleanedDocument>;
  structuredContent: StructuredContent;
  educationalEvidence: EducationalEvidence;
  verificationResult: VerificationResult;
}

export interface PersistenceResult {
  resource: {
    id: string;
    url: string;
    title: string;
    sourceDomain: string | null;
    resourceType: string;
    licenseStatus: "cc_open" | "link_only" | "unknown_review_needed";
    embedAllowed: boolean;
    contentTypeVerified: boolean;
    aiNote: string | null;
    status: "draft" | "approved" | "rejected";
    nodeId: string | null;
    majorUnderstandingId: string | null;
    createdAt: string;
    isNew: boolean;
  };
  verificationRecord: {
    id: string;
    resourceId: string;
    status: "verified" | "failed";
    contentHash: string;
    canonicalUrl: string;
    verifiedAt: string;
    isExactRetry: boolean;
  };
  resourceMapping: any;
}

/**
 * Run the actual 5 → 6A → 6B → 6C pipeline on an AcquiredPage fixture.
 * Uses the REAL implementations of every phase — no faking.
 */
export function runPipeline(acquiredPage: AcquiredPage): PipelineResult {
  const cleanedDocument = buildCleanedDocument(acquiredPage);
  const cleanedPage = serializeCleanedDocument(cleanedDocument);
  const structuredContent = extractStructuredContentFromDoc(cleanedDocument);
  const educationalEvidence = extractEducationalEvidence(structuredContent);

  validateVerificationInput({
    acquiredPage: {
      contentHash: acquiredPage.contentHash,
      canonicalUrl: acquiredPage.canonicalUrl.url,
      finalUrl: acquiredPage.finalUrl,
      statusCode: acquiredPage.statusCode,
      contentType: acquiredPage.contentType,
      acquiredAt: acquiredPage.acquiredAt,
    },
    structuredContent,
    educationalEvidence,
  });

  const verificationResult = verifyContent({
    acquiredPage: {
      contentHash: acquiredPage.contentHash,
      canonicalUrl: acquiredPage.canonicalUrl.url,
      finalUrl: acquiredPage.finalUrl,
      statusCode: acquiredPage.statusCode,
      contentType: acquiredPage.contentType,
      acquiredAt: acquiredPage.acquiredAt,
    },
    structuredContent,
    educationalEvidence,
  });

  return {
    cleanedDocument,
    cleanedPage,
    structuredContent,
    educationalEvidence,
    verificationResult,
  };
}

/**
 * Run the FULL pipeline including 6D persistence, using a mock Supabase client.
 * If an existing mockClient is provided, its tables are reused (for testing idempotency/repeated calls).
 */
export async function runFullPipelineWithMockDb(
  acquiredPage: AcquiredPage,
  target: { nodeId?: string; understandingId?: string },
  acquisitionJobId?: string,
  callerMetadata?: { resourceType?: string; licenseStatus?: "cc_open" | "link_only" | "unknown_review_needed"; aiNote?: string | null },
  domainScore?: number,
  existingClient?: MockSupabaseClient
): Promise<{ result: PersistenceResult; mockClient: MockSupabaseClient; pipeline: PipelineResult }> {
  const pipeline = runPipeline(acquiredPage);

  const persistenceInput = {
    acquiredPage,
    structuredContent: pipeline.structuredContent,
    educationalEvidence: pipeline.educationalEvidence,
    verificationResult: pipeline.verificationResult,
    target,
    acquisitionJobId,
    callerMetadata,
  };

  // Reuse existing client if provided (for shared-state tests), otherwise create new
  const mockClient = existingClient ?? new MockSupabaseClient();

  if (domainScore !== undefined) {
    const domain = new URL(acquiredPage.finalUrl).hostname.replace(/^www\./, "");
    mockClient.insert("domain_scores", { domain, score: domainScore });
  }

  const result = await mockPersistVerifiedResource(mockClient, persistenceInput);

  return { result, mockClient, pipeline };
}

/**
 * Re-implement persistVerifiedResource using a mock Supabase client.
 * Mirrors the exact logic in persistence/index.ts but uses our mock client.
 */
async function mockPersistVerifiedResource(
  client: MockSupabaseClient,
  input: any
): Promise<PersistenceResult> {
  const { PersistenceError } = await import("@/lib/persistence/types");
  const { validateResourceTarget } = await import("@/lib/persistence/types");

  const { acquiredPage, structuredContent, educationalEvidence, verificationResult, target, acquisitionJobId, callerMetadata } = input;

  // Validate target
  validateResourceTarget(target);

  const canonicalUrl = acquiredPage.canonicalUrl.url;
  const contentHash = acquiredPage.contentHash;
  const verificationStatus = verificationResult.status;

  // Get domain score
  const sourceDomain = extractDomain(acquiredPage.finalUrl);
  let domainScore = 2;
  if (sourceDomain) {
    const { data, error } = client.from("domain_scores")
      .select("score")
      .eq("domain", sourceDomain)
      .maybeSingle();

    if (error) {
      throw new PersistenceError("DOMAIN_SCORE_LOOKUP_FAILED", "Failed", { domain: sourceDomain, error: error.message });
    }
    domainScore = data?.score ?? 2;
  }

  const licenseStatus = callerMetadata?.licenseStatus ?? "link_only";
  const embedAllowed = licenseStatus === "cc_open" && domainScore >= 4;

  // Find existing resource by canonical URL + target context
  const existingResource = findExistingResourceByCanonicalUrl(client, canonicalUrl, target.nodeId, target.understandingId);

  let isExactRetry = false;
  let existingVerificationId: string | null = null;
  let resourceId: string = "";
  let resourceIsNew = false;

  // Check for exact retry - use direct acquisition_job_id field instead of notes->> JSONB
  if (existingResource && acquisitionJobId) {
    const { data: existingVR, error: vrError } = client.from("verification_records")
      .select("id, content_hash")
      .eq("resource_id", existingResource.id)
      .eq("acquisition_job_id", acquisitionJobId)
      .order("created_at", { ascending: false })
      .limit(1)
      .execute();

    if (vrError) {
      throw new PersistenceError("VERIFICATION_INSERT_FAILED", "Failed to check verification records", { error: vrError.message });
    }

    const vrRows = (existingVR as any[]) ?? [];
    if (vrRows.length > 0 && vrRows[0].content_hash === contentHash) {
      isExactRetry = true;
      existingVerificationId = vrRows[0].id;
      resourceId = existingResource.id;
      resourceIsNew = false;
    }
  }

  if (!isExactRetry) {
    const isVerified = verificationStatus === "verified";

    if (existingResource) {
      if (isVerified) {
        const { data: hasData, error: hasError } = client.from("verification_records")
          .select("id")
          .eq("resource_id", existingResource.id)
          .eq("content_hash", contentHash)
          .limit(1)
          .execute();

        if (hasError) {
          throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to check content hash", { error: hasError.message });
        }

        const hasContentHash = (hasData as any)?.length ?? 0 > 0;
        if (!hasContentHash) {
          const { data: updated, error: updateError } = client.from("resources")
            .update({
              url: acquiredPage.finalUrl,
              title: structuredContent.metadata.title?.trim() || extractDomain(acquiredPage.finalUrl) || "Untitled Resource",
              source_domain: extractDomain(acquiredPage.finalUrl),
              resource_type: callerMetadata?.resourceType ?? "other",
              license_status: licenseStatus,
              embed_allowed: embedAllowed,
              content_type_verified: true,
              ai_note: callerMetadata?.aiNote ?? null,
            })
            .eq("id", existingResource.id)
            .select("id")
            .single();

          if (updateError) {
            throw new PersistenceError("RESOURCE_INSERT_FAILED", "Failed to update resource", { error: updateError.message });
          }

          resourceId = updated?.id ?? existingResource.id;
          resourceIsNew = false;
        } else {
          resourceId = existingResource.id;
          resourceIsNew = false;
        }
      } else {
        // Failed verification: do NOT update existing resource
        resourceId = existingResource.id;
        resourceIsNew = false;
      }
    } else {
      const insertData = {
        node_id: target.nodeId ?? null,
        major_understanding_id: target.understandingId ?? null,
        url: acquiredPage.finalUrl,
        title: structuredContent.metadata.title?.trim() || extractDomain(acquiredPage.finalUrl) || "Untitled Resource",
        source_domain: extractDomain(acquiredPage.finalUrl),
        resource_type: callerMetadata?.resourceType ?? "other",
        license_status: licenseStatus,
        embed_allowed: embedAllowed,
        content_type_verified: true,
        ai_note: callerMetadata?.aiNote ?? null,
        status: "draft" as const,
      };

      const { data: created, error: insertError } = client.from("resources")
        .insert(insertData)
        .select("id, created_at")
        .single();

      if (insertError) {
        throw new PersistenceError("RESOURCE_INSERT_FAILED", "Failed to insert resource", { error: insertError.message });
      }

      resourceId = created.id ?? "";
      resourceIsNew = true;
    }

    // Create verification record (non-exact-retry path)
    const deterministicChecks = {
      cleanedContentNonEmpty: verificationResult.deterministicChecks.cleanedContentNonEmpty,
      ...verificationResult.advisorySignals,
    };

    const contentEvidence = JSON.stringify(educationalEvidence.interpreted);

    const notes = acquisitionJobId ? JSON.stringify({ acquisition_job_id: acquisitionJobId }) : null;

    const insertData = {
      resource_id: resourceId,
      url: acquiredPage.finalUrl,
      canonical_url: acquiredPage.canonicalUrl.url,
      content_hash: acquiredPage.contentHash,
      http_status: acquiredPage.statusCode,
      page_title: structuredContent.metadata.title || null,
      page_metadata: JSON.stringify({
        description: structuredContent.metadata.description,
        author: structuredContent.metadata.author,
        date_published: structuredContent.metadata.datePublished,
        language: structuredContent.metadata.language,
      }),
      content_evidence: contentEvidence,
      fetched_at: acquiredPage.acquiredAt,
      verified_at: verificationResult.verifiedAt,
      verification_method: "deterministic_v1",
      deterministic_checks: JSON.stringify(deterministicChecks),
      ai_verified: false,
      ai_verification_notes: null,
      human_reviewed: false,
      expires_at: null,
      status: verificationResult.status,
      acquisition_job_id: acquisitionJobId,
      notes,
    };

    const { data: vr, error: vrError } = client.from("verification_records")
      .insert(insertData)
      .select("id")
      .single();

    if (vrError) {
      throw new PersistenceError("VERIFICATION_INSERT_FAILED", "Failed to insert verification record", { error: vrError.message });
    }

    if (!existingVerificationId) existingVerificationId = vr.id;
    isExactRetry = false;
  }

  // Create mapping if understanding target
  let resourceMapping: any = null;
  if (target.understandingId) {
    const { data: existingMapping } = client.from("resource_mappings")
      .select("id")
      .eq("resource_id", resourceId)
      .eq("understanding_id", target.understandingId)
      .maybeSingle();

    if (!existingMapping || (existingMapping as any)?.data === null) {
      const { data: newMapping, error: mappingError } = client.from("resource_mappings")
        .insert({
          resource_id: resourceId,
          understanding_id: target.understandingId,
          coverage_confidence: "medium",
        })
        .select("id")
        .single();

      if (mappingError) {
        throw new PersistenceError("MAPPING_UPSERT_FAILED", "Failed to upsert resource mapping", { error: mappingError.message });
      }

      resourceMapping = { id: newMapping.id, resourceId, understandingId: target.understandingId, coverageConfidence: "medium", isNew: true };
    } else {
      resourceMapping = { id: existingMapping.id, resourceId, understandingId: target.understandingId, coverageConfidence: "medium", isNew: false };
    }
  }

  // Fetch the final resource
  const { data: finalResource, error: finalError } = client.from("resources")
    .select("*")
    .eq("id", resourceId)
    .single();

  if (finalError) {
    throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to fetch final resource", { error: finalError.message });
  }

  return {
    resource: {
      id: finalResource.id,
      url: finalResource.url,
      title: finalResource.title,
      sourceDomain: finalResource.source_domain,
      resourceType: finalResource.resource_type,
      licenseStatus: finalResource.license_status,
      embedAllowed: finalResource.embed_allowed,
      contentTypeVerified: finalResource.content_type_verified,
      aiNote: finalResource.ai_note,
      status: finalResource.status,
      nodeId: finalResource.node_id,
      majorUnderstandingId: finalResource.major_understanding_id,
      createdAt: finalResource.created_at,
      isNew: resourceIsNew,
    },
    verificationRecord: {
      id: existingVerificationId!,
      resourceId,
      status: verificationStatus,
      contentHash,
      canonicalUrl,
      verifiedAt: verificationResult.verifiedAt,
      isExactRetry,
    },
    resourceMapping,
  };
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function findExistingResourceByCanonicalUrl(
  client: MockSupabaseClient,
  canonicalUrl: string,
  targetNodeId: string | undefined,
  targetUnderstandingId: string | undefined
): { id: string; created_at: string } | null {
  const { data: vrRows, error: vrError } = client.from("verification_records")
    .select("resource_id")
    .eq("canonical_url", canonicalUrl)
    .execute();

  if (vrError) {
    throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to query verification_records", { error: vrError.message });
  }

  if (!vrRows || (vrRows as any[]).length === 0) {
    return null;
  }

  const resourceIds = (vrRows as any[]).map((r: any) => r.resource_id);
  const { data: resources, error: resError } = client.from("resources")
    .select("id, node_id, major_understanding_id, created_at")
    .in("id", resourceIds)
    .execute();

  if (resError) {
    throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to fetch candidate resources", { error: resError.message });
  }

  if (!resources || (resources as any[]).length === 0) {
    return null;
  }

  const matching = (resources as any[]).filter((r: any) => {
    if (targetNodeId) {
      return r.node_id === targetNodeId && r.major_understanding_id === null;
    }
    if (targetUnderstandingId) {
      return r.node_id === null && r.major_understanding_id === targetUnderstandingId;
    }
    return false;
  });

  if (matching.length === 0) {
    return null;
  }

  matching.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return { id: matching[0].id, created_at: matching[0].created_at };
}