/**
 * Tests for Phase 5 Acquisition Errors
 */

import {
  AcquisitionError,
  isAcquisitionError,
  createTimeoutError,
  createResponseTooLargeError,
  createRedirectLimitError,
  createUnsupportedContentTypeError,
  createHttpFailureError,
  createBlockedUrlError,
  createBlockedResolvedIpError,
  createDnsResolutionFailedError,
  createUnsafeRedirectError,
  createMalformedResponseError,
} from "../errors";

describe("AcquisitionError", () => {
  test("creates error with code and details", () => {
    const err = new AcquisitionError("TIMEOUT", { url: "http://example.com", timeoutMs: 5000 });
    expect(err.code).toBe("TIMEOUT");
    expect(err.details.url).toBe("http://example.com");
    expect(err.details.timeoutMs).toBe(5000);
    expect(err.message).toContain("[TIMEOUT]");
    expect(err.message).toContain('url="http://example.com"');
    // timeoutMs is in details but may not be in formatted message
    expect(err.details.timeoutMs).toBe(5000);
  });

  test("identifies security errors correctly", () => {
    const blockedUrl = new AcquisitionError("BLOCKED_URL", {});
    const blockedIp = new AcquisitionError("BLOCKED_RESOLVED_IP", {});
    const unsafeRedirect = new AcquisitionError("UNSAFE_REDIRECT", {});
    const timeout = new AcquisitionError("TIMEOUT", {});

    expect(blockedUrl.isSecurityError).toBe(true);
    expect(blockedIp.isSecurityError).toBe(true);
    expect(unsafeRedirect.isSecurityError).toBe(true);
    expect(timeout.isSecurityError).toBe(false);
  });

  test("formats messages with all details", () => {
    const err = new AcquisitionError("REDIRECT_LIMIT_EXCEEDED", {
      url: "http://example.com",
      redirectCount: 6,
      maxRedirects: 5,
    });
    expect(err.message).toContain("redirects=6/5");
  });
});

describe("Error factory functions", () => {
  test("createTimeoutError", () => {
    const err = createTimeoutError("http://example.com", 10000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.details.url).toBe("http://example.com");
    expect(err.details.timeoutMs).toBe(10000);
  });

  test("createResponseTooLargeError", () => {
    const err = createResponseTooLargeError("http://example.com", 6000000, 5000000);
    expect(err.code).toBe("RESPONSE_TOO_LARGE");
    expect(err.details.receivedBytes).toBe(6000000);
    expect(err.details.limitBytes).toBe(5000000);
  });

  test("createRedirectLimitError", () => {
    const err = createRedirectLimitError("http://example.com", 6, 5);
    expect(err.code).toBe("REDIRECT_LIMIT_EXCEEDED");
    expect(err.details.redirectCount).toBe(6);
    expect(err.details.maxRedirects).toBe(5);
  });

  test("createUnsupportedContentTypeError", () => {
    const err = createUnsupportedContentTypeError("http://example.com", "application/pdf");
    expect(err.code).toBe("UNSUPPORTED_CONTENT_TYPE");
    expect(err.details.contentType).toBe("application/pdf");
  });

  test("createHttpFailureError", () => {
    const err = createHttpFailureError("http://example.com", 404);
    expect(err.code).toBe("HTTP_FAILURE");
    expect(err.details.statusCode).toBe(404);
  });

  test("createBlockedUrlError", () => {
    const err = createBlockedUrlError("http://localhost/", "SSRF");
    expect(err.code).toBe("BLOCKED_URL");
    expect(err.details.reason).toBe("SSRF");
  });

  test("createBlockedResolvedIpError", () => {
    const err = createBlockedResolvedIpError("http://example.com", "10.0.0.1");
    expect(err.code).toBe("BLOCKED_RESOLVED_IP");
    expect(err.details.ip).toBe("10.0.0.1");
  });

  test("createDnsResolutionFailedError", () => {
    const err = createDnsResolutionFailedError("example.com", "NXDOMAIN");
    expect(err.code).toBe("DNS_RESOLUTION_FAILED");
    expect(err.details.hostname).toBe("example.com");
    expect(err.details.reason).toBe("NXDOMAIN");
  });

  test("createUnsafeRedirectError", () => {
    const err = createUnsafeRedirectError("http://evil.com", "blocked IP");
    expect(err.code).toBe("UNSAFE_REDIRECT");
    expect(err.details.reason).toBe("blocked IP");
  });

  test("createMalformedResponseError", () => {
    const err = createMalformedResponseError("http://example.com", "invalid encoding");
    expect(err.code).toBe("MALFORMED_RESPONSE");
    expect(err.details.reason).toBe("invalid encoding");
  });
});

describe("isAcquisitionError type guard", () => {
  test("returns true for AcquisitionError", () => {
    expect(isAcquisitionError(new AcquisitionError("TIMEOUT", {}))).toBe(true);
  });

  test("returns false for regular Error", () => {
    expect(isAcquisitionError(new Error("regular"))).toBe(false);
  });

  test("returns false for other objects", () => {
    expect(isAcquisitionError({ code: "TIMEOUT" })).toBe(false);
    expect(isAcquisitionError(null)).toBe(false);
    expect(isAcquisitionError(undefined)).toBe(false);
    expect(isAcquisitionError("string")).toBe(false);
  });
});