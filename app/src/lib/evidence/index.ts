/**
 * Phase 6B Educational Evidence Extraction - Public API
 * Exports types and deterministic extraction function.
 */

export type {
  EducationalEvidence,
  EducationalEvidenceResult,
  PatternMatch,
  Confidence,
  StructuredContent,
  Heading,
  TextBlock,
  Link,
  DocumentStatistics,
  DocumentMetadata,
} from "./types";

export { extractEducationalEvidence } from "./deterministic";