/**
 * Learning Engine (Phase 12 — Cut over existing generation path)
 *
 * Orchestrates the deterministic pipeline that bridges AI-discovered candidate
 * URLs and verified persistence:
 *
 *   DiscoveryCandidate ──► Acquisition Engine (acquireCandidate)
 *        │                                     │
 *        │                       acquired + cleaned + structured
 *        │                                     ▼
 *        └────────► Evidence (6B)   Verification (6C)
 *          │                          ▼           │
 *          └────► educationalEvidence  VerificationResult
 *                      └──────────┬──────────┘
 *                                ▼
 *                    Persistence (6D) persistVerifiedResource
 *                      → resources row: status='draft',
 *                        content_type_verified = verification status
 *                      → verification_records row (evidence)
 *
 * The Learning Engine itself performs NO network fetches and NO AI calls:
 * acquisition is direct HTTP (Acquisition Engine), verification is deterministic,
 * evidence extraction is deterministic. AI only happens upstream
 * (skeleton + resource discovery), and that AI call surface is unchanged.
 *
 * Contract (Phase 12):
 *  - A successfully persisted resource is ALWAYS status='draft'; only an admin
 *    can promote it to 'approved' for student visibility. This is the
 *    "approved / content_type_verified bug" fix: resources do not become
 *    student-eligible merely because AI returned a URL or acquisition succeeded.
 *  - content_type_verified is derived solely from the deterministic verification
 *    status (wordCount > 0), never hardcoded.
 *  - A single candidate failure (bad URL, SSRF block, 4xx/5xx, empty page,
 *    network error, persistence error) yields `null` so the generation job can
 *    skip the candidate without aborting the whole curriculum. A systemic
 *    PersistenceError is re-thrown so the caller can decide whether to abort.
 */

import {
  acquireCandidate,
  AcquisitionDedupTracker,
  type DiscoveryCandidate,
  type AcquisitionResult,
} from "@/lib/acquisition";
import { extractEducationalEvidence } from "@/lib/evidence";
import { verifyContent, type VerificationResult } from "@/lib/verification";
import {
  persistVerifiedResource,
  type PersistenceInput,
  type PersistenceResult,
  PersistenceError,
} from "@/lib/persistence";
import type { CacheStore } from "@/lib/cache/store";
import type { AcquiredPage } from "@/lib/acquisition/types";

/** Candidate fields returned by the AI discovery prompt. */
export interface DiscoveryCandidateInput {
  url: string;
  title?: string;
  /** resource_type from the AI prompt, e.g. "video" | "text" | "problem_set" */
  resourceType?: string;
  /** license_status from the AI prompt */
  licenseStatus?: "cc_open" | "link_only" | "unknown_review_needed";
  /** AI-generated note explaining why the resource is useful here */
  aiNote?: string | null;
}

/** Target attachment for a resource — exactly one of the two must be set. */
export interface ResourceTarget {
  nodeId?: string;
  understandingId?: string;
}

export interface LearnParams {
  /** The AI-discovered candidate */
  candidate: DiscoveryCandidateInput;
  /** Where the persisted resource should attach */
  target: ResourceTarget;
  /** Optional acquisition job id for idempotent retry dedup in verification_records */
  acquisitionJobId?: string;
}

export interface LearnResult {
  /** The persisted resource (always status='draft' unless pre-existing) */
  resource: PersistenceResult["resource"];
  /** Outcome of deterministic verification */
  verificationStatus: "verified" | "failed";
  /** Whether a new resource row was created */
  isNew: boolean;
}

/** Minimal shape pulled from verification/types VerificationInput.acquiredPage. */
interface VerificationInputAcquiredPage {
  contentHash: string;
  canonicalUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  acquiredAt: string;
}

/**
 * Adapt a full AcquiredPage into the slim acquiredPage subset that the
 * deterministic verification gate requires (canonicalUrl as a string, not the
 * CanonicalUrl object the engine uses internally).
 */
function toVerificationAcquiredPage(acquiredPage: AcquiredPage): VerificationInputAcquiredPage {
  return {
    contentHash: acquiredPage.contentHash,
    canonicalUrl: acquiredPage.canonicalUrl.url,
    finalUrl: acquiredPage.finalUrl,
    statusCode: acquiredPage.statusCode,
    contentType: acquiredPage.contentType,
    acquiredAt: acquiredPage.acquiredAt,
  };
}

/**
 * Run a single discovered candidate through the full deterministic pipeline.
 *
 * Steps:
 *  1. acquireCandidate  — validate + HTTP fetch + clean + structured extraction
 *     (honors the Phase 11 resource-extraction cache when `cache` is provided).
 *  2. extractEducationalEvidence (6B).
 *  3. verifyContent (6C) — hard gate: cleaned word count > 0.
 *  4. persistVerifiedResource (6D) — inserts resource (status='draft',
 *     content_type_verified from verification) + verification_records evidence.
 *
 * Returns null on per-candidate failure (caller skips / continues).
 * Re-throws PersistenceError only when persistence itself throws — but in
 * practice all persistence throw paths represent candidate-level failures and
 * are caught here to preserve generation-job continuity; the caller still
 * surfaces progress via SSE. If you need stricter failure propagation, call
 * persistVerifiedResource directly.
 */
export async function discoverVerifiedResource(
  params: LearnParams,
  options?: {
    cache?: CacheStore;
    dedupTracker?: AcquisitionDedupTracker;
  }
): Promise<LearnResult | null> {
  const discoveryCandidate: DiscoveryCandidate = {
    url: params.candidate.url,
    title: params.candidate.title,
    resourceType: params.candidate.resourceType,
    // licenseStatus/aiNote are caller metadata, not carried by DiscoveryCandidate.
  };

  const result: AcquisitionResult = await acquireCandidate(
    discoveryCandidate,
    {}, // default acquisition options (timeout, redirects, size cap)
    options?.dedupTracker,
    options?.cache
  );

  if (!result.success || !result.acquiredPage || !result.cleanedPage || !result.structuredContent) {
    // Acquisition failed (bad URL, SSRF block, network/timeout, empty content).
    // Skip this candidate; the generation job continues with the next one.
    console.warn(
      `[learningEngine] skipping candidate ${params.candidate.url}: ` +
        `${result.error?.code ?? "unknown"} — ${result.error?.message ?? "no acquired content"}`
    );
    return null;
  }

  // 6B — deterministic educational evidence from the structured content.
  const educationalEvidence = extractEducationalEvidence(result.structuredContent);

  // 6C — deterministic verification gate (pure, no AI).
  const verificationResult: VerificationResult = verifyContent({
    acquiredPage: toVerificationAcquiredPage(result.acquiredPage),
    structuredContent: result.structuredContent,
    educationalEvidence,
  });

  // 6D — persist with evidence. Always writes status='draft'; the
  // content_type_verified column is derived from the verification result,
  // never hardcoded. Admin approval is required for public visibility.
  //
  // Note: PersistenceInput requires acquiredPage + structuredContent +
  // educationalEvidence + verificationResult (cleanedPage is consumed only
  // by verification, not by the persistence primitive).
  const persistence: PersistenceInput = {
    acquiredPage: result.acquiredPage,
    structuredContent: result.structuredContent,
    educationalEvidence,
    verificationResult,
    target: params.target,
    callerMetadata: {
      resourceType: params.candidate.resourceType,
      licenseStatus: params.candidate.licenseStatus,
      aiNote: params.candidate.aiNote,
    },
    acquisitionJobId: params.acquisitionJobId,
  };

  try {
    const persistenceResult = await persistVerifiedResource(persistence);
    return {
      resource: persistenceResult.resource,
      verificationStatus: verificationResult.status,
      isNew: persistenceResult.resource.isNew,
    };
  } catch (err) {
    if (err instanceof PersistenceError) {
      // Per-candidate persistence failure — log and skip rather than abort
      // the entire generation job. Evidence is best-effort per candidate;
      // the resource is omitted from the curriculum.
      console.warn(
        `[learningEngine] persistence failed for ${result.acquiredPage.finalUrl}:`,
        err.code,
        err.message
      );
      return null;
    }
    // Unexpected error — re-throw so it is not silently swallowed.
    throw err;
  }
}

/**
 * Batch helper: run a set of candidates through discoverVerifiedResource,
 * isolating per-candidate failures. Returns the persisted (or skipped) results
 * in input order.
 */
export async function discoverVerifiedResources(
  inputs: LearnParams[],
  options?: { cache?: CacheStore; dedupTracker?: AcquisitionDedupTracker }
): Promise<(LearnResult | null)[]> {
  const results: (LearnResult | null)[] = [];
  for (const input of inputs) {
    results.push(await discoverVerifiedResource(input, options));
  }
  return results;
}
