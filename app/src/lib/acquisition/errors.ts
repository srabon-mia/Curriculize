/**
 * Phase 5 Acquisition Errors
 * Deterministic error codes for acquisition failures.
 * No AI, no external dependencies.
 */

export type AcquisitionErrorCode =
  | "INVALID_URL"
  | "BLOCKED_URL"
  | "DNS_RESOLUTION_FAILED"
  | "BLOCKED_RESOLVED_IP"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "UNSAFE_REDIRECT"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "HTTP_FAILURE"
  | "MALFORMED_RESPONSE"
  | "ACQUISITION_FAILED";

export interface AcquisitionErrorDetails {
  url?: string;
  hostname?: string;
  ip?: string;
  statusCode?: number;
  contentType?: string;
  receivedBytes?: number;
  limitBytes?: number;
  redirectCount?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  reason?: string;
  [key: string]: unknown;
}

export class AcquisitionError extends Error {
  public readonly code: AcquisitionErrorCode;
  public readonly details: AcquisitionErrorDetails;
  public readonly isSecurityError: boolean;

  constructor(code: AcquisitionErrorCode, details: AcquisitionErrorDetails = {}) {
    const message = AcquisitionError.formatMessage(code, details);
    super(message);
    this.name = "AcquisitionError";
    this.code = code;
    this.details = details;
    this.isSecurityError = AcquisitionError.isSecurityCode(code);
  }

  private static isSecurityCode(code: AcquisitionErrorCode): boolean {
    return [
      "BLOCKED_URL",
      "BLOCKED_RESOLVED_IP",
      "UNSAFE_REDIRECT",
    ].includes(code);
  }

  private static formatMessage(code: AcquisitionErrorCode, details: AcquisitionErrorDetails): string {
    const parts = [`[${code}]`];
    if (details.url) parts.push(`url="${details.url}"`);
    if (details.hostname) parts.push(`hostname="${details.hostname}"`);
    if (details.ip) parts.push(`ip="${details.ip}"`);
    if (details.statusCode) parts.push(`status=${details.statusCode}`);
    if (details.redirectCount !== undefined) parts.push(`redirects=${details.redirectCount}/${details.maxRedirects}`);
    if (details.receivedBytes !== undefined && details.limitBytes !== undefined) {
      parts.push(`size=${details.receivedBytes}/${details.limitBytes}`);
    }
    if (details.reason) parts.push(`reason="${details.reason}"`);
    return parts.join(" ");
  }
}

/** Type guard for AcquisitionError */
export function isAcquisitionError(error: unknown): error is AcquisitionError {
  return error instanceof AcquisitionError;
}

/** Create a timeout error */
export function createTimeoutError(url: string, timeoutMs: number): AcquisitionError {
  return new AcquisitionError("TIMEOUT", { url, timeoutMs });
}

/** Create a response-too-large error */
export function createResponseTooLargeError(url: string, received: number, limit: number): AcquisitionError {
  return new AcquisitionError("RESPONSE_TOO_LARGE", { url, receivedBytes: received, limitBytes: limit });
}

/** Create a redirect limit error */
export function createRedirectLimitError(url: string, count: number, max: number): AcquisitionError {
  return new AcquisitionError("REDIRECT_LIMIT_EXCEEDED", { url, redirectCount: count, maxRedirects: max });
}

/** Create an unsupported content type error */
export function createUnsupportedContentTypeError(url: string, contentType: string): AcquisitionError {
  return new AcquisitionError("UNSUPPORTED_CONTENT_TYPE", { url, contentType });
}

/** Create an HTTP failure error */
export function createHttpFailureError(url: string, statusCode: number): AcquisitionError {
  return new AcquisitionError("HTTP_FAILURE", { url, statusCode });
}

/** Create a blocked URL error */
export function createBlockedUrlError(url: string, reason: string): AcquisitionError {
  return new AcquisitionError("BLOCKED_URL", { url, reason });
}

/** Create a blocked resolved IP error */
export function createBlockedResolvedIpError(url: string, ip: string): AcquisitionError {
  return new AcquisitionError("BLOCKED_RESOLVED_IP", { url, ip });
}

/** Create a DNS resolution failure error */
export function createDnsResolutionFailedError(hostname: string, reason: string): AcquisitionError {
  return new AcquisitionError("DNS_RESOLUTION_FAILED", { hostname, reason });
}

/** Create an unsafe redirect error */
export function createUnsafeRedirectError(url: string, reason: string): AcquisitionError {
  return new AcquisitionError("UNSAFE_REDIRECT", { url, reason });
}

/** Create a malformed response error */
export function createMalformedResponseError(url: string, reason: string): AcquisitionError {
  return new AcquisitionError("MALFORMED_RESPONSE", { url, reason });
}