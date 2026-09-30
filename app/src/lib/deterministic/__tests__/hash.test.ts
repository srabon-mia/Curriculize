/**
 * Tests for content hashing utilities.
 * Pure functions — no network, no AI, fully deterministic.
 */

import {
  sha256,
  sha256Buffer,
  sha256Json,
  deterministicJsonStringify,
  contentHash,
  contentCacheKey,
  verifyContentHash,
  shortHash,
  urlFingerprint,
  promptCacheKey,
} from "../hash";

describe("sha256", () => {
  test("produces consistent hash for same input", () => {
    const input = "hello world";
    const hash1 = sha256(input);
    const hash2 = sha256(input);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // 256 bits = 64 hex chars
  });

  test("produces different hashes for different inputs", () => {
    expect(sha256("hello")).not.toBe(sha256("world"));
  });

  test("handles empty string", () => {
    const hash = sha256("");
    expect(hash.length).toBe(64);
    // Known SHA-256 of empty string
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  test("handles unicode correctly", () => {
    const hash = sha256("héllo 🌍");
    expect(hash.length).toBe(64);
    expect(sha256("héllo 🌍")).toBe(hash);
  });

  test("handles long strings", () => {
    const long = "a".repeat(10000);
    const hash = sha256(long);
    expect(hash.length).toBe(64);
    expect(sha256(long)).toBe(hash);
  });
});

describe("sha256Buffer", () => {
  test("produces same hash as string version for UTF-8 content", () => {
    const str = "test content";
    const strHash = sha256(str);
    const bufHash = sha256Buffer(Buffer.from(str, "utf8"));
    expect(strHash).toBe(bufHash);
  });

  test("works with Uint8Array", () => {
    const arr = new Uint8Array([1, 2, 3, 4]);
    const hash = sha256Buffer(arr);
    expect(hash.length).toBe(64);
  });
});

describe("deterministicJsonStringify", () => {
  test("sorts object keys alphabetically", () => {
    const obj = { z: 1, a: 2, m: 3 };
    const result = deterministicJsonStringify(obj);
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  test("handles nested objects", () => {
    const obj = { outer: { z: 1, a: 2 } };
    const result = deterministicJsonStringify(obj);
    expect(result).toBe('{"outer":{"a":2,"z":1}}');
  });

  test("handles arrays", () => {
    const arr = [3, 1, 2];
    const result = deterministicJsonStringify(arr);
    expect(result).toBe("[3,1,2]");
  });

  test("handles mixed types", () => {
    const obj = {
      str: "hello",
      num: 42,
      bool: true,
      null: null,
      arr: [1, 2],
      nested: { b: 1, a: 2 },
    };
    const result = deterministicJsonStringify(obj);
    expect(result).toContain('"str":"hello"');
    expect(result).toContain('"num":42');
    expect(result).toContain('"bool":true');
    expect(result).toContain('"null":null');
    expect(result).toContain('"arr":[1,2]');
    expect(result).toContain('"nested":{"a":2,"b":1}');
  });

  test("handles circular references gracefully", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = deterministicJsonStringify(obj);
    expect(result).toContain('[Circular]');
  });

  test("produces identical output for same logical object", () => {
    const obj1 = { b: 1, a: 2 };
    const obj2 = { a: 2, b: 1 };
    expect(deterministicJsonStringify(obj1)).toBe(deterministicJsonStringify(obj2));
  });
});

describe("sha256Json", () => {
  test("produces consistent hash for logically identical objects", () => {
    const obj1 = { b: 1, a: 2 };
    const obj2 = { a: 2, b: 1 };
    expect(sha256Json(obj1)).toBe(sha256Json(obj2));
  });

  test("produces different hashes for different objects", () => {
    expect(sha256Json({ a: 1 })).not.toBe(sha256Json({ a: 2 }));
  });
});

describe("contentHash", () => {
  test("defaults to sha256", () => {
    expect(contentHash("test")).toBe(sha256("test"));
  });

  test("throws for unsupported algorithm", () => {
    expect(() => contentHash("test", "md5" as "sha256")).toThrow();
  });
});

describe("contentCacheKey", () => {
  test("generates resource-extraction key by default", () => {
    const hash = "abc123";
    const key = contentCacheKey(hash);
    expect(key).toBe("resource-extraction:v1:abc123");
  });

  test("supports curriculum-extraction type", () => {
    const key = contentCacheKey("hash", "curriculum-extraction");
    expect(key).toBe("curriculum-extraction:v1:hash");
  });

  test("supports resource-verification type", () => {
    const key = contentCacheKey("hash", "resource-verification");
    expect(key).toBe("resource-verification:v1:hash");
  });

  test("supports custom version", () => {
    const key = contentCacheKey("hash", "resource-extraction", "v2");
    expect(key).toBe("resource-extraction:v2:hash");
  });
});

describe("verifyContentHash", () => {
  test("returns true for matching content and hash", () => {
    const content = "test content";
    const hash = sha256(content);
    expect(verifyContentHash(content, hash)).toBe(true);
  });

  test("returns false for mismatched content", () => {
    expect(verifyContentHash("content1", sha256("content2"))).toBe(false);
  });

  test("returns false for wrong length hash", () => {
    expect(verifyContentHash("content", "short")).toBe(false);
  });

  test("constant-time comparison (same length, different content)", () => {
    const hash1 = sha256("content1");
    const hash2 = sha256("content2");
    // Both 64 chars, different content
    expect(verifyContentHash("content1", hash2)).toBe(false);
    // hash1 used implicitly for type-checking the constant-time path
    void hash1;
  });
});

describe("shortHash", () => {
  test("returns first N characters", () => {
    const hash = "abcdef1234567890abcdef1234567890";
    expect(shortHash(hash, 8)).toBe("abcdef12");
    expect(shortHash(hash, 16)).toBe("abcdef1234567890");
  });

  test("defaults to 16 chars", () => {
    const hash = "abcdef1234567890abcdef1234567890";
    expect(shortHash(hash)).toBe("abcdef1234567890");
  });
});

describe("urlFingerprint", () => {
  test("produces consistent fingerprint for same URL", () => {
    const fp1 = urlFingerprint("https://example.com/path");
    const fp2 = urlFingerprint("https://example.com/path");
    expect(fp1).toBe(fp2);
  });

  test("produces different fingerprints for different URLs", () => {
    expect(urlFingerprint("https://a.com")).not.toBe(
      urlFingerprint("https://b.com")
    );
  });
});

describe("promptCacheKey", () => {
  test("produces consistent key for same prompt and parameters", () => {
    const key1 = promptCacheKey("prompt", { temp: 0.7 });
    const key2 = promptCacheKey("prompt", { temp: 0.7 });
    expect(key1).toBe(key2);
  });

  test("sorts parameters for consistency", () => {
    const key1 = promptCacheKey("prompt", { z: 1, a: 2 });
    const key2 = promptCacheKey("prompt", { a: 2, z: 1 });
    expect(key1).toBe(key2);
  });

  test("includes version prefix", () => {
    const key = promptCacheKey("prompt", {}, "v2");
    expect(key.startsWith("prompt:v2:")).toBe(true);
  });

  test("different prompts produce different keys", () => {
    expect(promptCacheKey("prompt1")).not.toBe(promptCacheKey("prompt2"));
  });
});