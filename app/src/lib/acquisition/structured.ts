/**
 * Phase 6A Public API
 * Exports StructuredContent types and extraction function.
 */

export type {
  StructuredContent,
  Heading,
  TextBlock,
  Link,
  DocumentStatistics,
} from "./structuredExtract";

export { extractStructuredContentFromDoc } from "./structuredExtract";