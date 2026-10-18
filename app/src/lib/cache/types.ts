/**
 * Phase 11 Cache Types
 * In-memory cache contracts for versioned content caching.
 * DB remains the durable source of truth; this cache is an optimization.
 */

import type { AcquisitionResult } from "@/lib/acquisition";

/** Cache entry categories — must match contentCacheKey() type values */
export type CacheType =
  | "resource-extraction"
  | "curriculum-extraction"
  | "resource-verification";

/** A single cached value with metadata for observability and invalidation */
export interface CacheEntry<T = unknown> {
  readonly key: string;
  readonly type: CacheType;
  readonly version: string;
  readonly value: T;
  /** Timestamp when stored, as a number of milliseconds since epoch */
  readonly storedAt: number;
  hits: number;
  readonly ttlMs?: number;
}

/** Aggregate cache statistics — used for observability, not as a source of truth */
export interface CacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly hitRate: number; // 0-1
}

/** Options for cache store construction */
export interface CacheStoreOptions {
  readonly maxEntries?: number; // LRU cap; 0 = unlimited
  readonly defaultTtlMs?: number; // per-entry TTL in ms; undefined = no expiry
  readonly enabled?: boolean; // false = all ops are no-ops (safe default)
}

/** Result of a cache invalidation operation */
export interface InvalidationResult {
  readonly removed: number;
  readonly keys: string[];
}

/** Re-export the acquisition result type for cache consumers */
export type { AcquisitionResult };