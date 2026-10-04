/**
 * Phase 5 Acquisition Engine - Main Entry Point
 * Orchestrates URL validation, DNS, HTTP acquisition, and cleaning.
 * Zero AI, deterministic, reusable Phase 4 utilities.
 * Now also produces Phase 6A StructuredContent from the shared cleaned document.
 */

import { validateUrl, normalizeForDedup, canonicalizeUrl, CanonicalUrl } from "@/lib/deterministic/url";
import { sha256 } from "@/lib/deterministic/hash";
import { DedupTracker, makeDedupKey, DedupKey } from "@/lib/deterministic/dedup";
import { acquireUrl } from "./http";
import { buildCleanedDocument, serializeCleanedDocument } from "./cleanedDocument";
import { extractStructuredContentFromDoc, StructuredContent } from "./structuredExtract";
import { AcquisitionError, isAcquisitionError } from "./errors";
import type {
  AcquisitionOptions,
  AcquiredPage,
  CleanedPage,
  DiscoveryCandidate,
  AcquisitionResult,
  DEFAULT_ACQUISITION_OPTIONS,
} from "./types";

/** In-memory deduplication tracker for a single acquisition job */
export class AcquisitionDedupTracker {
  private tracker = new DedupTracker();
  private contentHashes = new Set<string>();

  /** Check and mark a URL as seen. Returns true if already seen. */
  checkUrl(url: string): boolean {
    return this.tracker.checkAndMark(url);
  }

  /** Check and mark a content hash as seen. Returns true if already seen. */
  checkContentHash(hash: string): boolean {
    if (!hash) return false;
    if (this.contentHashes.has(hash)) return true;
    this.contentHashes.add(hash);
    return false;
  }

  /** Get count of unique URLs seen */
  get urlCount(): number {
    return this.tracker.urlCount;
  }

  /** Get count of unique content hashes seen */
  get hashCount(): number {
    return this.contentHashes.size;
  }

  /** Clear all tracked items */
  clear(): void {
    this.tracker.clear();
    this.contentHashes.clear();
  }
}

/**
 * Validate and normalize a discovery candidate URL.
 * Returns canonical info or throws AcquisitionError.
 */
export function validateCandidate(candidate: DiscoveryCandidate): CanonicalUrl {
  const validation = validateUrl(candidate.url);
  if (!validation.valid) {
    const isBlocked = validation.failures?.some((f) =>
      f.includes("blocked (SSRF protection)")
    ) ?? false;
    throw new AcquisitionError(
      isBlocked ? "BLOCKED_URL" : "INVALID_URL",
      { url: candidate.url, reason: validation.reason }
    );
  }
  if (!validation.canonical) {
    throw new AcquisitionError("INVALID_URL", { url: candidate.url, reason: "Canonicalization failed" });
  }
  return validation.canonical;
}

/**
 * Generate a deduplication key for a candidate.
 * Uses Phase 4 deterministic utilities.
 */
export function getCandidateDedupKey(candidate: DiscoveryCandidate): DedupKey | null {
  return makeDedupKey(candidate.url);
}

/**
 * Acquire a single candidate with full pipeline.
 * Returns AcquisitionResult with success/error info.
 * Now includes StructuredContent from Phase 6A.
 */
export async function acquireCandidate(
  candidate: DiscoveryCandidate,
  options: AcquisitionOptions = {},
  dedupTracker?: AcquisitionDedupTracker
): Promise<AcquisitionResult> {
  // URL validation
  let canonical: CanonicalUrl;
  try {
    canonical = validateCandidate(candidate);
  } catch (err) {
    if (isAcquisitionError(err)) {
      return {
        candidate,
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      };
    }
    return {
      candidate,
      success: false,
      error: { code: "INVALID_URL", message: String(err) },
    };
  }

  // Deduplication check (URL level)
  if (dedupTracker && dedupTracker.checkUrl(candidate.url)) {
    return {
      candidate,
      success: false,
      error: { code: "DUPLICATE_URL", message: "URL already processed in this job" },
    };
  }

  // Acquisition
  let acquired: AcquiredPage;
  try {
    acquired = await acquireUrl(candidate.url, options);
  } catch (err) {
    if (isAcquisitionError(err)) {
      return {
        candidate,
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      };
    }
    return {
      candidate,
      success: false,
      error: { code: "ACQUISITION_FAILED", message: String(err) },
    };
  }

  // Content hash deduplication
  if (dedupTracker && dedupTracker.checkContentHash(acquired.contentHash)) {
    return {
      candidate,
      success: false,
      error: { code: "DUPLICATE_CONTENT", message: "Content already acquired in this job" },
    };
  }

  // SINGLE HTML PROCESSING PASS - build cleaned document once
  let doc: ReturnType<typeof buildCleanedDocument>;
  try {
    doc = buildCleanedDocument(acquired);
  } catch (err) {
    if (isAcquisitionError(err)) {
      return {
        candidate,
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      };
    }
    return {
      candidate,
      success: false,
      error: { code: "ACQUISITION_FAILED", message: `Cleaning failed: ${err}` },
    };
  }

  // Phase 5 output
  const cleaned = serializeCleanedDocument(doc);

  // Phase 6A output
  const structuredContent = extractStructuredContentFromDoc(doc);

  return {
    candidate,
    success: true,
    acquiredPage: acquired,
    cleanedPage: cleaned,
    structuredContent,
  };
}

/**
 * Acquire multiple candidates with shared deduplication.
 * Processes sequentially to respect rate limits and avoid overwhelming targets.
 */
export async function acquireCandidates(
  candidates: DiscoveryCandidate[],
  options: AcquisitionOptions = {},
  onProgress?: (completed: number, total: number, result: AcquisitionResult) => void
): Promise<AcquisitionResult[]> {
  const dedupTracker = new AcquisitionDedupTracker();
  const results: AcquisitionResult[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const result = await acquireCandidate(candidates[i], options, dedupTracker);
    results.push(result);
    onProgress?.(i + 1, candidates.length, result);
  }

  return results;
}

/**
 * High-level function: acquire and clean in one call.
 * Returns CleanedPage only (for backward compatibility).
 */
export async function acquireAndClean(
  url: string,
  options?: Parameters<typeof import("./http").acquireUrl>[1]
): Promise<CleanedPage> {
  const { acquireUrl } = await import("./http");
  const acquired = await acquireUrl(url, options);
  const doc = buildCleanedDocument(acquired);
  return serializeCleanedDocument(doc);
}

/**
 * Default options re-export
 */
export { DEFAULT_ACQUISITION_OPTIONS } from "./types";

/**
 * Types re-export for consumers
 */
export type {
  AcquisitionOptions,
  AcquiredPage,
  CleanedPage,
  DiscoveryCandidate,
  AcquisitionResult,
  RedirectHop,
  CanonicalUrl,
} from "./types";
export type { AcquisitionErrorCode, AcquisitionErrorDetails } from "./errors";
export { AcquisitionError, isAcquisitionError } from "./errors";

// Re-export Phase 6A types
export type { StructuredContent } from "./structuredExtract";