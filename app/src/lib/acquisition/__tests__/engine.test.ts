/**
 * Tests for Phase 5 Acquisition Engine
 */

import { AcquisitionDedupTracker, validateCandidate, getCandidateDedupKey } from "../engine";
import { AcquisitionError, isAcquisitionError } from "../errors";
import type { DiscoveryCandidate } from "../types";

describe("AcquisitionDedupTracker", () => {
  let tracker: AcquisitionDedupTracker;

  beforeEach(() => {
    tracker = new AcquisitionDedupTracker();
  });

  test("tracks unique URLs", () => {
    expect(tracker.checkUrl("https://example.com/a")).toBe(false);
    expect(tracker.checkUrl("https://example.com/b")).toBe(false);
    expect(tracker.urlCount).toBe(2);
  });

  test("detects duplicate URLs (normalized)", () => {
    expect(tracker.checkUrl("https://example.com/path?z=1&a=2")).toBe(false);
    expect(tracker.checkUrl("https://example.com/path?a=2&z=1")).toBe(true);
    expect(tracker.urlCount).toBe(1);
  });

  test("tracks content hashes", () => {
    expect(tracker.checkContentHash("hash1")).toBe(false);
    expect(tracker.checkContentHash("hash2")).toBe(false);
    expect(tracker.hashCount).toBe(2);
  });

  test("detects duplicate content hashes", () => {
    expect(tracker.checkContentHash("hash1")).toBe(false);
    expect(tracker.checkContentHash("hash1")).toBe(true);
    expect(tracker.hashCount).toBe(1);
  });

  test("ignores empty hashes", () => {
    expect(tracker.checkContentHash("")).toBe(false);
    expect(tracker.hashCount).toBe(0);
  });

  test("clear resets both trackers", () => {
    tracker.checkUrl("https://example.com/a");
    tracker.checkContentHash("hash1");
    tracker.clear();
    expect(tracker.urlCount).toBe(0);
    expect(tracker.hashCount).toBe(0);
  });
});

describe("validateCandidate", () => {
  const validCandidate: DiscoveryCandidate = { url: "https://example.com/page" };

  test("accepts valid HTTPS URL", () => {
    const canonical = validateCandidate(validCandidate);
    expect(canonical.url).toBe("https://example.com/page");
    expect(canonical.parsed.hostname).toBe("example.com");
  });

  test("accepts valid HTTP URL", () => {
    const canonical = validateCandidate({ url: "http://example.com/page" });
    expect(canonical.url).toBe("http://example.com/page");
  });

  test("rejects invalid URL", () => {
    expect(() => validateCandidate({ url: "not a url" })).toThrow(AcquisitionError);
    expect(() => validateCandidate({ url: "not a url" })).toThrow("INVALID_URL");
  });

  test("rejects blocked schemes", () => {
    expect(() => validateCandidate({ url: "ftp://example.com" })).toThrow("INVALID_URL");
    expect(() => validateCandidate({ url: "file:///etc/passwd" })).toThrow("INVALID_URL");
    expect(() => validateCandidate({ url: "javascript:alert(1)" })).toThrow("INVALID_URL");
  });

  test("rejects blocked hostnames", () => {
    expect(() => validateCandidate({ url: "http://localhost/" })).toThrow("BLOCKED_URL");
    expect(() => validateCandidate({ url: "http://metadata.google.internal/" })).toThrow("BLOCKED_URL");
  });
});

describe("getCandidateDedupKey", () => {
  test("returns dedup key for valid URL", () => {
    const key = getCandidateDedupKey({ url: "https://example.com/path" });
    expect(key).not.toBeNull();
    expect(key?.normalizedUrl).toContain("example.com");
    expect(key?.canonicalUrl).toContain("example.com");
  });

  test("normalizes consistently", () => {
    const key1 = getCandidateDedupKey({ url: "https://EXAMPLE.COM/path?z=1&a=2" });
    const key2 = getCandidateDedupKey({ url: "https://example.com/path?a=2&z=1" });
    expect(key1?.normalizedUrl).toBe(key2?.normalizedUrl);
  });

  test("returns null for invalid URL", () => {
    expect(getCandidateDedupKey({ url: "not a url" })).toBeNull();
  });
});

describe("isAcquisitionError type guard", () => {
  test("identifies AcquisitionError", () => {
    const err = new AcquisitionError("TIMEOUT", {});
    expect(isAcquisitionError(err)).toBe(true);
  });

  test("rejects regular Error", () => {
    expect(isAcquisitionError(new Error("regular"))).toBe(false);
  });

  test("rejects plain objects", () => {
    expect(isAcquisitionError({ code: "TIMEOUT" })).toBe(false);
  });
});

describe("acquireCandidate: EMPTY_CONTENT error type", () => {
  test("EMPTY_CONTENT error code exists and formats correctly", () => {
    const err = new AcquisitionError("EMPTY_CONTENT", { url: "https://youtube.com/watch?v=123" });
    expect(err.code).toBe("EMPTY_CONTENT");
    expect(err.message).toContain("EMPTY_CONTENT");
  });

  test("EMPTY_CONTENT error includes diagnostic details", () => {
    const err = new AcquisitionError("EMPTY_CONTENT", {
      url: "https://example.com/empty",
      statusCode: 200,
      contentType: "text/html",
      title: "Empty Page",
    });
    expect(err.details.url).toBe("https://example.com/empty");
    expect(err.details.statusCode).toBe(200);
    expect(err.details.contentType).toBe("text/html");
    expect(err.details.title).toBe("Empty Page");
  });
});