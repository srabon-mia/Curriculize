/**
 * Phase 11 Cache Store
 * Simple in-memory LRU cache with TTL and versioned key support.
 *
 * This is purely an optimization layer:
 * - Disabled by default (enabled: false) to preserve existing behavior
 * - When enabled, serves as a fast lookup before expensive acquisition
 * - DB remains the durable source of truth; cache misses proceed to source
 * - No behavior change when disabled (safe for incrementality)
 *
 * Key format: `${type}:${version}:${contentHash}` via contentCacheKey()
 * See: app/src/lib/deterministic/hash.ts
 */

import type { CacheEntry, CacheStats, CacheStoreOptions, CacheType, InvalidationResult } from "./types";
import { contentCacheKey } from "@/lib/deterministic/hash";

/**
 * Simple string-based LRU cache using Map.
 * Evicts least recently accessed entries when maxEntries exceeded.
 * Optional TTL-based expiry per entry.
 */
export class CacheStore {
  private store: Map<string, CacheEntry>;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | undefined;
  private readonly enabled: boolean;
  private stats: {
    hits: number;
    misses: number;
    evictions: number;
  };

  constructor(options: CacheStoreOptions = {}) {
    this.store = new Map();
    this.maxEntries = options.maxEntries ?? 0; // 0 = unlimited
    this.defaultTtlMs = options.defaultTtlMs;
    this.enabled = options.enabled ?? false;
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get a value from cache if present and not expired.
   * Returns null on miss, expiry, or when disabled.
   * Updates LRU on hit (access time).
   */
  get<T>(type: CacheType, contentHash: string, version = "v1"): T | null {
    if (!this.enabled) return null;
    const key = contentCacheKey(contentHash, type, version);
    const entry = this.store.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiry
    if (entry.ttlMs !== undefined && Date.now() > entry.storedAt + entry.ttlMs) {
      this.store.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return null;
    }

    // LRU: move to end by delete+set
    this.store.delete(key);
    this.store.set(key, entry);
    this.stats.hits++;
    entry.hits++;
    return entry.value;
  }

  /**
   * Set a value in cache with optional TTL.
   * Respects maxEntries (LRU eviction if needed).
   * No-op when disabled.
   */
  set<T>(
    type: CacheType,
    contentHash: string,
    value: T,
    options: { version?: string; ttlMs?: number } = {}
  ): void {
    if (!this.enabled) return;
    const { version = "v1", ttlMs = this.defaultTtlMs } = options;
    const key = contentCacheKey(contentHash, type, version);

    // Evict LRU if at capacity
    if (this.maxEntries > 0 && this.store.size >= this.maxEntries) {
      // Remove first entry (oldest by insertion order in Map)
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
        this.stats.evictions++;
      }
    }

    this.store.set(key, {
      key,
      type,
      version,
      value,
      storedAt: Date.now(),
      hits: 0,
      ttlMs,
    });
  }

  /**
   * Check if a key exists and is not expired.
   * Does NOT update LRU or hit stats (peek-only).
   */
  has(type: CacheType, contentHash: string, version = "v1"): boolean {
    if (!this.enabled) return false;
    const key = contentCacheKey(contentHash, type, version);
    const entry = this.store.get(key) as CacheEntry | undefined;
    if (!entry) return false;
    if (entry.ttlMs !== undefined && Date.now() > entry.storedAt + entry.ttlMs) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Delete a specific key from cache.
   * Returns true if key existed and was removed.
   */
  delete(type: CacheType, contentHash: string, version = "v1"): boolean {
    if (!this.enabled) return false;
    const key = contentCacheKey(contentHash, type, version);
    const existed = this.store.delete(key);
    if (existed) this.stats.evictions++;
    return existed;
  }

  /**
   * Invalidate entries matching optional filters.
   * If no filters provided, clears entire cache.
   */
  invalidate(type?: CacheType, contentHash?: string, version?: string): InvalidationResult {
    if (!this.enabled) return { removed: 0, keys: [] };
    const toRemove: string[] = [];

    for (const [key, entry] of this.store.entries()) {
      const matches =
        (!type || entry.type === type) &&
        (!contentHash || key.includes(contentHash)) &&
        (!version || entry.version === version);
      if (matches) toRemove.push(key);
    }

    for (const key of toRemove) {
      this.store.delete(key);
    }

    this.stats.evictions += toRemove.length;
    return { removed: toRemove.length, keys: toRemove };
  }

  /**
   * Remove all entries from cache.
   */
  clear(): void {
    if (!this.enabled) return;
    const size = this.store.size;
    this.store.clear();
    this.stats.evictions += size;
  }

  /**
   * Get current cache statistics.
   * Hit rate is hits/(hits+misses) or 0 if no requests.
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.store.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate: total === 0 ? 0 : this.stats.hits / total,
    };
  }

  /**
   * Raw-key accessors.
   * These accept a full key string (e.g. from resourceExtractionKey()) so callers
   * can use the versioned key format directly without re-deriving type/version.
   * No-op when disabled.
   */

  /** Get a value by full key string. Returns null on miss/expiry/disabled. */
  getRaw<T>(key: string): T | null {
    if (!this.enabled) return null;
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (entry.ttlMs !== undefined && Date.now() > entry.storedAt + entry.ttlMs) {
      this.store.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return null;
    }
    // LRU: move to end by delete+set
    this.store.delete(key);
    this.store.set(key, entry);
    this.stats.hits++;
    entry.hits++;
    return entry.value;
  }

  /** Set a value by full key string with optional TTL. No-op when disabled. */
  setRaw<T>(key: string, value: T, options: { ttlMs?: number } = {}): void {
    if (!this.enabled) return;
    const { ttlMs = this.defaultTtlMs } = options;

    // Evict LRU if at capacity
    if (this.maxEntries > 0 && this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
        this.stats.evictions++;
      }
    }

    this.store.set(key, {
      key,
      type: "resource-extraction",
      version: "v1",
      value,
      storedAt: Date.now(),
      hits: 0,
      ttlMs,
    });
  }

  /** Check if a full key exists and is not expired. Peek-only (no LRU update). */
  hasRaw(key: string): boolean {
    if (!this.enabled) return false;
    const entry = this.store.get(key) as CacheEntry | undefined;
    if (!entry) return false;
    if (entry.ttlMs !== undefined && Date.now() > entry.storedAt + entry.ttlMs) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /** Delete a full key. Returns true if it existed. */
  deleteRaw(key: string): boolean {
    if (!this.enabled) return false;
    const existed = this.store.delete(key);
    if (existed) this.stats.evictions++;
    return existed;
  }
}

/**
 * Global singleton cache instance for application use.
 * Disabled by default to preserve existing behavior.
 */
const globalCache = new CacheStore();

/**
 * Get the global cache instance.
 * Use this in application code; tests should create fresh instances.
 */
export function getCacheStore(): CacheStore {
  return globalCache;
}

/**
 * Create a fresh cache instance (useful for testing or scoped lifecycles).
 * Enabled by default for test convenience.
 */
export function createCache(options: CacheStoreOptions = {}): CacheStore {
  return new CacheStore({ enabled: true, ...options });
}