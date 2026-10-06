/**
 * Phase 6D Persistence Types
 * Input/output contracts for the 6D persistence primitive.
 * Zero AI, zero network, zero schema changes.
 */

import type { AcquiredPage } from "@/lib/acquisition/types";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";
import type { VerificationResult } from "@/lib/verification/types";

/** Target context for resource attachment — exactly one must be provided */
export interface ResourceTarget {
  /** Node (topic) level attachment */
  nodeId?: string;
  /** Major understanding level attachment */
  understandingId?: string;
}

/** Validate that exactly one target is provided */
export function validateResourceTarget(target: ResourceTarget): void {
  const hasNode = !!target.nodeId;
  const hasUnderstanding = !!target.understandingId;

  if (hasNode && hasUnderstanding) {
    throw new Error("Resource cannot target both node and major_understanding simultaneously");
  }
  if (!hasNode && !hasUnderstanding) {
    throw new Error("Resource must target either a node or a major_understanding");
  }
}

/** Metadata from the discovery/caller context that 6D does not compute */
export interface ResourceCallerMetadata {
  /** Resource type from discovery (video, text, textbook, etc.) */
  resourceType?: string;
  /** License status from discovery (cc_open, link_only, unknown_review_needed) */
  licenseStatus?: "cc_open" | "link_only" | "unknown_review_needed";
  /** AI-generated note explaining why this resource is useful */
  aiNote?: string | null;
}

/** Complete input bundle for 6D persistence */
export interface PersistenceInput {
  /** Phase 5 acquisition result */
  acquiredPage: AcquiredPage;
  /** Phase 6A structured content extraction */
  structuredContent: StructuredContent;
  /** Phase 6B educational evidence extraction */
  educationalEvidence: EducationalEvidence;
  /** Phase 6C verification result */
  verificationResult: VerificationResult;
  /** Target context — exactly one of nodeId or understandingId */
  target: ResourceTarget;
  /** Optional acquisition job ID for idempotency */
  acquisitionJobId?: string;
  /** Resource metadata from caller (discovery context) */
  callerMetadata?: ResourceCallerMetadata;
}

/** Result of the persistence operation */
export interface PersistenceResult {
  /** The resource that was created or reused */
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
  /** The verification record that was created or reused */
  verificationRecord: {
    id: string;
    resourceId: string;
    status: "verified" | "failed";
    contentHash: string;
    canonicalUrl: string;
    verifiedAt: string;
    isExactRetry: boolean;
  };
  /** The resource mapping if understanding target was provided */
  resourceMapping?: {
    id: string;
    resourceId: string;
    understandingId: string;
    coverageConfidence: "high" | "medium" | "low";
    isNew: boolean;
  } | null;
}

/** Error codes for persistence failures */
export type PersistenceErrorCode =
  | "INVALID_TARGET"
  | "RESOURCE_LOOKUP_FAILED"
  | "RESOURCE_INSERT_FAILED"
  | "VERIFICATION_INSERT_FAILED"
  | "MAPPING_UPSERT_FAILED"
  | "DOMAIN_SCORE_LOOKUP_FAILED";

/** Persistence error with structured details */
export class PersistenceError extends Error {
  public readonly code: PersistenceErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.details = details;
  }
}