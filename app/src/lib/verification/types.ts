/**
 * Phase 6C Deterministic Verification Types
 * Minimal types for the verification gate between 6B and 6D.
 * Zero AI, zero network, zero persistence.
 */

import type {
  StructuredContent,
  DocumentStatistics,
} from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";

/** Verification status - only two states per design */
export type VerificationStatus = "verified" | "failed";

/** Single hard deterministic check */
export interface DeterministicChecks {
  /** The only content-quality gate: cleaned representation has at least one word */
  cleanedContentNonEmpty: boolean;
}

/** Advisory signals for downstream consumers (6D ranker, 6E lifecycle, admin UI) */
export interface AdvisorySignals {
  /** Title was present in the cleaned representation (6A metadata) */
  titlePresent: boolean;
  /** At least one explicit educational pattern matched (6B evidence) */
  educationalEvidencePresent: boolean;
  /** Word count from 6A StructuredContent statistics */
  wordCount: number;
  /** Heading count from 6A StructuredContent statistics */
  headingCount: number;
  /** Paragraph count from 6A StructuredContent statistics */
  paragraphCount: number;
}

/** Input bundle for verification - already-produced representations from 5/6A/6B */
export interface VerificationInput {
  /** Phase 5 acquisition metadata (subset needed for verification) */
  acquiredPage: {
    /** SHA-256 of raw HTTP response body */
    contentHash: string;
    /** Canonical URL from Phase 5 */
    canonicalUrl: string;
    /** Final URL after redirects */
    finalUrl: string;
    /** HTTP status code */
    statusCode: number;
    /** Content-Type media type */
    contentType: string;
    /** ISO timestamp of acquisition */
    acquiredAt: string;
  };
  /** Phase 6A structured content extraction */
  structuredContent: StructuredContent;
  /** Phase 6B educational evidence extraction */
  educationalEvidence: EducationalEvidence;
}

/** Output of the verification gate */
export interface VerificationResult {
  /** Only two states: passed minimal gates or didn't */
  status: VerificationStatus;

  /** The single hard gate result */
  deterministicChecks: DeterministicChecks;

  /** Advisory metadata for downstream consumers */
  advisorySignals: AdvisorySignals;

  /** Raw acquired content hash (Phase 5 AcquiredPage.contentHash) */
  contentHash: string;

  /** Canonical URL from Phase 5 (no re-canonicalization) */
  canonicalUrl: string;

  /** ISO timestamp of verification */
  verifiedAt: string;
}

/** Source identity hashes for cross-phase consistency validation */
export interface SourceHashes {
  /** Phase 5: SHA-256 of raw HTTP response body */
  contentHash: string;
  /** Phase 6A/6B: SHA-256 of canonical cleaned representation */
  cleanedHash: string;
}