/**
 * Phase 5 HTTP Acquisition with Hard Bounds
 * Enforces timeout, size limits, redirect limits, content-type restrictions.
 * Uses native fetch with manual redirect handling.
 */

import { validateUrl, canonicalizeUrl, CanonicalUrl } from "@/lib/deterministic/url";
import { sha256 } from "@/lib/deterministic/hash";
import {
  createTimeoutError,
  createResponseTooLargeError,
  createRedirectLimitError,
  createUnsupportedContentTypeError,
  createHttpFailureError,
  createUnsafeRedirectError,
  createMalformedResponseError,
  createBlockedUrlError,
  AcquisitionError,
  isAcquisitionError,
} from "./errors";
import { resolveAndValidate, ResolvedHost } from "./dns";
import type { AcquisitionOptions, AcquiredPage, RedirectHop } from "./types";
import { DEFAULT_ACQUISITION_OPTIONS } from "./types";
export { DEFAULT_ACQUISITION_OPTIONS } from "./types";

/** Safe header keys to preserve */
const SAFE_HEADER_KEYS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "charset",
  "last-modified",
  "etag",
  "cache-control",
  "expires",
]);

/** Parse Content-Type header into media type and charset */
export function parseContentType(header: string | null): { mediaType: string; charset: string } {
  if (!header) return { mediaType: "application/octet-stream", charset: "utf-8" };
  const parts = header.split(";").map((p) => p.trim().toLowerCase());
  const mediaType = parts[0] || "application/octet-stream";
  let charset = "utf-8";
  for (const part of parts.slice(1)) {
    if (part.startsWith("charset=")) {
      charset = part.slice(8).replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { mediaType, charset };
}

/** Check if content type is allowed */
export function isContentTypeAllowed(mediaType: string, allowedTypes: string[]): boolean {
  return allowedTypes.some((t) => mediaType === t || mediaType.startsWith(t + ";"));
}

/** Read response body with hard size limit (stream-based, works with chunked encoding) */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  charset: string
): Promise<string> {
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder(charset, { fatal: false });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        throw createResponseTooLargeError("", totalBytes, maxBytes);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Combine chunks and decode
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return decoder.decode(combined);
}

/** Validate and canonicalize a redirect URL */
export function validateRedirectUrl(
  location: string,
  currentUrl: string,
  currentResolved: ResolvedHost,
  options: Required<AcquisitionOptions>
): { canonical: CanonicalUrl } | AcquisitionError {
  // Parse the redirect location (may be relative)
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(location, currentUrl).toString();
  } catch {
    return createUnsafeRedirectError(location, "Invalid redirect URL");
  }

  // Canonicalize
  const canonical = canonicalizeUrl(absoluteUrl);
  if (!canonical) {
    return createUnsafeRedirectError(absoluteUrl, "Redirect URL canonicalization failed");
  }

  // Validate URL structure - skip hostname blocklist if pre-resolved IPs were provided
  // (caller will re-resolve and re-validate regardless)
  const skipHostBlocklist = options.preResolvedIps !== undefined;
  const validation = validateUrl(canonical.url, skipHostBlocklist ? { skipHostnameBlocklist: true } : undefined);
  if (!validation.valid) {
    return createUnsafeRedirectError(canonical.url, validation.reason || "Redirect URL validation failed");
  }

  return { canonical };
}

/**
 * Main acquisition function with all bounds enforced.
 * Uses manual redirect handling for security.
 */
export async function acquireUrl(
  url: string,
  options: AcquisitionOptions = {}
): Promise<AcquiredPage> {
  const opts = { ...DEFAULT_ACQUISITION_OPTIONS, ...options } as Required<AcquisitionOptions> & { preResolvedIps?: { ipv4: string[]; ipv6: string[] } };
  const redirectChain: RedirectHop[] = [];
  let currentUrl = url;
  let currentResolved: ResolvedHost | null = null;
  let redirectCount = 0;

  // Initial URL validation
  // If preResolvedIps provided, skip hostname blocklist check (caller vouches for IP safety)
  const initialValidation = validateUrl(currentUrl, opts.preResolvedIps
    ? { resolvedIps: opts.preResolvedIps, skipHostnameBlocklist: true }
    : undefined);
  if (!initialValidation.valid) {
    throw createBlockedUrlError(currentUrl, initialValidation.reason || "Invalid URL");
  }

  // Initial DNS resolution (if not pre-resolved)
  if (opts.preResolvedIps) {
    currentResolved = {
      hostname: initialValidation.canonical!.parsed.hostname,
      ipv4: opts.preResolvedIps.ipv4,
      ipv6: opts.preResolvedIps.ipv6,
      valid: true,
    };
  } else {
    currentResolved = await resolveAndValidate(initialValidation.canonical!.parsed.hostname);
    if (!currentResolved.valid) {
      throw currentResolved.error!;
    }
  }

  // Acquisition loop with redirect handling
  while (true) {
    // Check redirect limit
    if (redirectCount >= opts.maxRedirects) {
      throw createRedirectLimitError(currentUrl, redirectCount, opts.maxRedirects);
    }

    // Prepare fetch options
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

    const fetchOptions: RequestInit = {
      method: "GET",
      headers: {
        "User-Agent": opts.userAgent,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "manual" as RequestRedirect, // We handle redirects manually
    };

    let response: Response;
    try {
      response = await fetch(currentUrl, fetchOptions);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw createTimeoutError(currentUrl, opts.timeoutMs);
      }
      if (isAcquisitionError(err)) throw err;
      throw createMalformedResponseError(currentUrl, `Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    clearTimeout(timeoutId);

    const statusCode = response.status;
    const headers = Object.fromEntries(
      Array.from(response.headers.entries())
        .filter(([k]) => SAFE_HEADER_KEYS.has(k.toLowerCase()))
        .map(([k, v]) => [k.toLowerCase(), v])
    );

    // Handle redirects manually
    if ([301, 302, 303, 307, 308].includes(statusCode) && opts.followRedirects) {
      const location = response.headers.get("location");
      if (!location) {
        // No location header - treat as final response
      } else {
        redirectCount++;

        // Validate redirect
        const redirectValidation = validateRedirectUrl(location, currentUrl, currentResolved!, opts);
        if (isAcquisitionError(redirectValidation)) {
          redirectChain.push({
            url: location,
            canonicalUrl: { url: "", parsed: new URL("about:blank"), original: location },
            statusCode,
            validated: false,
            blockedReason: redirectValidation.message,
          });
          throw redirectValidation;
        }

        const { canonical } = redirectValidation;

        // Re-resolve and re-validate DNS for EVERY redirect hop.
        // This mitigates DNS rebinding where the same hostname resolves to
        // different IPs between validation and connection.
        // Note: A TOCTOU window still exists between resolveAndValidate() and fetch();
        // fully eliminating it would require a custom HTTP client that binds to a validated IP.
        const newResolved = await resolveAndValidate(canonical.parsed.hostname);
        if (!newResolved.valid) {
          redirectChain.push({
            url: canonical.url,
            canonicalUrl: canonical,
            statusCode,
            validated: false,
            blockedReason: newResolved.error?.message,
          });
          throw newResolved.error!;
        }
        currentResolved = newResolved;

        // Record successful redirect hop
        redirectChain.push({
          url: canonical.url,
          canonicalUrl: canonical,
          statusCode,
          validated: true,
        });

        // Continue to next hop
        currentUrl = canonical.url;
        continue;
      }
    }

    // Not a redirect or not following redirects - process final response
    if (statusCode >= 400) {
      throw createHttpFailureError(currentUrl, statusCode);
    }

    // Check content type
    const contentTypeHeader = response.headers.get("content-type") || "";
    const { mediaType, charset } = parseContentType(contentTypeHeader);

    if (!isContentTypeAllowed(mediaType, opts.allowedContentTypes)) {
      throw createUnsupportedContentTypeError(currentUrl, mediaType);
    }

    // Read body with size enforcement
    const body = await readBodyWithLimit(response.body, opts.maxResponseSize, charset);

    // Compute content hash
    const contentHash = sha256(body);

    // Build acquired page
    const acquiredPage: AcquiredPage = {
      finalUrl: currentUrl,
      canonicalUrl: canonicalizeUrl(currentUrl)!,
      statusCode,
      headers,
      body,
      contentType: mediaType,
      charset,
      contentHash,
      acquiredAt: new Date().toISOString(),
      redirectChain,
      resolvedIps: { ipv4: currentResolved!.ipv4, ipv6: currentResolved!.ipv6 },
    };

    return acquiredPage;
  }
}