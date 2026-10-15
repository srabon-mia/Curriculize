/**
 * Phase 8 Curriculum Structure Verification
 * Extracts advisory structural signals from acquired curriculum pages.
 * Does NOT gate verification - only provides advisory signals for ranking.
 * Reuses existing Phase 6C verification for content gating.
 */

import type { StructuredContent } from "@/lib/acquisition/structuredExtract";

/** Structural signals extracted from curriculum page (advisory only) */
export interface CurriculumStructureSignals {
  unitCount: number;
  understandingCount: number;
  wordCount: number;
  hasRecognizableStructure: boolean;
}

/** Complete structure gate result */
export interface CurriculumStructureGate {
  /** Advisory structural signals */
  signals: CurriculumStructureSignals;
  /** Whether the page has minimum recognizable curriculum structure */
  hasMinimumStructure: boolean;
  /** Advisory notes for ranking/selection */
  notes: string[];
}

/**
 * Extract structural signals from curriculum page content.
 * These are ADVISORY signals for ranking/selection only.
 * They do NOT gate verification - Phase 6C verification gates on wordCount > 0.
 */
export function verifyCurriculumStructure(
  structuredContent: import("@/lib/acquisition/structuredExtract").StructuredContent
): CurriculumStructureGate {
  const stats = structuredContent.statistics;
  const unitCount = (structuredContent.statistics.headingCountsByLevel[1] ?? 0) +
                    (structuredContent.statistics.headingCountsByLevel[2] ?? 0);
  const understandingCount = structuredContent.statistics.headingCountsByLevel[3] ?? 0;

  const signals: CurriculumStructureSignals = {
    unitCount,
    understandingCount,
    wordCount: stats.wordCount,
    hasRecognizableStructure: stats.wordCount >= 500 && unitCount >= 3 && structuredContent.statistics.headingCount >= 5
  };

  const notes: string[] = [];
  if (unitCount < 3) notes.push("Fewer than 3 unit-level headings (H1+H2)");
  if (understandingCount < 6) notes.push("Fewer than 6 understanding-level headings (H3)");
  if (stats.wordCount < 500) notes.push("Less than 500 words of content");

  return {
    signals,
    hasMinimumStructure: unitCount >= 3 && structuredContent.statistics.headingCount >= 5,
    notes
  };
}

/**
 * Type guard to check if structured content has minimum curriculum structure.
 * Advisory only - does not replace Phase 6C verification.
 */
export function hasMinimumCurriculumStructure(
  structuredContent: import("@/lib/acquisition/structuredExtract").StructuredContent
): boolean {
  const gate = verifyCurriculumStructure(structuredContent);
  return gate.hasMinimumStructure;
}