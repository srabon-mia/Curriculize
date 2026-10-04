/**
 * Phase 5 Acquisition Types
 * Public contracts for the acquisition engine.
 * Reuses Phase 4 deterministic types where applicable.
 */

import { CanonicalUrl, UrlValidationResult } from "@/lib/deterministic/url";

export type { CanonicalUrl } from "@/lib/deterministic/url";

/** Result of a single redirect hop validation */
export interface RedirectHop {
  /** The redirect URL (before canonicalization) */
  url: string;
  /** Canonicalized redirect URL */
  canonicalUrl: CanonicalUrl;
  /** HTTP status code of the redirect */
  statusCode: number;
  /** Whether this hop passed all validation */
  validated: boolean;
  /** If not validated, the reason */
  blockedReason?: string;
}

/** Raw acquired page before cleaning */
export interface AcquiredPage {
  /** Final URL after all redirects (canonicalized) */
  finalUrl: string;
  /** Canonical URL from Phase 4 */
  canonicalUrl: CanonicalUrl;
  /** HTTP status code of final response */
  statusCode: number;
  /** Response headers (lowercased keys, safe subset) */
  headers: Record<string, string>;
  /** Response body as UTF-8 string (size-enforced) */
  body: string;
  /** Parsed Content-Type media type (e.g., "text/html") */
  contentType: string;
  /** Charset from Content-Type or detected */
  charset: string;
  /** SHA-256 hash of body */
  contentHash: string;
  /** ISO timestamp of acquisition */
  acquiredAt: string;
  /** All redirect hops with validation results */
  redirectChain: RedirectHop[];
  /** Resolved IPs used for the final connection */
  resolvedIps: { ipv4: string[]; ipv6: string[] };
}

/** Cleaned page ready for later extraction phases */
export interface CleanedPage {
  /** Source acquisition reference */
  acquiredPage: AcquiredPage;
  /** Cleaned text content */
  text: string;
  /** Extracted <title> */
  title: string;
  /** Extracted meta description */
  description: string | null;
  /** Word count of cleaned text */
  wordCount: number;
  /** SHA-256 hash of cleaned text for deduplication */
  cleanedHash: string;
}

/** Options controlling acquisition behavior */
export interface AcquisitionOptions {
  /** Maximum redirects to follow (default: 5) */
  maxRedirects?: number;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default: 5MB) */
  maxResponseSize?: number;
  /** Allowed content types (default: text/html, text/plain, application/xhtml+xml) */
  allowedContentTypes?: string[];
  /** User-Agent string (default: curriculum-generator/0.1) */
  userAgent?: string;
  /** Whether to follow redirects (default: true) */
  followRedirects?: boolean;
  /** Pre-resolved IPs to use (for testing or pinning) */
  preResolvedIps?: { ipv4: string[]; ipv6: string[] };
}

/** Default acquisition options */
export const DEFAULT_ACQUISITION_OPTIONS: Omit<Required<AcquisitionOptions>, "preResolvedIps"> & { preResolvedIps: { ipv4: string[]; ipv6: string[] } | undefined } = {
  maxRedirects: 5,
  timeoutMs: 10_000,
  maxResponseSize: 5 * 1024 * 1024,
  allowedContentTypes: ["text/html", "text/plain", "application/xhtml+xml"],
  userAgent: "curriculum-generator/0.1",
  followRedirects: true,
  preResolvedIps: undefined,
};

/** Discovery candidate from earlier pipeline stages */
export interface DiscoveryCandidate {
  /** The candidate URL */
  url: string;
  /** Optional title from discovery */
  title?: string;
  /** Optional source domain */
  sourceDomain?: string;
  /** Optional resource type hint */
  resourceType?: string;
  /** Optional AI note from discovery */
  aiNote?: string;
}

/** Result of acquisition for a candidate */
export interface AcquisitionResult {
  /** The original candidate */
  candidate: DiscoveryCandidate;
  /** Whether acquisition succeeded */
  success: boolean;
  /** Acquired page if successful */
  acquiredPage?: AcquiredPage;
  /** Cleaned page if successful */
  cleanedPage?: CleanedPage;
  /** Structured content from Phase 6A extraction */
  structuredContent?: import("./structuredExtract").StructuredContent;
  /** Error if failed */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}