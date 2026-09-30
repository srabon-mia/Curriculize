/**
 * Deduplication utilities — deterministic, pure functions.
 * Works with content hashes and normalized URLs to prevent redundant work.
 */

import { normalizeForDedup, canonicalizeUrl } from "./url";
import { sha256 as sha256Hash } from "./hash";

/**
 * Deduplication key for a resource candidate.
 * Combines normalized URL + content hash (when available).
 */
export interface DedupKey {
  /** Normalized URL (tracking params removed, www normalized, sorted query params) */
  normalizedUrl: string;
  /** Content hash if known (empty string if not yet fetched) */
  contentHash: string;
  /** Canonical URL for reference */
  canonicalUrl: string;
}

/**
 * Generate a deduplication key from a URL.
 * If content is provided, includes its hash; otherwise just URL normalization.
 */
export function makeDedupKey(
  url: string,
  content?: string
): DedupKey | null {
  const normalized = normalizeForDedup(url);
  if (!normalized) return null;
  const canonical = canonicalizeUrl(url);
  if (!canonical) return null;
  return {
    normalizedUrl: normalized,
    contentHash: content ? sha256Hash(content) : "",
    canonicalUrl: canonical.url,
  };
}

/**
 * Check if two deduplication keys represent the same resource.
 * - If both have content hashes, compare those (most reliable)
 * - Otherwise compare normalized URLs
 */
export function keysEqual(a: DedupKey, b: DedupKey): boolean {
  if (a.contentHash && b.contentHash) {
    return a.contentHash === b.contentHash;
  }
  return a.normalizedUrl === b.normalizedUrl;
}

/**
 * In-memory deduplication set for a single acquisition job.
 * Tracks seen URLs and content hashes to avoid re-fetching within a job.
 */
export class DedupTracker {
  private seenUrls = new Set<string>();
  private seenHashes = new Set<string>();

  /**
   * Check if a URL has already been seen.
   * Returns true if already seen, false if new (and marks as seen).
   */
  checkAndMark(url: string): boolean {
    const normalized = normalizeForDedup(url);
    if (!normalized) return false; // Invalid URLs are not tracked
    if (this.seenUrls.has(normalized)) return true;
    this.seenUrls.add(normalized);
    return false;
  }

  /**
   * Check if a content hash has already been seen.
   * Returns true if already seen, false if new (and marks as seen).
   */
  checkAndMarkHash(hash: string): boolean {
    if (!hash) return false;
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    return false;
  }

  /** Get count of unique URLs seen */
  get urlCount(): number {
    return this.seenUrls.size;
  }

  /** Get count of unique content hashes seen */
  get hashCount(): number {
    return this.seenHashes.size;
  }

  /** Clear all tracked items (for testing or job reset) */
  clear(): void {
    this.seenUrls.clear();
    this.seenHashes.clear();
  }
}

/**
 * Deduplicate an array of URLs, keeping the first occurrence of each normalized URL.
 */
export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const normalized = normalizeForDedup(url);
    if (!normalized) continue; // Skip invalid URLs
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(url); // Keep original URL, not normalized
  }
  return result;
}

/**
 * Deduplicate an array of objects by a key function.
 * Keeps the first occurrence of each unique key.
 */
export function dedupeBy<T>(
  items: T[],
  keyFn: (item: T) => string | null
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Content-based deduplication for fetched pages.
 * Given an array of (url, content) pairs, returns unique items by content hash.
 */
export function dedupeByContent<T extends { url: string; content: string }>(
  items: T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const hash = sha256Hash(item.content);
    if (seen.has(hash)) continue;
    seen.add(hash);
    result.push(item);
  }
  return result;
}

/**
 * Check if a URL is likely a duplicate of an already-processed resource
 * by comparing against a set of known content hashes.
 * Returns the matching hash if found, null otherwise.
 */
export function findDuplicateByHash(
  content: string,
  knownHashes: Set<string>
): string | null {
  const hash = sha256Hash(content);
  return knownHashes.has(hash) ? hash : null;
}

/**
 * Generate a deterministic ID for a resource based on its URL.
 * Useful for generating stable IDs before database insertion.
 */
export function resourceIdFromUrl(url: string): string {
  return sha256Hash(url).slice(0, 32); // 128 bits = 32 hex chars
}

/**
 * Generate a deterministic ID for a curriculum based on its source URL.
 */
export function curriculumIdFromSourceUrl(url: string): string {
  return `cur_${sha256Hash(url).slice(0, 24)}`; // 96 bits
}