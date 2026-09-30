/**
 * Tests for Phase 5 DNS Resolution with SSRF Protection
 * Note: These test the logic; actual DNS resolution is mocked in integration tests.
 */

import { normalizeHostname, checkHostnameBlocked, validateResolvedIps, canReuseResolution } from "../dns";
import { isAcquisitionError } from "../errors";

describe("normalizeHostname", () => {
  test("lowercases hostname", () => {
    expect(normalizeHostname("EXAMPLE.COM")).toBe("example.com");
  });

  test("strips trailing dots", () => {
    expect(normalizeHostname("example.com.")).toBe("example.com");
    expect(normalizeHostname("example.com..")).toBe("example.com");
    expect(normalizeHostname("example.com...")).toBe("example.com");
  });

  test("handles mixed case with trailing dots", () => {
    expect(normalizeHostname("EXAMPLE.COM.")).toBe("example.com");
  });
});

describe("checkHostnameBlocked", () => {
  test("blocks localhost", () => {
    const err = checkHostnameBlocked("localhost");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("BLOCKED_URL");
  });

  test("blocks localhost.localdomain", () => {
    const err = checkHostnameBlocked("localhost.localdomain");
    expect(err).not.toBeNull();
  });

  test("blocks metadata.google.internal", () => {
    const err = checkHostnameBlocked("metadata.google.internal");
    expect(err).not.toBeNull();
  });

  test("blocks trailing-dot variants", () => {
    expect(checkHostnameBlocked("localhost.")).not.toBeNull();
    expect(checkHostnameBlocked("metadata.google.internal.")).not.toBeNull();
  });

  test("allows normal hostnames", () => {
    expect(checkHostnameBlocked("example.com")).toBeNull();
    expect(checkHostnameBlocked("api.github.com")).toBeNull();
    expect(checkHostnameBlocked("www.example.com")).toBeNull();
  });
});

describe("validateResolvedIps", () => {
  test("allows public IPv4", () => {
    const err = validateResolvedIps(["8.8.8.8", "1.1.1.1"], []);
    expect(err).toBeNull();
  });

  test("allows public IPv6", () => {
    const err = validateResolvedIps([], ["2001:4860:4860::8888", "2001:db8::1"]);
    expect(err).toBeNull();
  });

  test("blocks RFC1918 IPv4", () => {
    expect(validateResolvedIps(["10.0.0.1"], [])).not.toBeNull();
    expect(validateResolvedIps(["172.16.0.1"], [])).not.toBeNull();
    expect(validateResolvedIps(["192.168.1.1"], [])).not.toBeNull();
  });

  test("blocks loopback IPv4", () => {
    expect(validateResolvedIps(["127.0.0.1"], [])).not.toBeNull();
    expect(validateResolvedIps(["127.255.255.255"], [])).not.toBeNull();
  });

  test("blocks link-local IPv4", () => {
    expect(validateResolvedIps(["169.254.1.1"], [])).not.toBeNull();
  });

  test("blocks cloud metadata IPv4", () => {
    expect(validateResolvedIps(["169.254.169.254"], [])).not.toBeNull();
  });

  test("blocks IPv6 loopback", () => {
    expect(validateResolvedIps([], ["::1"])).not.toBeNull();
  });

  test("blocks IPv6 link-local", () => {
    expect(validateResolvedIps([], ["fe80::1"])).not.toBeNull();
  });

  test("blocks IPv6 ULA", () => {
    expect(validateResolvedIps([], ["fd00::1"])).not.toBeNull();
  });

  test("blocks IPv4-mapped IPv6 (compressed)", () => {
    expect(validateResolvedIps([], ["::ffff:127.0.0.1"])).not.toBeNull();
    expect(validateResolvedIps([], ["::ffff:10.0.0.1"])).not.toBeNull();
    expect(validateResolvedIps([], ["::ffff:169.254.169.254"])).not.toBeNull();
  });

  test("allows IPv4-mapped public IPv6", () => {
    expect(validateResolvedIps([], ["::ffff:8.8.8.8"])).toBeNull();
  });

  test("returns first blocked IP found", () => {
    const err = validateResolvedIps(["8.8.8.8", "10.0.0.1"], []);
    expect(err).not.toBeNull();
    expect(err?.details.ip).toBe("10.0.0.1");
  });
});

describe("canReuseResolution", () => {
  test("returns true for same hostname", () => {
    expect(canReuseResolution("example.com", "example.com")).toBe(true);
    expect(canReuseResolution("EXAMPLE.COM", "example.com")).toBe(true);
  });

  test("returns true for same hostname with trailing dots", () => {
    expect(canReuseResolution("example.com", "example.com.")).toBe(true);
    expect(canReuseResolution("example.com.", "example.com")).toBe(true);
  });

  test("returns false for different hostnames", () => {
    expect(canReuseResolution("example.com", "api.example.com")).toBe(false);
    expect(canReuseResolution("example.com", "evil.com")).toBe(false);
  });

  test("returns false for subdomain changes", () => {
    expect(canReuseResolution("example.com", "www.example.com")).toBe(false);
    expect(canReuseResolution("www.example.com", "example.com")).toBe(false);
  });
});