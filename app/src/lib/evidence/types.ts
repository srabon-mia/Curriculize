/**
 * Phase 6B Educational Evidence Types
 * Minimal deterministic evidence extracted from Phase 6A StructuredContent.
 * Zero AI, zero network, zero persistence.
 */

import type {
  StructuredContent,
  Heading,
  TextBlock,
  Link,
  DocumentStatistics,
} from "@/lib/acquisition/structuredExtract";
import type { DocumentMetadata } from "@/lib/acquisition/cleanedDocument";

/** Re-export 6A types for downstream consumers that need the raw structure */
export type {
  StructuredContent,
  Heading,
  TextBlock,
  Link,
  DocumentStatistics,
} from "@/lib/acquisition/structuredExtract";
export type { DocumentMetadata } from "@/lib/acquisition/cleanedDocument";

/** Confidence level for deterministic pattern matches */
export type Confidence = "high" | "medium";

/** A single pattern match with traceability to the source block */
export interface PatternMatch {
  /** The matched text excerpt */
  text: string;
  /** Index into StructuredContent.blocks where the match was found */
  blockIndex: number;
  /** The detection pattern that matched */
  pattern: string;
  /** Confidence in the match */
  confidence: Confidence;
}

/** Educational evidence extracted from a document */
export interface EducationalEvidence {
  /** Source identity hashes */
  source: {
    /** Hash of the cleaned text content (from Phase 5/6A) */
    cleanedHash: string;
    /** Hash of the raw acquired response body (from Phase 5) */
    contentHash: string;
  };

  /** Deterministic interpretations of explicit educational signals */
  interpreted: {
    /** Explicit learning objective statements */
    explicitLearningObjectives: PatternMatch[];
    /** Explicit definition statements */
    explicitDefinitions: PatternMatch[];
    /** Explicit exercise/practice/problem statements */
    explicitExercises: PatternMatch[];
  };
}

/** Result of the educational evidence extraction (for potential future extension) */
export interface EducationalEvidenceResult {
  evidence: EducationalEvidence;
  // Reserved for future use: ambiguous segments that might benefit from AI review
  // ambiguousSegments: AmbiguousSegment[];
}