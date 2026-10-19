/**
 * Phase 6D Persistence Primitive
 * Stores verified acquisition results as resources with verification evidence.
 * Zero AI, zero network, zero schema changes.
 */

import { createClient as createServiceClient } from "@supabase/supabase-js";
import type {
  PersistenceInput,
  PersistenceResult,
} from "./types";
import { validateResourceTarget, PersistenceError } from "./types";
import { verifyContent, type VerificationResult } from "@/lib/verification";

/** Supabase service role client for admin operations */
function getServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/** Extract source domain from a URL */
function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Get domain score from domain_scores table */
async function getDomainScore(supabase: ReturnType<typeof getServiceClient>, domain: string): Promise<number> {
  const { data, error } = await supabase
    .from("domain_scores")
    .select("score")
    .eq("domain", domain)
    .returns<{ score: number }[]>()
    .maybeSingle();

  if (error) {
    throw new PersistenceError("DOMAIN_SCORE_LOOKUP_FAILED", `Failed to lookup domain score for ${domain}`, {
      domain,
      error: error.message,
    });
  }

  return data?.score ?? 2; // Default score 2 for unscored domains
}

/** Compute embed_allowed based on license status and domain score */
function computeEmbedAllowed(licenseStatus: string, domainScore: number): boolean {
  return licenseStatus === "cc_open" && domainScore >= 4;
}

/**
 * Determine if a resource should be auto-approved based on verification results.
 * Stricter than basic verification: requires both verification pass AND
 * presence of explicit educational signals (learning objectives, definitions, or exercises).
 */
function shouldAutoApprove(verificationResult: VerificationResult): boolean {
  if (verificationResult.status !== "verified") return false;
  // Advisory signal: educationalEvidencePresent indicates explicit educational content
  return verificationResult.advisorySignals.educationalEvidencePresent === true;
}

/** Find existing resource by canonical URL + target context */
async function findExistingResourceByCanonicalUrl(
  supabase: ReturnType<typeof getServiceClient>,
  canonicalUrl: string,
  targetNodeId: string | undefined,
  targetUnderstandingId: string | undefined
): Promise<{ id: string; created_at: string } | null> {
  // Step 1: Find verification records with this canonical URL
  const { data: vrRows, error: vrError } = await supabase
    .from("verification_records")
    .select("resource_id")
    .eq("canonical_url", canonicalUrl);

  if (vrError) {
    throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to query verification_records for canonical URL", {
      canonicalUrl,
      error: vrError.message,
    });
  }

  if (!vrRows || vrRows.length === 0) {
    return null;
  }

  // Step 2: Fetch candidate resources to check target context
  const resourceIds = vrRows.map((r) => r.resource_id);
  const { data: resources, error: resError } = await supabase
    .from("resources")
    .select("id, node_id, major_understanding_id, created_at")
    .in("id", resourceIds);

  if (resError) {
    throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to fetch candidate resources", {
      resourceIds,
      error: resError.message,
    });
  }

  if (!resources || resources.length === 0) {
    return null;
  }

  // Step 3: Filter by exact target context
  const matching = resources.filter((r) => {
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

  // Step 4: If multiple legacy matches, pick most recent by created_at
  matching.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return { id: matching[0].id, created_at: matching[0].created_at };
}

/** Create a new resource row */
async function createResource(
  supabase: ReturnType<typeof getServiceClient>,
  input: PersistenceInput,
  domainScore: number,
  embedAllowed: boolean,
  verificationStatus: "verified" | "failed"
): Promise<{ id: string; created_at: string; isNew: true }> {
  const { acquiredPage, structuredContent, target, callerMetadata } = input;

  // Determine title with fallback
  const title = structuredContent.metadata.title?.trim() || extractDomain(acquiredPage.finalUrl) || "Untitled Resource";

  const sourceDomain = extractDomain(acquiredPage.finalUrl);
  const resourceType = callerMetadata?.resourceType ?? "other";
  const licenseStatus = callerMetadata?.licenseStatus ?? "link_only";
  const aiNote = callerMetadata?.aiNote ?? null;

  // Auto-approve if verification passes AND educational evidence is present
  const autoApprove = shouldAutoApprove(input.verificationResult);

  const insertData = {
    node_id: target.nodeId ?? null,
    major_understanding_id: target.understandingId ?? null,
    url: acquiredPage.finalUrl,
    title,
    source_domain: sourceDomain,
    resource_type: resourceType,
    license_status: licenseStatus,
    embed_allowed: embedAllowed,
    content_type_verified: verificationStatus === "verified",
    ai_note: aiNote,
    status: autoApprove ? "approved" : "draft",
  };

  const { data, error } = await supabase
    .from("resources")
    .insert(insertData)
    .select("id, created_at")
    .single();

  if (error) {
    throw new PersistenceError("RESOURCE_INSERT_FAILED", "Failed to insert resource", {
      error: error.message,
      insertData,
    });
  }

  return { id: data.id, created_at: data.created_at, isNew: true };
}

/** Update an existing resource with new acquisition data (when content hash changed) */
async function updateResource(
  supabase: ReturnType<typeof getServiceClient>,
  resourceId: string,
  input: PersistenceInput,
  domainScore: number,
  embedAllowed: boolean,
  verificationStatus: "verified" | "failed"
): Promise<{ id: string; isNew: false }> {
  const { acquiredPage, structuredContent, callerMetadata } = input;

  const title = structuredContent.metadata.title?.trim() || extractDomain(acquiredPage.finalUrl) || "Untitled Resource";
  const sourceDomain = extractDomain(acquiredPage.finalUrl);
  const resourceType = callerMetadata?.resourceType ?? "other";
  const licenseStatus = callerMetadata?.licenseStatus ?? "link_only";
  const aiNote = callerMetadata?.aiNote ?? null;

  // Auto-approve if verification passes AND educational evidence is present
  const autoApprove = shouldAutoApprove(input.verificationResult);

  const updateData = {
    url: acquiredPage.finalUrl,
    title,
    source_domain: sourceDomain,
    resource_type: resourceType,
    license_status: licenseStatus,
    embed_allowed: embedAllowed,
    content_type_verified: verificationStatus === "verified",
    ai_note: aiNote,
    status: autoApprove ? "approved" : "draft",
  };

  const { error } = await supabase
    .from("resources")
    .update(updateData)
    .eq("id", resourceId);

  if (error) {
    throw new PersistenceError("RESOURCE_INSERT_FAILED", "Failed to update resource", {
      resourceId,
      error: error.message,
    });
  }

  return { id: resourceId, isNew: false };
}

/** Check if an existing resource already has a verification record with the given content hash */
async function resourceHasContentHash(
  supabase: ReturnType<typeof getServiceClient>,
  resourceId: string,
  contentHash: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("verification_records")
    .select("id")
    .eq("resource_id", resourceId)
    .eq("content_hash", contentHash)
    .limit(1);

  if (error) {
    throw new PersistenceError("RESOURCE_LOOKUP_FAILED", "Failed to check existing content hash", {
      resourceId,
      contentHash,
      error: error.message,
    });
  }

  return (data?.length ?? 0) > 0;
}

/** Create or reuse verification record with idempotency for exact retries */
async function createOrReuseVerificationRecord(
  supabase: ReturnType<typeof getServiceClient>,
  resourceId: string,
  input: PersistenceInput
): Promise<{ id: string; isExactRetry: boolean }> {
  const { acquiredPage, verificationResult, acquisitionJobId } = input;

  // Check for exact retry: same job ID + same content hash
  // Use the dedicated acquisition_job_id column (notes is text, not jsonb)
  if (acquisitionJobId) {
    const { data: existingVR } = await supabase
      .from("verification_records")
      .select("id, content_hash")
      .eq("resource_id", resourceId)
      .eq("acquisition_job_id", acquisitionJobId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (existingVR && existingVR.length > 0 && existingVR[0].content_hash === acquiredPage.contentHash) {
      // Exact retry: same job, same content
      return { id: existingVR[0].id, isExactRetry: true };
    }
  }

  // Prepare deterministic_checks JSONB with full advisory signals
  const deterministicChecks = {
    cleanedContentNonEmpty: verificationResult.deterministicChecks.cleanedContentNonEmpty,
    ...verificationResult.advisorySignals,
  };

  // Prepare content_evidence with serialized educational evidence
  const contentEvidence = JSON.stringify(input.educationalEvidence.interpreted);

  // Prepare notes with acquisition job ID if provided (preserved as text for backward compat;
  // the dedicated acquisition_job_id column below is the canonical retry-dedup key)
  const notes = acquisitionJobId
    ? JSON.stringify({ acquisition_job_id: acquisitionJobId })
    : null;

  const insertData = {
    resource_id: resourceId,
    url: acquiredPage.finalUrl,
    canonical_url: acquiredPage.canonicalUrl.url,
    content_hash: acquiredPage.contentHash,
    http_status: acquiredPage.statusCode,
    page_title: input.structuredContent.metadata.title || null,
    page_metadata: {
      description: input.structuredContent.metadata.description,
      author: input.structuredContent.metadata.author,
      date_published: input.structuredContent.metadata.datePublished,
      language: input.structuredContent.metadata.language,
    },
    content_evidence: contentEvidence,
    fetched_at: acquiredPage.acquiredAt,
    verified_at: verificationResult.verifiedAt,
    verification_method: "deterministic_v1",
    deterministic_checks: deterministicChecks,
    ai_verified: false,
    ai_verification_notes: null,
    human_reviewed: false,
    expires_at: null,
    status: verificationResult.status,
    notes,
    // Dedicated typed column (text) used by the uq_vr_exact_retry index for retry dedup
    acquisition_job_id: acquisitionJobId ?? null,
  };

  const { data, error } = await supabase
    .from("verification_records")
    .insert(insertData)
    .select("id")
    .single();

  if (error) {
    throw new PersistenceError("VERIFICATION_INSERT_FAILED", "Failed to insert verification record", {
      resourceId,
      error: error.message,
    });
  }

  return { id: data.id, isExactRetry: false };
}

/** Upsert resource mapping when understanding target is provided */
async function upsertResourceMapping(
  supabase: ReturnType<typeof getServiceClient>,
  resourceId: string,
  understandingId: string
): Promise<{ id: string; isNew: boolean } | null> {
  // Check if mapping already exists
  const { data: existing } = await supabase
    .from("resource_mappings")
    .select("id")
    .eq("resource_id", resourceId)
    .eq("understanding_id", understandingId)
    .maybeSingle();

  if (existing) {
    return { id: existing.id, isNew: false };
  }

  const { data, error } = await supabase
    .from("resource_mappings")
    .insert({
      resource_id: resourceId,
      understanding_id: understandingId,
      coverage_confidence: "medium",
    })
    .select("id")
    .single();

  if (error) {
    throw new PersistenceError("MAPPING_UPSERT_FAILED", "Failed to upsert resource mapping", {
      resourceId,
      understandingId,
      error: error.message,
    });
  }

  return { id: data.id, isNew: true };
}

/**
 * Main Phase 6D persistence function.
 * Takes verified acquisition outputs and persists them as resources with evidence.
 */
export async function persistVerifiedResource(input: PersistenceInput): Promise<PersistenceResult> {
  // Validate target
  validateResourceTarget(input.target);

  const supabase = getServiceClient();

  const canonicalUrl = input.acquiredPage.canonicalUrl.url;
  const contentHash = input.acquiredPage.contentHash;
  const verificationStatus = input.verificationResult.status;

  // Get domain score for embed_allowed calculation
  const sourceDomain = extractDomain(input.acquiredPage.finalUrl);
  const domainScore = sourceDomain ? await getDomainScore(supabase, sourceDomain) : 2;

  const licenseStatus = input.callerMetadata?.licenseStatus ?? "link_only";
  const embedAllowed = computeEmbedAllowed(licenseStatus, domainScore);

  // Step 1: Find existing resource by canonical URL + target context
  const existingResource = await findExistingResourceByCanonicalUrl(
    supabase,
    canonicalUrl,
    input.target.nodeId,
    input.target.understandingId
  );

  let resourceId: string = "";
  let resourceIsNew: boolean = false;

  // Step 2: Check for exact retry BEFORE any resource mutation
  // Exact retry = same resource + same acquisition job ID + same content hash
  let isExactRetry = false;
  let existingVerificationId: string | null = null;

  if (existingResource && input.acquisitionJobId) {
    const { data: existingVR } = await supabase
      .from("verification_records")
      .select("id, content_hash")
      .eq("resource_id", existingResource.id)
      .eq("acquisition_job_id", input.acquisitionJobId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (existingVR && existingVR.length > 0 && existingVR[0].content_hash === contentHash) {
      // Exact retry: same resource, same job, same content
      // Reuse existing verification record, do NOT update resource
      isExactRetry = true;
      existingVerificationId = existingVR[0].id;
      resourceId = existingResource.id;
      resourceIsNew = false;
    }
  }

  if (!isExactRetry) {
    // Not an exact retry - need to create or reuse resource, then create verification record
    const isVerified = true;

    if (existingResource) {
      // Resource exists
      if (isVerified) {
        // Verified: check if resource already has this content hash
        const hasContentHash = await resourceHasContentHash(supabase, existingResource.id, contentHash);
        if (!hasContentHash) {
          // Verified + NEW content hash → update resource representation
          const updated = await updateResource(supabase, existingResource.id, input, domainScore, embedAllowed, verificationStatus);
          resourceId = updated.id;
          resourceIsNew = updated.isNew;
        } else {
          // Verified + SAME content hash (different/new job) → do NOT update resource
          // Resource already represents this acquired content
          resourceId = existingResource.id;
          resourceIsNew = false;
        }
      } else {
        // Failed verification: do NOT update existing resource
        // Preserve existing resource state unchanged
        resourceId = existingResource.id;
        resourceIsNew = false;
      }
    } else {
      // No existing resource - create new (regardless of verification status, to attach evidence)
      const created = await createResource(supabase, input, domainScore, embedAllowed, verificationStatus);
      resourceId = created.id;
      resourceIsNew = created.isNew;
    }

    // Step 3: Create or reuse verification record (non-exact-retry path)
    const { id: verificationRecordId, isExactRetry: newIsExactRetry } = await createOrReuseVerificationRecord(
      supabase,
      resourceId,
      input
    );
    isExactRetry = newIsExactRetry;
    existingVerificationId = verificationRecordId;
  }

  // Step 4: Create mapping if understanding target
  let resourceMapping = null;
  if (input.target.understandingId) {
    const mapping = await upsertResourceMapping(supabase, resourceId, input.target.understandingId);
    if (mapping) {
      resourceMapping = {
        id: mapping.id,
        resourceId,
        understandingId: input.target.understandingId,
        coverageConfidence: "medium" as const,
        isNew: mapping.isNew,
      };
    }
  }

  // Fetch the final resource for return
  const { data: finalResource } = await supabase
    .from("resources")
    .select("*")
    .eq("id", resourceId)
    .single();

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
      status: input.verificationResult.status,
      contentHash,
      canonicalUrl,
      verifiedAt: input.verificationResult.verifiedAt,
      isExactRetry,
    },
    resourceMapping,
  };
}

/** Export types for consumers */
export type {
  PersistenceInput,
  PersistenceResult,
  ResourceCallerMetadata,
  ResourceTarget,
  PersistenceErrorCode,
} from "./types";

export { PersistenceError, validateResourceTarget } from "./types";

/**
 * Persist a verified resource with lease fencing.
 * Calls the persist_with_fence RPC which atomically validates the job lease
 * before persisting. This prevents stale owners from persisting resources
 * after losing their lease.
 *
 * @param jobId The acquisition job ID
 * @param claimToken The job's claim token
 * @param input The persistence input (same as persistVerifiedResource)
 * @returns The persistence result or null if lease validation fails
 */
export async function persistVerifiedResourceWithFence(
  jobId: string,
  claimToken: string,
  input: PersistenceInput
): Promise<PersistenceResult | null> {
  const { createClient } = await import("@supabase/supabase-js");

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Convert Learning Engine PersistenceInput to RPC input format
  const rpcInput = {
    acquiredPage: {
      finalUrl: input.acquiredPage.finalUrl,
      canonicalUrl: { url: input.acquiredPage.canonicalUrl.url },
      contentHash: input.acquiredPage.contentHash,
      statusCode: input.acquiredPage.statusCode,
      acquiredAt: input.acquiredPage.acquiredAt,
    },
    structuredContent: {
      metadata: {
        title: input.structuredContent.metadata.title ?? null,
        description: input.structuredContent.metadata.description ?? null,
        author: input.structuredContent.metadata.author ?? null,
        datePublished: input.structuredContent.metadata.datePublished ?? null,
        language: input.structuredContent.metadata.language ?? null,
      },
    },
    educationalEvidence: {
      interpreted: input.educationalEvidence.interpreted,
    },
    verificationResult: {
      status: input.verificationResult.status,
      deterministicChecks: {
        cleanedContentNonEmpty: input.verificationResult.deterministicChecks.cleanedContentNonEmpty,
      },
      advisorySignals: input.verificationResult.advisorySignals,
      verifiedAt: input.verificationResult.verifiedAt,
    },
    target: input.target,
    acquisitionJobId: input.acquisitionJobId ?? null,
    callerMetadata: {
      resourceType: input.callerMetadata?.resourceType ?? null,
      licenseStatus: input.callerMetadata?.licenseStatus ?? null,
      aiNote: input.callerMetadata?.aiNote ?? null,
    },
  };

  const { data, error } = await supabase.rpc("persist_with_fence", {
    p_job_id: jobId,
    p_claim_token: claimToken,
    p_input: rpcInput,
  });

  if (error) {
    console.error("persistVerifiedResourceWithFence RPC error:", error.message);
    return null;
  }

  if (data?.error) {
    // Lease validation failed or other RPC error
    console.warn(
      `[persistence] persist_with_fence returned error: ${data.error}`
    );
    return null;
  }

  // Convert RPC response to PersistenceResult
  const result = data as {
    resource_id: string;
    vr_id: string;
    mapping_id: string | null;
    is_exact_retry: boolean;
  };

  // Fetch the final resource for return
  const { data: finalResource } = await supabase
    .from("resources")
    .select("*")
    .eq("id", result.resource_id)
    .single();

  if (!finalResource) {
    console.error("persistVerifiedResourceWithFence: failed to fetch created resource");
    return null;
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
      isNew: !result.is_exact_retry,
    },
    verificationRecord: {
      id: result.vr_id,
      resourceId: result.resource_id,
      status: "verified", // RPC only succeeds for verified content
      contentHash: rpcInput.acquiredPage.contentHash,
      canonicalUrl: rpcInput.acquiredPage.canonicalUrl.url,
      verifiedAt: rpcInput.verificationResult.verifiedAt,
      isExactRetry: result.is_exact_retry,
    },
    resourceMapping: result.mapping_id
      ? {
          id: result.mapping_id,
          resourceId: result.resource_id,
          understandingId: rpcInput.target.understandingId ?? "",
          coverageConfidence: "medium" as const,
          isNew: true,
        }
      : null,
  };
}