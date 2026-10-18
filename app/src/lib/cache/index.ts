/**
 * Phase 11 Caching Module
 * Re-exports the cache store and key generation utilities.
 *
 * Usage:
 * ```typescript
 * import { getCacheStore, resourceExtractionKey, CacheType } from "@/lib/cache";
 *
 * const cache = getCacheStore();
 * const key = resourceExtractionKey(url);
 *
 * // Check cache
 * const cached = cache.get<AcquisitionResult>(CacheType["resource-extraction"], contentHash);
 * if (cached) return cached;
 *
 * // ... fetch/acquire/verify ...
 *
 * // Cache result
 * cache.set<AcquisitionResult>(CacheType["resource-extraction"], contentHash, result, { ttlMs: 30 * 24 * 60 * 60 * 1000 });
 * ```
 */

// Types
export type { CacheType, CacheEntry, CacheStats, CacheStoreOptions, InvalidationResult } from "./types";

// Main store class
export { CacheStore } from "./store";

// Factory functions
export { getCacheStore, createCache } from "./store";

// Key generation helpers (using contentCacheKey from deterministic/hash.ts)
export {
  resourceExtractionKey,
  baseCurriculumKey,
  studentAssemblyKey,
  resourceVerificationKey,
} from "./keys";