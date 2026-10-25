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
import { resourceExtractionKey } from "@/lib/cache/keys";
import type { CacheStore } from "@/lib/cache/store";
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

function cacheOptionsWithoutSignal(options: AcquisitionOptions): AcquisitionOptions {
  const result = { ...options };
  delete result.signal;
  return result;
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

const CLEAR_INTERSTITIAL_TEXT = [
  /\bverify (?:that )?you are human\b/i,
  /\bcomplete (?:the )?(?:security|captcha) check\b/i,
  /\bchecking your browser before accessing\b/i,
  /\benable javascript and cookies to continue\b/i,
  /\bunusual traffic from your network\b/i,
  /\bautomated requests from your (?:computer|network)\b/i,
  /\byour request has been blocked\b/i,
  /\baccess denied due to (?:a )?security check\b/i,
];
const CHALLENGE_TITLE = /\b(?:client challenge|security check|captcha|attention required)\b/i;
const CHALLENGE_BODY_CONTEXT = /\b(?:enable javascript|enable cookies|verify (?:that )?you are human|security check|captcha|unusual traffic|automated requests|browser verification)\b/i;

/**
 * Identify common HTTP-200 anti-bot/interstitial bodies using their content.
 * A challenge-like title alone is deliberately insufficient.
 */
export function isLikelyInterstitialPage(title: string, text: string): boolean {
  const body = text.slice(0, 8_000);
  if (CLEAR_INTERSTITIAL_TEXT.some((pattern) => pattern.test(body))) return true;
  return CHALLENGE_TITLE.test(title) && CHALLENGE_BODY_CONTEXT.test(body);
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
 *
 * @param candidate Discovery candidate to acquire
 * @param options Acquisition options (affect output — included in cache key when cache provided)
 * @param dedupTracker Optional in-memory deduplication tracker (within a single job)
 * @param cache Optional Phase 11 cache store for resource-extraction caching.
 *   When provided, checks cache before fetching and stores successful results.
 *   Cache key includes URL + options hash so different extraction settings
 *   produce different keys. Failed or partial results are never cached.
 *   Disabled by default (pass getCacheStore() which is disabled, or createCache({enabled:true})).
 */
export async function acquireCandidate(
  candidate: DiscoveryCandidate,
  options: AcquisitionOptions = {},
  dedupTracker?: AcquisitionDedupTracker,
  cache?: CacheStore
): Promise<AcquisitionResult> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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

  // Check after the target-scoped duplicate guard: cache hits must still be
  // rejected when the same URL is repeated within one topic, while a fresh
  // topic tracker can reuse this acquired content without another fetch.
  if (cache) {
    const cacheKey = resourceExtractionKey(candidate.url, cacheOptionsWithoutSignal(options));
    const cached = cache.getRaw<AcquisitionResult>(cacheKey);
    if (cached) return cached;
  }

  // Acquisition
  let acquired: AcquiredPage;
  try {
    acquired = await acquireUrl(candidate.url, options);
  } catch (err) {
    if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
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

  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

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

  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Phase 5 output
  const cleaned = serializeCleanedDocument(doc);

  // Fail fast: no extractable content (e.g., JS shells, consent pages, empty pages)
  // This prevents wasting verification/persistence on unextractable sources.
  if (cleaned.wordCount === 0) {
    return {
      candidate,
      success: false,
      error: {
        code: "EMPTY_CONTENT",
        message: "Page acquired successfully but no extractable text content found",
        details: {
          finalUrl: acquired.finalUrl,
          statusCode: acquired.statusCode,
          contentType: acquired.contentType,
          title: cleaned.title,
        },
      },
    };
  }

  // An HTTP-200 challenge page is a fetch success but not the intended lesson.
  // Return a bounded per-candidate failure so the caller can continue to the
  // next discovery result or the next existing coverage attempt.
  if (isLikelyInterstitialPage(cleaned.title, cleaned.text)) {
    return {
      candidate,
      success: false,
      error: {
        code: "UNUSABLE_INTERSTITIAL",
        message: "Page returned challenge or interstitial content instead of usable lesson content",
        details: {
          url: acquired.finalUrl,
          statusCode: acquired.statusCode,
          title: cleaned.title,
          reason: "challenge_or_interstitial_text_detected",
        },
      },
    };
  }

  // Phase 6A output
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const structuredContent = extractStructuredContentFromDoc(doc);

  const result: AcquisitionResult = {
    candidate,
    success: true,
    acquiredPage: acquired,
    cleanedPage: cleaned,
    structuredContent,
  };

  // Phase 11: Cache successful result (never cache failures).
  // Uses the cache store's defaultTtlMs (falls back to store default or no expiry).
  if (cache) {
    const cacheKey = resourceExtractionKey(candidate.url, cacheOptionsWithoutSignal(options));
    cache.setRaw(cacheKey, result);
  }

  return result;
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
