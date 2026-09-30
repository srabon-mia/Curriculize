/**
 * Tests for deduplication utilities.
 * Pure functions — no network, no AI, fully deterministic.
 */

import {
  makeDedupKey,
  keysEqual,
  DedupTracker,
  dedupeUrls,
  dedupeBy,
  dedupeByContent,
  findDuplicateByHash,
  resourceIdFromUrl,
  curriculumIdFromSourceUrl,
} from "../dedup";
import { sha256 } from "../hash";

describe("makeDedupKey", () => {
  test("creates key from valid URL", () => {
    const key = makeDedupKey("https://example.com/path");
    expect(key).not.toBeNull();
    expect(key?.normalizedUrl).toContain("example.com");
    expect(key?.contentHash).toBe("");
    expect(key?.canonicalUrl).toContain("example.com");
  });

  test("includes content hash when provided", () => {
    const key = makeDedupKey("https://example.com/path", "content");
    expect(key).not.toBeNull();
    expect(key?.contentHash).toBeTruthy();
    expect(key?.contentHash.length).toBe(64);
  });

  test("returns null for invalid URL", () => {
    expect(makeDedupKey("not a url")).toBeNull();
  });

  test("normalizes URL consistently", () => {
    const key1 = makeDedupKey("https://EXAMPLE.COM/path?z=1&a=2");
    const key2 = makeDedupKey("https://example.com/path?a=2&z=1");
    expect(key1?.normalizedUrl).toBe(key2?.normalizedUrl);
  });
});

describe("keysEqual", () => {
  test("compares by content hash when both present", () => {
    const key1 = makeDedupKey("https://a.com", "content")!;
    const key2 = makeDedupKey("https://b.com", "content")!;
    expect(keysEqual(key1, key2)).toBe(true);
  });

  test("different content hashes are not equal", () => {
    const key1 = makeDedupKey("https://a.com", "content1")!;
    const key2 = makeDedupKey("https://b.com", "content2")!;
    expect(keysEqual(key1, key2)).toBe(false);
  });

  test("falls back to normalized URL when no content hash", () => {
    const key1 = makeDedupKey("https://example.com/path?z=1&a=2")!;
    const key2 = makeDedupKey("https://example.com/path?a=2&z=1")!;
    expect(keysEqual(key1, key2)).toBe(true);
  });

  test("different normalized URLs are not equal", () => {
    const key1 = makeDedupKey("https://a.com")!;
    const key2 = makeDedupKey("https://b.com")!;
    expect(keysEqual(key1, key2)).toBe(false);
  });
});

describe("DedupTracker", () => {
  let tracker: DedupTracker;

  beforeEach(() => {
    tracker = new DedupTracker();
  });

  test("tracks unique URLs", () => {
    expect(tracker.checkAndMark("https://example.com/a")).toBe(false);
    expect(tracker.checkAndMark("https://example.com/b")).toBe(false);
    expect(tracker.urlCount).toBe(2);
  });

  test("detects duplicate URLs", () => {
    expect(tracker.checkAndMark("https://example.com/a")).toBe(false);
    expect(tracker.checkAndMark("https://example.com/a")).toBe(true);
    expect(tracker.urlCount).toBe(1);
  });

  test("normalizes URLs for deduplication", () => {
    expect(tracker.checkAndMark("https://example.com/a?z=1&a=2")).toBe(false);
    expect(tracker.checkAndMark("https://example.com/a?a=2&z=1")).toBe(true);
  });

  test("tracks content hashes separately", () => {
    expect(tracker.checkAndMarkHash("hash1")).toBe(false);
    expect(tracker.checkAndMarkHash("hash2")).toBe(false);
    expect(tracker.hashCount).toBe(2);
  });

  test("detects duplicate content hashes", () => {
    expect(tracker.checkAndMarkHash("hash1")).toBe(false);
    expect(tracker.checkAndMarkHash("hash1")).toBe(true);
    expect(tracker.hashCount).toBe(1);
  });

  test("ignores empty hashes", () => {
    expect(tracker.checkAndMarkHash("")).toBe(false);
    expect(tracker.hashCount).toBe(0);
  });

  test("clear resets both trackers", () => {
    tracker.checkAndMark("https://example.com/a");
    tracker.checkAndMarkHash("hash1");
    tracker.clear();
    expect(tracker.urlCount).toBe(0);
    expect(tracker.hashCount).toBe(0);
  });
});

describe("dedupeUrls", () => {
  test("removes duplicate URLs", () => {
    const urls = [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/a",
    ];
    const result = dedupeUrls(urls);
    expect(result).toHaveLength(2);
    expect(result).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  test("normalizes for comparison but keeps original", () => {
    const urls = [
      "https://example.com/path?z=1&a=2",
      "https://example.com/path?a=2&z=1",
    ];
    const result = dedupeUrls(urls);
    expect(result).toHaveLength(1);
    // Keeps the first original URL
    expect(result[0]).toBe("https://example.com/path?z=1&a=2");
  });

  test("skips invalid URLs", () => {
    const urls = ["https://example.com/a", "not a url", "https://example.com/b"];
    const result = dedupeUrls(urls);
    expect(result).toHaveLength(2);
  });

  test("handles empty array", () => {
    expect(dedupeUrls([])).toEqual([]);
  });
});

describe("dedupeBy", () => {
  test("deduplicates by key function", () => {
    const items = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "a" },
    ];
    const result = dedupeBy(items, (item) => item.name);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toEqual([1, 2]);
  });

  test("skips items with null key", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = dedupeBy(items, () => null);
    expect(result).toHaveLength(0);
  });
});

describe("dedupeByContent", () => {
  test("deduplicates by content hash", () => {
    const items = [
      { url: "https://a.com", content: "same content" },
      { url: "https://b.com", content: "different" },
      { url: "https://c.com", content: "same content" },
    ];
    const result = dedupeByContent(items);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.url)).toEqual(["https://a.com", "https://b.com"]);
  });

  test("handles empty array", () => {
    expect(dedupeByContent([])).toEqual([]);
  });
});

describe("findDuplicateByHash", () => {
  test("finds matching hash in known set", () => {
    const known = new Set(["abc123", "def456"]);
    const content = "test";
    const hash = sha256(content);
    const result = findDuplicateByHash(content, new Set([hash]));
    expect(result).toBe(hash);
  });

  test("returns null for unknown content", () => {
    const known = new Set(["abc123"]);
    const result = findDuplicateByHash("unknown", known);
    expect(result).toBeNull();
  });
});

describe("resourceIdFromUrl", () => {
  test("generates deterministic ID from URL", () => {
    const id1 = resourceIdFromUrl("https://example.com/path");
    const id2 = resourceIdFromUrl("https://example.com/path");
    expect(id1).toBe(id2);
    expect(id1.length).toBe(32); // 128 bits = 32 hex chars
  });

  test("different URLs produce different IDs", () => {
    expect(resourceIdFromUrl("https://a.com")).not.toBe(
      resourceIdFromUrl("https://b.com")
    );
  });
});

describe("curriculumIdFromSourceUrl", () => {
  test("generates deterministic curriculum ID from source URL", () => {
    const id1 = curriculumIdFromSourceUrl("https://example.com/curriculum");
    const id2 = curriculumIdFromSourceUrl("https://example.com/curriculum");
    expect(id1).toBe(id2);
    expect(id1.startsWith("cur_")).toBe(true);
    expect(id1.length).toBe(28); // "cur_" + 24 hex chars
  });

  test("different URLs produce different IDs", () => {
    expect(curriculumIdFromSourceUrl("https://a.com")).not.toBe(
      curriculumIdFromSourceUrl("https://b.com")
    );
  });
});