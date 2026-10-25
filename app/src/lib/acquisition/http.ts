/**
 * Phase 5 HTTP Acquisition with Hard Bounds
 * Enforces timeout, size limits, redirect limits, content-type restrictions.
 * Uses undici with IP pinning to eliminate DNS rebinding TOCTOU.
 */

import { validateUrl, canonicalizeUrl, CanonicalUrl, isIpBlocked } from "@/lib/deterministic/url";
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

// Use undici (Node.js built-in) for connection-level IP pinning
// This eliminates the DNS rebinding TOCTOU window by connecting directly
// to the validated IP while preserving TLS SNI and HTTP Host header.
import { request as undiciRequest } from "undici";
import { Agent } from "undici";

/**
 * Validates that all IPs in preResolvedIps pass SSRF blocklist checks.
 * Throws if any IP is blocked.
 * Exported for use by callers and tests.
 */
export function validatePreResolvedIps(preResolvedIps: { ipv4: string[]; ipv6: string[] }): void {
  const allIps = [...preResolvedIps.ipv4, ...preResolvedIps.ipv6];
  for (const ip of allIps) {
    if (isIpBlocked(ip)) {
      throw createBlockedUrlError("", `preResolvedIps contains blocked IP: ${ip}`);
    }
  }
}

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
  "location",
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

/**
 * Perform HTTP request with IP pinning using undici.
 * Creates a custom Agent that connects directly to the validated IP
 * while preserving the original hostname for TLS SNI and HTTP Host header.
 * This eliminates the DNS rebinding TOCTOU window between validation and connection.
 */
async function fetchWithPinnedIp(
  url: string,
  validatedIp: string,
  options: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
    maxResponseSize: number;
  }
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}> {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === "https:";
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);
  const hostname = parsedUrl.hostname;

  // Create undici Agent with connection-level IP pinning.
  // The `connect` option specifies the exact IP to connect to,
  // while the request URL provides the hostname for TLS SNI and Host header.
  const agent = new Agent({
    connections: 1,
    pipelining: 0,
    // Disable keep-alive to ensure fresh connection per request
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connect: {
      host: validatedIp,
      port,
      // For HTTPS, ensure TLS uses the original hostname for SNI
      servername: hostname,
    },
  });

  try {
    const response = await undiciRequest(url, {
      method: options.method,
      headers: {
        ...options.headers,
        // Ensure Host header matches the original hostname for virtual hosting
        host: hostname,
      },
      signal: options.signal,
      // Use our agent with IP pinning.
      // When a custom dispatcher (Agent) is provided, undici does not
      // automatically add the RedirectHandler, so redirects are not followed.
      dispatcher: agent,
      bodyTimeout: options.timeoutMs,
      headersTimeout: options.timeoutMs,
    });

    // Convert undici headers to our format
    const headers: Record<string, string> = {};
    if (response.headers) {
      for (const key of Object.keys(response.headers)) {
        const value = response.headers[key];
        if (value && SAFE_HEADER_KEYS.has(key.toLowerCase())) {
          // Headers can be string or string[]; take the first value
          headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
      }
    }

    // Read body using undici's bytes() method and enforce size limit
    let bodyStream: ReadableStream<Uint8Array> | null = null;
    if (response.body) {
      const bodyBytes = await response.body.bytes();
      if (bodyBytes.length > options.maxResponseSize) {
        throw createResponseTooLargeError(url, bodyBytes.length, options.maxResponseSize);
      }
      // Create a ReadableStream from the bytes for compatibility with readBodyWithLimit
      bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bodyBytes);
          controller.close();
        },
      });
    }

    return {
      statusCode: response.statusCode,
      headers,
      body: bodyStream,
    };
  } finally {
    // Close the agent to clean up connections
    await agent.close().catch(() => {});
  }
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

  // Validate URL structure - skip hostname blocklist and resolved IPs check if pre-resolved IPs were provided
  // (caller will re-resolve and re-validate regardless)
  const skipHostBlocklist = options.preResolvedIps !== undefined;
  const validation = validateUrl(canonical.url, skipHostBlocklist
    ? { resolvedIps: options.preResolvedIps, skipHostnameBlocklist: true }
    : undefined);
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

  // Validate preResolvedIps against SSRF blocklist before use
  if (opts.preResolvedIps) {
    validatePreResolvedIps(opts.preResolvedIps);
  }

  // Initial URL validation
  // If preResolvedIps provided, skip hostname blocklist and resolved IPs check
  // (validation already performed above)
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
    currentResolved = await resolveAndValidate(initialValidation.canonical!.parsed.hostname, opts.signal);
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

    // Select the validated IP to pin the connection to
    // Prefer IPv6, fallback to IPv4 (matching Happy Eyeballs)
    const validatedIp = currentResolved!.ipv6.length > 0
      ? currentResolved!.ipv6[0]
      : currentResolved!.ipv4[0];

    if (!validatedIp) {
      throw createMalformedResponseError(currentUrl, "No validated IP available for connection");
    }

    // Prepare request options for pinned IP fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
    const abortWithInvocation = () => controller.abort();
    opts.signal?.addEventListener('abort', abortWithInvocation, { once: true });
    if (opts.signal?.aborted) controller.abort();

    let response;
    try {
      response = await fetchWithPinnedIp(currentUrl, validatedIp, {
        method: "GET",
        headers: {
          "User-Agent": opts.userAgent,
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal,
        timeoutMs: opts.timeoutMs,
        maxResponseSize: opts.maxResponseSize,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', abortWithInvocation);
      if (err instanceof DOMException && err.name === "AbortError") {
        if (opts.signal?.aborted) throw err;
        throw createTimeoutError(currentUrl, opts.timeoutMs);
      }
      if (isAcquisitionError(err)) throw err;
      throw createMalformedResponseError(currentUrl, `Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    clearTimeout(timeoutId);
    opts.signal?.removeEventListener('abort', abortWithInvocation);

    const statusCode = response.statusCode;
    const headers = response.headers;

    // Handle redirects manually
    if ([301, 302, 303, 307, 308].includes(statusCode) && opts.followRedirects) {
      const location = headers["location"];
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

        // Check if this is a same-host redirect where we can reuse the validated resolution.
        // This preserves the preResolvedIps optimization for same-host redirects.
        const isSameHost = currentResolved!.hostname === canonical.parsed.hostname;

        let newResolved: ResolvedHost;
        if (isSameHost) {
          // Same host - reuse the validated resolution (including preResolvedIps)
          newResolved = currentResolved!;
        } else {
          // Different host - re-resolve and re-validate DNS
          newResolved = await resolveAndValidate(canonical.parsed.hostname, opts.signal);
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
    const contentTypeHeader = headers["content-type"] || "";
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
