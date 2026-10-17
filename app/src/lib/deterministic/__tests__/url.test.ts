/**
 * Tests for URL canonicalization, validation, and SSRF protection.
 * Pure functions — no network, no AI, fully deterministic.
 */

import {
  canonicalizeUrl,
  validateUrl,
  isAllowedScheme,
  extractDomain,
  normalizeForDedup,
  urlCacheKey,
  isIpBlocked,
  isHostnameBlocked,
  resolveHostname,
} from "../url";

describe("canonicalizeUrl", () => {
  test("normalizes hostname to lowercase", () => {
    const result = canonicalizeUrl("https://EXAMPLE.COM/path");
    expect(result).not.toBeNull();
    expect(result?.parsed.hostname).toBe("example.com");
  });

  test("removes default HTTP port 80", () => {
    const result = canonicalizeUrl("http://example.com:80/path");
    expect(result).not.toBeNull();
    expect(result?.parsed.port).toBe("");
    expect(result?.url).toBe("http://example.com/path");
  });

  test("removes default HTTPS port 443", () => {
    const result = canonicalizeUrl("https://example.com:443/path");
    expect(result).not.toBeNull();
    expect(result?.parsed.port).toBe("");
    expect(result?.url).toBe("https://example.com/path");
  });

  test("keeps non-default ports", () => {
    const result = canonicalizeUrl("http://example.com:8080/path");
    expect(result).not.toBeNull();
    expect(result?.parsed.port).toBe("8080");
  });

  test("removes fragment", () => {
    const result = canonicalizeUrl("https://example.com/path#section");
    expect(result).not.toBeNull();
    expect(result?.parsed.hash).toBe("");
    expect(result?.url).not.toContain("#");
  });

  test("sorts query parameters alphabetically", () => {
    const result = canonicalizeUrl("https://example.com/path?z=1&a=2&m=3");
    expect(result).not.toBeNull();
    expect(result?.parsed.search).toBe("?a=2&m=3&z=1");
  });

  test("normalizes path (removes . and ..)", () => {
    const result = canonicalizeUrl("https://example.com/a/./b/../c");
    expect(result).not.toBeNull();
    expect(result?.parsed.pathname).toBe("/a/c");
  });

  test("returns null for unsupported schemes", () => {
    expect(canonicalizeUrl("ftp://example.com")).toBeNull();
    expect(canonicalizeUrl("file:///etc/passwd")).toBeNull();
    expect(canonicalizeUrl("data:text/html,test")).toBeNull();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
  });

  test("returns null for malformed URLs", () => {
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("")).toBeNull();
  });

  test("preserves original input in result", () => {
    const input = "https://EXAMPLE.COM:443/PATH?z=1#frag";
    const result = canonicalizeUrl(input);
    expect(result).not.toBeNull();
    expect(result?.original).toBe(input);
  });
});

describe("validateUrl", () => {
  test("accepts valid HTTP URL", () => {
    const result = validateUrl("http://example.com/path");
    expect(result.valid).toBe(true);
    expect(result.canonical).toBeDefined();
  });

  test("accepts valid HTTPS URL", () => {
    const result = validateUrl("https://example.com/path");
    expect(result.valid).toBe(true);
  });

  test("rejects unsupported schemes", () => {
    expect(validateUrl("ftp://example.com").valid).toBe(false);
    expect(validateUrl("file:///etc/passwd").valid).toBe(false);
    expect(validateUrl("mailto:test@example.com").valid).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(validateUrl("not a url").valid).toBe(false);
    expect(validateUrl("").valid).toBe(false);
  });

  test("blocks localhost hostname", () => {
    const result = validateUrl("http://localhost/path");
    expect(result.valid).toBe(false);
    expect(result.failures).toContain("Hostname 'localhost' is blocked (SSRF protection)");
  });

  test("blocks 127.0.0.1 hostname", () => {
    const result = validateUrl("http://127.0.0.1/path");
    expect(result.valid).toBe(false);
  });

  test("blocks metadata.google.internal", () => {
    const result = validateUrl("http://metadata.google.internal/path");
    expect(result.valid).toBe(false);
  });

  test("blocks resolved IPv4 in private range", () => {
    const result = validateUrl("http://example.com/path", {
      resolvedIps: { ipv4: ["10.0.0.1"], ipv6: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Resolved IPv4 '10.0.0.1' is blocked (SSRF protection)"
    );
  });

  test("blocks resolved IPv6 in private range", () => {
    const result = validateUrl("http://example.com/path", {
      resolvedIps: { ipv4: [], ipv6: ["::1"] },
    });
    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Resolved IPv6 '::1' is blocked (SSRF protection)"
    );
  });

  test("allows public IPs", () => {
    const result = validateUrl("http://example.com/path", {
      resolvedIps: { ipv4: ["8.8.8.8"], ipv6: ["2001:4860:4860::8888"] },
    });
    expect(result.valid).toBe(true);
  });

  test("blocks RFC1918 private ranges", () => {
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: ["10.1.2.3"], ipv6: [] },
      }).valid
    ).toBe(false);
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: ["172.16.0.1"], ipv6: [] },
      }).valid
    ).toBe(false);
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: ["192.168.1.1"], ipv6: [] },
      }).valid
    ).toBe(false);
  });

  test("blocks link-local addresses", () => {
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: ["169.254.1.1"], ipv6: [] },
      }).valid
    ).toBe(false);
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: [], ipv6: ["fe80::1"] },
      }).valid
    ).toBe(false);
  });

  test("blocks cloud metadata IP", () => {
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: ["169.254.169.254"], ipv6: [] },
      }).valid
    ).toBe(false);
  });

  test("allows public IPv6", () => {
    expect(
      validateUrl("http://example.com", {
        resolvedIps: { ipv4: [], ipv6: ["2001:db8::1"] },
      }).valid
    ).toBe(true);
  });
});

describe("isAllowedScheme", () => {
  test("returns true for http and https", () => {
    expect(isAllowedScheme("http://example.com")).toBe(true);
    expect(isAllowedScheme("https://example.com")).toBe(true);
  });

  test("returns false for other schemes", () => {
    expect(isAllowedScheme("ftp://example.com")).toBe(false);
    expect(isAllowedScheme("file:///etc/passwd")).toBe(false);
  });

  test("returns false for malformed URLs", () => {
    expect(isAllowedScheme("not a url")).toBe(false);
  });
});

describe("extractDomain", () => {
  test("extracts domain from simple URL", () => {
    expect(extractDomain("https://example.com/path")).toBe("example.com");
  });

  test("removes www prefix", () => {
    expect(extractDomain("https://www.example.com/path")).toBe("example.com");
  });

  test("handles multi-part TLDs (heuristic)", () => {
    expect(extractDomain("https://example.co.uk/path")).toBe("example.co.uk");
    expect(extractDomain("https://www.example.co.uk/path")).toBe("example.co.uk");
  });

  test("returns null for malformed URLs", () => {
    expect(extractDomain("not a url")).toBeNull();
  });
});

describe("normalizeForDedup", () => {
  test("removes tracking parameters", () => {
    const result = normalizeForDedup(
      "https://example.com/path?utm_source=test&utm_medium=email&real=value"
    );
    expect(result).not.toContain("utm_source");
    expect(result).not.toContain("utm_medium");
    expect(result).toContain("real=value");
  });

  test("normalizes www to non-www", () => {
    const result = normalizeForDedup("https://www.example.com/path");
    expect(result).not.toContain("www.");
  });

  test("sorts query parameters", () => {
    const result = normalizeForDedup("https://example.com/path?z=1&a=2");
    expect(result).toContain("a=2&z=1");
  });

  test("returns null for invalid URLs", () => {
    expect(normalizeForDedup("not a url")).toBeNull();
  });
});

describe("urlCacheKey", () => {
  test("generates deterministic cache key", () => {
    const key1 = urlCacheKey("https://example.com/path?z=1&a=2");
    const key2 = urlCacheKey("https://example.com/path?a=2&z=1");
    expect(key1).toBe(key2);
    expect(key1?.startsWith("url:v1:")).toBe(true);
  });

  test("returns null for invalid URLs", () => {
    expect(urlCacheKey("not a url")).toBeNull();
  });
});

describe("isIpBlocked", () => {
  test("blocks localhost IPv4", () => {
    expect(isIpBlocked("127.0.0.1")).toBe(true);
    expect(isIpBlocked("127.255.255.255")).toBe(true);
  });

  test("blocks IPv6 loopback", () => {
    expect(isIpBlocked("::1")).toBe(true);
    expect(isIpBlocked("[::1]")).toBe(true);
  });

  test("blocks RFC1918 private ranges", () => {
    expect(isIpBlocked("10.0.0.1")).toBe(true);
    expect(isIpBlocked("172.16.0.1")).toBe(true);
    expect(isIpBlocked("172.31.255.255")).toBe(true);
    expect(isIpBlocked("192.168.1.1")).toBe(true);
  });

  test("blocks link-local", () => {
    expect(isIpBlocked("169.254.1.1")).toBe(true);
    expect(isIpBlocked("fe80::1")).toBe(true);
  });

  test("blocks cloud metadata", () => {
    expect(isIpBlocked("169.254.169.254")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isIpBlocked("8.8.8.8")).toBe(false);
    expect(isIpBlocked("1.1.1.1")).toBe(false);
    expect(isIpBlocked("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isHostnameBlocked", () => {
  test("blocks localhost variants", () => {
    expect(isHostnameBlocked("localhost")).toBe(true);
    expect(isHostnameBlocked("LOCALHOST")).toBe(true);
    expect(isHostnameBlocked("localhost.localdomain")).toBe(true);
  });

  test("blocks metadata hostnames", () => {
    expect(isHostnameBlocked("metadata")).toBe(true);
    expect(isHostnameBlocked("metadata.google.internal")).toBe(true);
  });

  test("allows normal hostnames", () => {
    expect(isHostnameBlocked("example.com")).toBe(false);
    expect(isHostnameBlocked("api.github.com")).toBe(false);
  });
});

describe("resolveHostname", () => {
  test("returns empty arrays (stub implementation)", async () => {
    const result = await resolveHostname("example.com");
    expect(result.ipv4).toEqual([]);
    expect(result.ipv6).toEqual([]);
  });
});

describe("IPv4-mapped IPv6 SSRF protection", () => {
  test("blocks compressed IPv4-mapped IPv6 loopback", () => {
    expect(isIpBlocked("::ffff:127.0.0.1")).toBe(true);
    expect(isIpBlocked("::ffff:127.255.255.255")).toBe(true);
  });

  test("blocks compressed IPv4-mapped IPv6 private addresses", () => {
    expect(isIpBlocked("::ffff:10.0.0.1")).toBe(true);
    expect(isIpBlocked("::ffff:172.16.0.1")).toBe(true);
    expect(isIpBlocked("::ffff:192.168.1.1")).toBe(true);
  });

  test("blocks compressed IPv4-mapped IPv6 link-local and metadata", () => {
    expect(isIpBlocked("::ffff:169.254.1.1")).toBe(true);
    expect(isIpBlocked("::ffff:169.254.169.254")).toBe(true);
  });

  test("blocks expanded IPv4-mapped IPv6 (full form)", () => {
    expect(isIpBlocked("0:0:0:0:0:ffff:7f00:1")).toBe(true); // ::ffff:127.0.0.1 expanded
    expect(isIpBlocked("0:0:0:0:0:ffff:0a00:1")).toBe(true); // ::ffff:10.0.0.1 expanded
  });

  test("blocks IPv4-mapped IPv6 in resolved IPs via validateUrl", () => {
    const result = validateUrl("http://example.com", {
      resolvedIps: { ipv4: [], ipv6: ["::ffff:127.0.0.1"] },
    });
    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Resolved IPv6 '::ffff:127.0.0.1' is blocked (SSRF protection)"
    );
  });

  test("blocks IPv4-mapped IPv6 private in resolved IPs", () => {
    const result = validateUrl("http://example.com", {
      resolvedIps: { ipv4: [], ipv6: ["::ffff:10.0.0.1"] },
    });
    expect(result.valid).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 metadata in resolved IPs", () => {
    const result = validateUrl("http://example.com", {
      resolvedIps: { ipv4: [], ipv6: ["::ffff:169.254.169.254"] },
    });
    expect(result.valid).toBe(false);
  });

  test("allows non-mapped IPv6 public addresses", () => {
    expect(isIpBlocked("2001:db8::1")).toBe(false);
    expect(isIpBlocked("::ffff:8.8.8.8")).toBe(false); // mapped public
  });
});

describe("Trailing-dot hostname SSRF protection", () => {
  test("blocks trailing-dot localhost", () => {
    expect(isHostnameBlocked("localhost.")).toBe(true);
    expect(isHostnameBlocked("localhost..")).toBe(true); // multiple dots
  });

  test("blocks trailing-dot metadata.google.internal", () => {
    expect(isHostnameBlocked("metadata.google.internal.")).toBe(true);
    expect(isHostnameBlocked("metadata..")).toBe(true);
  });

  test("blocks trailing-dot hostname through validateUrl", () => {
    const result = validateUrl("http://localhost./path");
    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Hostname 'localhost.' is blocked (SSRF protection)"
    );
  });

  test("blocks trailing-dot metadata through validateUrl", () => {
    const result = validateUrl("http://metadata.google.internal./path");
    expect(result.valid).toBe(false);
    expect(result.failures).toContain(
      "Hostname 'metadata.google.internal.' is blocked (SSRF protection)"
    );
  });

  test("preserves existing hostname blocking", () => {
    expect(isHostnameBlocked("localhost")).toBe(true);
    expect(isHostnameBlocked("LOCALHOST")).toBe(true);
    expect(isHostnameBlocked("metadata")).toBe(true);
    expect(isHostnameBlocked("metadata.google.internal")).toBe(true);
  });

  test("allows normal hostnames", () => {
    expect(isHostnameBlocked("example.com")).toBe(false);
    expect(isHostnameBlocked("api.github.com")).toBe(false);
    expect(isHostnameBlocked("example.com.")).toBe(false);
  });
});

describe("Phase 9 migration canonical URL backfill differences", () => {
  // These tests demonstrate the differences between the TypeScript canonicalizeUrl
  // function and the PostgreSQL regex-based backfill used in migration 0006.
  // They document the gaps but do not test the migration directly (no DB access).

  test("hostname lowercasing: SQL lower() lowercases entire URL, not just hostname", () => {
    const tsResult = canonicalizeUrl("https://Example.COM:80/PATH?QUERY=VALUE#FRAG");
    // TS: keeps protocol 'https:' (unchanged), lowercases hostname to 'example.com',
    //     port :80 is NOT default for HTTPS (default is :443), so it is KEPT,
    //     fragment removed, path/query case preserved
    // result: 'https://example.com:80/PATH?QUERY=VALUE'
    expect(tsResult).not.toBeNull();
    expect(tsResult?.url).toBe("https://example.com:80/PATH?QUERY=VALUE");

    // SQL backfill approximation (regex only, no full URL parser):
    // lower('https://Example.COM:80/PATH?QUERY=VALUE#FRAG') ->
    //   'https://example.com:80/path?query=value#frag'
    // regexp_replace('^https?://', '', 'i') ->
    //   'example.com:80/path?query=value#frag'
    // regexp_replace('#.*$', '') ->
    //   'example.com:80/path?query=value'
    // regexp_replace('(:80|:443)(/|$)', '\2') ->
    //   'example.com/path?query=value'
    const sqlApprox = 'example.com/path?query=value';
    expect(sqlApprox).toBe("example.com/path?query=value");

    // Documented differences:
    // 1. TS preserves case in path/query: 'PATH?QUERY=VALUE'
    // 2. TS keeps protocol 'https:', SQL strips scheme entirely
    // 3. TS keeps port :80 for HTTPS (not default), SQL removes :80 unconditionally
    // 4. SQL backfill lowercases path/query: 'path?query=value'
  });

  test("default port removal: SQL regex lacks protocol context", () => {
    // Case 1: HTTP with :80 - should be removed
    const httpResult = canonicalizeUrl("http://example.com:80/path");
    expect(httpResult).not.toBeNull();
    expect(httpResult?.url).toBe("http://example.com/path");

    // Case 2: HTTPS with :443 - should be removed
    const httpsResult = canonicalizeUrl("https://example.com:443/path");
    expect(httpsResult).not.toBeNull();
    expect(httpsResult?.url).toBe("https://example.com/path");

    // Case 3: HTTP with :443 (non-standard for HTTP) - should NOT be removed
    const http443Result = canonicalizeUrl("http://example.com:443/path");
    expect(http443Result).not.toBeNull();
    expect(http443Result?.url).toBe("http://example.com:443/path");

    // SQL regex (:80|:443)(/|$) would incorrectly remove :443 from HTTP URLs.
    // This demonstrates why the SQL backfill is approximate.
  });

  test("query parameter sorting: SQL does not sort, TypeScript does", () => {
    const tsResult = canonicalizeUrl("https://example.com/path?z=1&a=2&m=3");
    expect(tsResult).not.toBeNull();
    expect(tsResult?.parsed.search).toBe("?a=2&m=3&z=1"); // Sorted alphabetically

    // SQL backfill does NOT sort query parameters.
    // Input after scheme/host/fragment/port stripping: 'example.com/path?z=1&a=2&m=3'
    // SQL leaves it as-is: 'example.com/path?z=1&a=2&m=3'
  });

  test("path normalization: SQL does not resolve . and .., TypeScript does", () => {
    const tsResult = canonicalizeUrl("https://example.com/a/./b/../c");
    expect(tsResult).not.toBeNull();
    expect(tsResult?.parsed.pathname).toBe("/a/c"); // Resolved . and ..

    // SQL backfill does NOT normalize path.
    // Input after scheme/host/fragment/port stripping: 'example.com/a/./b/../c'
    // SQL leaves it as-is: 'example.com/a/./b/../c'
  });

  test("combined example: demonstrating cumulative differences", () => {
    const input = "https://Example.COM:80/a/./b/../c?z=1&a=2#section";

    // TypeScript canonicalizeUrl:
    // 1. new URL() -> hostname='Example.COM', port='80', pathname='/a/./b/../c', search='?z=1&a=2', hash='#section'
    // 2. protocol check: passes (https:)
    // 3. hostname lowercasing: 'example.com'
    // 4. port removal: port 80 is NOT default for HTTPS, so it is KEPT
    // 5. fragment removal: hash=''
    // 6. query sorting: '?a=2&z=1'
    // 7. path normalization: '/a/c'
    // result: 'https://example.com:80/a/c?a=2&z=1'
    const tsResult = canonicalizeUrl(input);
    expect(tsResult).not.toBeNull();
    expect(tsResult?.url).toBe("https://example.com:80/a/c?a=2&z=1");

    // SQL backfill approximation:
    // lower() -> 'https://example.com:80/a/./b/../c?z=1&a=2#section'
    // strip scheme -> 'example.com:80/a/./b/../c?z=1&a=2#section'
    // strip fragment -> 'example.com:80/a/./b/../c?z=1&a=2'
    // strip :80 -> 'example.com/a/./b/../c?z=1&a=2'
    // result: 'example.com/a/./b/../c?z=1&a=2' (path not normalized, query not sorted, port incorrectly removed)
    const sqlApprox = "example.com/a/./b/../c?z=1&a=2";
    expect(sqlApprox).toBe("example.com/a/./b/../c?z=1&a=2");
  });
});