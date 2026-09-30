/**
 * Content hashing utilities — deterministic, pure functions.
 * Uses Web Crypto API (Node.js 16+ / modern browsers) for SHA-256.
 * No external dependencies, no AI calls.
 */

import { createHash } from "crypto";

/**
 * Compute SHA-256 hash of a string (UTF-8 encoded).
 * Returns lowercase hex string (64 characters).
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute SHA-256 hash of a Buffer/Uint8Array.
 * Returns lowercase hex string (64 characters).
 */
export function sha256Buffer(input: Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Compute SHA-256 hash of a JSON-serializable value.
 * Uses deterministic JSON serialization (sorted keys) for consistency.
 */
export function sha256Json(value: unknown): string {
  const serialized = deterministicJsonStringify(value);
  return sha256(serialized);
}

/**
 * Deterministic JSON stringify — sorts object keys recursively.
 * Ensures identical objects produce identical strings regardless of key insertion order.
 */
export function deterministicJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  function stringify(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      return "[" + v.map(stringify).join(",") + "]";
    }
    if (typeof v === "object") {
      if (seen.has(v)) {
        // Circular reference — use a placeholder
        return '"[Circular]"';
      }
      seen.add(v);
      const entries = Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => `${JSON.stringify(k)}:${stringify(val)}`);
      seen.delete(v);
      return "{" + entries.join(",") + "}";
    }
    // undefined, function, symbol — treat as null
    return "null";
  }

  return stringify(value);
}

/**
 * Content hash with optional algorithm prefix for cache key versioning.
 * Default: sha256
 */
export function contentHash(
  input: string,
  algorithm: "sha256" = "sha256"
): string {
  if (algorithm !== "sha256") {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  return sha256(input);
}

/**
 * Generate a cache key from a content hash with version prefix.
 * Format: `resource-extraction:v1:<hash>`
 */
export function contentCacheKey(
  contentHash: string,
  type: "resource-extraction" | "curriculum-extraction" | "resource-verification" = "resource-extraction",
  version = "v1"
): string {
  return `${type}:${version}:${contentHash}`;
}

/**
 * Verify that a content hash matches the expected value.
 * Constant-time comparison to prevent timing attacks (though not strictly necessary for cache keys).
 */
export function verifyContentHash(
  content: string,
  expectedHash: string,
  algorithm: "sha256" = "sha256"
): boolean {
  const actual = contentHash(content, algorithm);
  // Constant-time comparison
  if (actual.length !== expectedHash.length) return false;
  let result = 0;
  for (let i = 0; i < actual.length; i++) {
    result |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Short hash prefix for display/debugging (first 16 chars of SHA-256).
 */
export function shortHash(hash: string, length = 16): string {
  return hash.slice(0, length);
}

/**
 * Hash a URL for deduplication — combines URL normalization with content hashing.
 * This creates a deterministic fingerprint for a resource location.
 */
export function urlFingerprint(url: string): string {
  return sha256(url);
}

/**
 * Hash a prompt + parameters for AI call caching.
 * Deterministic serialization ensures identical prompts produce identical keys.
 */
export function promptCacheKey(
  prompt: string,
  parameters: Record<string, unknown> = {},
  version = "v1"
): string {
  const combined = deterministicJsonStringify({ prompt, parameters });
  return `prompt:${version}:${sha256(combined)}`;
}