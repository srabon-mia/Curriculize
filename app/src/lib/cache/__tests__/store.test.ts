/**
 * Phase 11 Cache Store Tests
 * Basic functionality tests for the in-memory LRU cache with TTL.
 */

import { CacheStore } from "@/lib/cache/store";

describe("CacheStore", () => {
  let cache: CacheStore;

  beforeEach(() => {
    // Enabled by default for tests
    cache = new CacheStore({ enabled: true, maxEntries: 3 });
  });

  describe("Basic get/set", () => {
    test("returns null on miss when empty", () => {
      const val = cache.get<string>("resource-extraction", "missing", "v1");
      expect(val).toBeNull();
    });

    test("set and get hits", () => {
      cache.set("resource-extraction", "hash1", "value1");
      const val = cache.get<string>("resource-extraction", "hash1", "v1");
      expect(val).toBe("value1");
    });

    test("different versions are independent", () => {
      cache.set("resource-extraction", "hash1", "v1", { version: "v1" });
      cache.set("resource-extraction", "hash1", "v2", { version: "v2" });

      expect(cache.get("resource-extraction", "hash1", "v1")).toBe("v1");
      expect(cache.get("resource-extraction", "hash1", "v2")).toBe("v2");
    });

    test("different types are independent", () => {
      cache.set("resource-extraction", "hash1", "val1");
      cache.set("resource-verification", "hash1", "val2");

      expect(cache.get("resource-extraction", "hash1", "v1")).toBe("val1");
      expect(cache.get("resource-verification", "hash1", "v1")).toBe("val2");
    });
  });

  describe("LRU eviction", () => {
    test("evicts least recently used when at capacity", () => {
      // Fill cache to maxEntries (3)
      cache.set("resource-extraction", "a", "1");
      cache.set("resource-extraction", "b", "2");
      cache.set("resource-extraction", "c", "3");

      // Access 'a' to make it recently used
      cache.get("resource-extraction", "a", "v1");

      // Add 'd' - should evict 'b' (LRU)
      cache.set("resource-extraction", "d", "4");

      expect(cache.get("resource-extraction", "a", "v1")).toBe("1"); // still there (recently used)
      expect(cache.get("resource-extraction", "b", "v1")).toBeNull(); // evicted
      expect(cache.get("resource-extraction", "c", "v1")).toBe("3");
      expect(cache.get("resource-extraction", "d", "v1")).toBe("4");
    });

    test("no eviction when unlimited", () => {
      const unlimitedCache = new CacheStore({ enabled: true, maxEntries: 0 });
      for (let i = 0; i < 100; i++) {
        unlimitedCache.set("resource-extraction", `hash${i}`, `val${i}`);
      }
      expect(unlimitedCache.getStats().size).toBe(100);
    });
  });

  describe("Statistics", () => {
    test("tracks hits and misses", () => {
      cache.set("resource-extraction", "hash1", "val1");
      cache.get("resource-extraction", "hash1", "v1"); // hit
      cache.get("resource-extraction", "hash1", "v1"); // hit
      cache.get("resource-extraction", "hash2", "v1"); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    test("tracks evictions", () => {
      cache.set("resource-extraction", "a", "1");
      cache.set("resource-extraction", "b", "2");
      cache.set("resource-extraction", "c", "3"); // at capacity (3)
      cache.set("resource-extraction", "d", "4"); // evicts 'a'

      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
      expect(stats.size).toBe(3);
    });

    test("hit rate is 0 when no requests", () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe("Has and Delete", () => {
    test("has returns true for existing non-expired key", () => {
      cache.set("resource-extraction", "hash1", "val1");
      expect(cache.has("resource-extraction", "hash1", "v1")).toBe(true);
    });

    test("has returns false for missing key", () => {
      expect(cache.has("resource-extraction", "missing", "v1")).toBe(false);
    });

    test("delete removes key and returns true", () => {
      cache.set("resource-extraction", "hash1", "val1");
      const existed = cache.delete("resource-extraction", "hash1", "v1");
      expect(existed).toBe(true);
      expect(cache.get("resource-extraction", "hash1", "v1")).toBeNull();
    });

    test("delete returns false for missing key", () => {
      const existed = cache.delete("resource-extraction", "missing", "v1");
      expect(existed).toBe(false);
    });
  });

  describe("Invalidate", () => {
    test("invalidate by type removes only matching entries", () => {
      cache.set("resource-extraction", "hash1", "val1");
      cache.set("resource-verification", "hash1", "val2");
      cache.set("resource-extraction", "hash2", "val3");

      const result = cache.invalidate("resource-extraction");
      expect(result.removed).toBe(2);
      expect(cache.has("resource-extraction", "hash1", "v1")).toBe(false);
      expect(cache.has("resource-extraction", "hash2", "v1")).toBe(false);
      expect(cache.has("resource-verification", "hash1", "v1")).toBe(true);
    });

    test("invalidate all clears entire cache", () => {
      cache.set("resource-extraction", "hash1", "val1");
      cache.set("resource-verification", "hash1", "val2");
      cache.set("curriculum-extraction", "hash1", "val3");

      const result = cache.invalidate();
      expect(result.removed).toBe(3);
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("Clear", () => {
    test("clear removes all entries", () => {
      cache.set("resource-extraction", "hash1", "val1");
      cache.set("resource-extraction", "hash2", "val2");
      cache.clear();
      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("Disable behavior", () => {
    let disabledCache: CacheStore;

    beforeEach(() => {
      disabledCache = new CacheStore({ enabled: false });
    });

    test("all operations are no-ops when disabled", () => {
      disabledCache.set("resource-extraction", "hash1", "val1");
      expect(disabledCache.get("resource-extraction", "hash1", "v1")).toBeNull();
      expect(disabledCache.has("resource-extraction", "hash1", "v1")).toBe(false);
      const deleted = disabledCache.delete("resource-extraction", "hash1", "v1");
      expect(deleted).toBe(false);
    });
  });
});