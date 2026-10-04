/**
 * Phase 6C Deterministic Verification
 * Pure, side-effect-free verification gate between 6B and 6D.
 * Zero AI, zero network, zero persistence.
 */

import type {
  VerificationInput,
  VerificationResult,
  VerificationStatus,
  DeterministicChecks,
  AdvisorySignals,
  SourceHashes,
} from "./types";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence } from "@/lib/evidence/types";

/**
 * Validate source hash consistency across phases.
 * This is a representation-integrity check, not a content-quality gate.
 * Returns true if all hashes agree, false if there's a mismatch.
 */
function validateSourceHashes(input: VerificationInput): {
  contentHashConsistent: boolean;
  cleanedHashConsistent: boolean;
} {
  const { acquiredPage, structuredContent, educationalEvidence } = input;

  // Phase 5 raw content hash should equal 6A/6B copied contentHash
  const contentHashConsistent =
    acquiredPage.contentHash === structuredContent.source.contentHash &&
    acquiredPage.contentHash === educationalEvidence.source.contentHash;

  // 6A and 6B cleanedHash should agree
  const cleanedHashConsistent =
    structuredContent.source.cleanedHash === educationalEvidence.source.cleanedHash;

  return { contentHashConsistent, cleanedHashConsistent };
}

/**
 * Compute advisory signals from already-produced representations.
 * Pure function - no side effects, no external dependencies.
 */
function computeAdvisorySignals(
  structuredContent: StructuredContent,
  educationalEvidence: EducationalEvidence
): AdvisorySignals {
  const { metadata, statistics } = structuredContent;
  const { interpreted } = educationalEvidence;

  const titlePresent = metadata.title.length > 0;
  const educationalEvidencePresent =
    interpreted.explicitLearningObjectives.length > 0 ||
    interpreted.explicitDefinitions.length > 0 ||
    interpreted.explicitExercises.length > 0;

  return {
    titlePresent,
    educationalEvidencePresent,
    wordCount: statistics.wordCount,
    headingCount: statistics.headingCount,
    paragraphCount: statistics.paragraphCount,
  };
}

/**
 * Main verification function.
 * Deterministic pure function - same input always produces same output
 * (except for the explicit verification timestamp).
 *
 * Hard gate: cleanedContentNonEmpty (wordCount > 0)
 * Everything else is advisory metadata.
 */
export function verifyContent(input: VerificationInput): VerificationResult {
  const { acquiredPage, structuredContent } = input;

  // Validate source hash consistency (representation integrity, not a gate)
  const { contentHashConsistent, cleanedHashConsistent } = validateSourceHashes(input);

  // THE single hard gate: cleaned representation has content
  const cleanedContentNonEmpty = structuredContent.statistics.wordCount > 0;

  // Status is determined ONLY by the hard gate
  const status: VerificationStatus = cleanedContentNonEmpty ? "verified" : "failed";

  // Advisory signals (do NOT affect status)
  const advisorySignals = computeAdvisorySignals(structuredContent, input.educationalEvidence);

  // Deterministic checks object
  const deterministicChecks: DeterministicChecks = {
    cleanedContentNonEmpty,
  };

  return {
    status,
    deterministicChecks,
    advisorySignals,
    contentHash: acquiredPage.contentHash,
    canonicalUrl: acquiredPage.canonicalUrl,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Validate input representations for internal consistency.
 * Throws if inputs are malformed or have obvious integrity issues.
 * This is a development-time safeguard, not a production verification gate.
 */
export function validateVerificationInput(input: VerificationInput): void {
  const { acquiredPage, structuredContent, educationalEvidence } = input;

  // Basic presence checks
  if (!acquiredPage.contentHash) {
    throw new Error("Verification input missing acquiredPage.contentHash");
  }
  if (!acquiredPage.canonicalUrl) {
    throw new Error("Verification input missing acquiredPage.canonicalUrl");
  }
  if (!structuredContent.source.contentHash) {
    throw new Error("Verification input missing structuredContent.source.contentHash");
  }
  if (!structuredContent.source.cleanedHash) {
    throw new Error("Verification input missing structuredContent.source.cleanedHash");
  }
  if (!educationalEvidence.source.contentHash) {
    throw new Error("Verification input missing educationalEvidence.source.contentHash");
  }
  if (!educationalEvidence.source.cleanedHash) {
    throw new Error("Verification input missing educationalEvidence.source.cleanedHash");
  }

  // Source hash consistency - representation integrity
  const { contentHashConsistent, cleanedHashConsistent } = validateSourceHashes(input);

  if (!contentHashConsistent) {
    throw new Error(
      `Source contentHash mismatch: acquiredPage=${acquiredPage.contentHash}, ` +
        `structuredContent=${structuredContent.source.contentHash}, ` +
        `educationalEvidence=${educationalEvidence.source.contentHash}`
    );
  }

  if (!cleanedHashConsistent) {
    throw new Error(
      `Source cleanedHash mismatch: structuredContent=${structuredContent.source.cleanedHash}, ` +
        `educationalEvidence=${educationalEvidence.source.cleanedHash}`
    );
  }
}