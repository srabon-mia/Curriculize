/**
 * Phase 8 Search Provider Abstraction
 * Defines the interface for curriculum source discovery.
 * Reuses existing DiscoveryCandidate from acquisition/types.
 */

import type { DiscoveryCandidate as AcquisitionDiscoveryCandidate } from "@/lib/acquisition/types";

/** Options controlling search behavior */
export interface SearchOptions {
  /** Maximum number of candidates to return */
  maxResults?: number;
  /** Filter to specific domains (e.g., official_source domains) */
  domainFilter?: string[];
  /** Grade level context for relevance */
  gradeLevel?: string;
}

/** Search provider interface - must be replaceable per architecture §19 */
export interface SearchProvider {
  /**
   * Search for curriculum source candidates matching the query.
   * Returns deterministic candidates; no AI calls in $0 path.
   */
  search(query: string, options?: SearchOptions): Promise<DiscoveryCandidate[]>;
}

/** Re-export DiscoveryCandidate for consumers */
export type DiscoveryCandidate = AcquisitionDiscoveryCandidate;

/** Source of the candidate for audit trail */
export type CandidateSource = 'seed' | 'search' | 'user';