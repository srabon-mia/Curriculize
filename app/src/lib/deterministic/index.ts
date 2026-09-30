/**
 * Deterministic utilities for the Curriculum Generator acquisition pipeline.
 * All functions are pure, side-effect-free, and testable without network or AI.
 *
 * This module provides the foundation for:
 * - URL canonicalization and validation
 * - SSRF protection (host + IP blocklist, IPv4/IPv6)
 * - Content hashing (SHA-256)
 * - Deduplication (URL + content)
 * - Cache key generation
 */

export * from "./url";
export * from "./hash";
export * from "./dedup";

/**
 * Re-export commonly used types
 */
export type {
  CanonicalUrl,
  UrlValidationResult,
} from "./url";

export type {
  DedupKey,
} from "./dedup";

export { DedupTracker } from "./dedup";