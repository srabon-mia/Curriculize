/**
 * Phase 8 Curriculum Discovery
 * Discovers human curriculum candidates using the seed provider
 * and validates them through the acquisition pipeline.
 */

import { SeedSearchProvider, createSeedSearchProvider } from "@/lib/search/seed-provider";
import { SearchProvider, DiscoveryCandidate } from "@/lib/search/provider";
import { acquireCandidate, AcquisitionDedupTracker, validateCandidate, DEFAULT_ACQUISITION_OPTIONS } from "@/lib/acquisition";
import { verifyContent, validateVerificationInput } from "@/lib/verification/deterministic";
import { extractEducationalEvidence } from "@/lib/evidence/deterministic";
import type { StructuredContent } from "@/lib/acquisition/structuredExtract";
import type { AcquiredPage } from "@/lib/acquisition/types";

/** Result of curriculum candidate discovery and validation */
export interface ValidatedCurriculumCandidate {
  candidate: DiscoveryCandidate;
  acquiredPage?: AcquiredPage;
  structuredContent?: import("@/lib/acquisition/structuredExtract").StructuredContent;
  verificationResult?: Awaited<ReturnType<typeof import("@/lib/verification/deterministic").verifyContent>>;
  structureSignals: CurriculumStructureSignals;
  isVerified: boolean;
  /** Optional identifier for tracking candidates through ranking */
  id?: string | number;
}

/** Structural signals from curriculum page analysis (advisory only) */
export interface CurriculumStructureSignals {
  unitCount: number;
  understandingCount: number;
  wordCount: number;
  hasRecognizableStructure: boolean;
}

/** Discovery options */
export interface DiscoveryOptions {
  /** Maximum candidates to process */
  maxCandidates?: number;
  /** Grade level for context */
  gradeLevel?: string;
  /** Search provider to use (defaults to seed provider) */
  searchProvider?: import("@/lib/search/provider").SearchProvider;
}

/**
 * Discover and validate human curriculum candidates for a topic.
 * Uses the acquisition pipeline to fetch, verify, and extract structure.
 * Returns only candidates that pass content verification (wordCount > 0).
 */
export async function discoverHumanCurriculumCandidates(
  topic: string,
  gradeLevel?: string,
  options: DiscoveryOptions = {}
): Promise<ValidatedCurriculumCandidate[]> {
  const maxCandidates = options.maxCandidates ?? 10;
  const searchProvider = options.searchProvider ?? createSeedSearchProvider();

  // Step 1: Search for candidates using seed provider
  const candidates = await searchProvider.search(topic, {
    maxResults: options.maxCandidates ?? maxCandidates,
    gradeLevel
  });

  if (candidates.length === 0) {
    return [];
  }

  // Step 2: Validate and acquire each candidate through the pipeline
  const dedupTracker = new AcquisitionDedupTracker();
  const validated: ValidatedCurriculumCandidate[] = [];

  for (const candidate of candidates) {
    if (validated.length >= (options.maxCandidates ?? maxCandidates)) {
      break;
    }

    try {
      // Pre-filter: validate URL
      validateCandidate(candidate);

      // Acquire the candidate
      const acquisitionResult = await acquireCandidate(
        candidate,
        DEFAULT_ACQUISITION_OPTIONS,
        dedupTracker
      );

      if (!acquisitionResult.success || !acquisitionResult.acquiredPage || !acquisitionResult.structuredContent) {
        continue;
      }

      const { acquiredPage, structuredContent } = acquisitionResult;

      // Validate verification input hashes
      validateVerificationInput({
        acquiredPage: {
          contentHash: acquiredPage.contentHash,
          canonicalUrl: acquiredPage.canonicalUrl.url,
          finalUrl: acquiredPage.finalUrl,
          statusCode: acquiredPage.statusCode,
          contentType: acquiredPage.contentType,
          acquiredAt: acquiredPage.acquiredAt
        },
        structuredContent,
        educationalEvidence: extractEducationalEvidence(structuredContent)
      });

      // Content verification (hard gate: wordCount > 0)
      const verificationResult = verifyContent({
        acquiredPage: {
          contentHash: acquiredPage.contentHash,
          canonicalUrl: acquiredPage.canonicalUrl.url,
          finalUrl: acquiredPage.finalUrl,
          statusCode: acquiredPage.statusCode,
          contentType: acquiredPage.contentType,
          acquiredAt: acquiredPage.acquiredAt
        },
        structuredContent,
        educationalEvidence: extractEducationalEvidence(structuredContent)
      });

      // Extract structural signals (advisory only)
      const structureSignals = extractCurriculumStructureSignals(structuredContent);

      // Only include candidates that pass content verification
      if (verificationResult.status === "verified") {
        validated.push({
          candidate,
          acquiredPage,
          structuredContent,
          verificationResult,
          structureSignals,
          isVerified: true
        });
      }
    } catch {
      // Skip failed candidates - continue with others
      continue;
    }
  }

  return validated;
}

/**
 * Extract advisory structural signals from structured content.
 * These are advisory signals for ranking/selection, NOT verification gates.
 */
function extractCurriculumStructureSignals(
  structuredContent: import("@/lib/acquisition/structuredExtract").StructuredContent
): CurriculumStructureSignals {
  const stats = structuredContent.statistics;
  const unitCount = (structuredContent.statistics.headingCountsByLevel[1] ?? 0) +
                    (structuredContent.statistics.headingCountsByLevel[2] ?? 0);
  const understandingCount = structuredContent.statistics.headingCountsByLevel[3] ?? 0;

  return {
    unitCount,
    understandingCount,
    wordCount: stats.wordCount,
    hasRecognizableStructure: stats.wordCount >= 500 && unitCount >= 3 && structuredContent.statistics.headingCount >= 5
  };
}

/**
 * Rank validated candidates by domain score and structural signals.
 * Deterministic ranking - no AI calls.
 */
export function rankCurriculumCandidates(
  candidates: ValidatedCurriculumCandidate[],
  domainScores: Record<string, number>
): ValidatedCurriculumCandidate[] {
  return [...candidates].sort((a, b) => {
    const domainScoreA = domainScores[a.candidate.sourceDomain ?? ""] ?? 2;
    const domainScoreB = domainScores[b.candidate.sourceDomain ?? ""] ?? 2;

    // Primary: domain score (higher first)
    if (domainScoreA !== domainScoreB) {
      return domainScoreB - domainScoreA;
    }

    // Secondary: structural signals (advisory)
    if (a.structureSignals.hasRecognizableStructure !== b.structureSignals.hasRecognizableStructure) {
      return b.structureSignals.hasRecognizableStructure ? 1 : -1;
    }

    // Tertiary: word count
    if (a.structureSignals.wordCount !== b.structureSignals.wordCount) {
      return b.structureSignals.wordCount - a.structureSignals.wordCount;
    }

    // Stable sort
    return 0;
  });
}