/**
 * URL canonicalization, validation, and SSRF protection utilities.
 * All functions are pure and deterministic — no network I/O, no AI calls.
 */

import { URL } from "url";

/**
 * Normalized URL representation after canonicalization.
 */
export interface CanonicalUrl {
  /** The canonical URL string (normalized, lowercased host, no default ports, sorted query params) */
  url: string;
  /** The parsed URL object for further inspection */
  parsed: URL;
  /** The original input URL string */
  original: string;
}

/**
 * Result of URL validation.
 */
export interface UrlValidationResult {
  /** Whether the URL passed all validation checks */
  valid: boolean;
  /** The canonical URL if valid */
  canonical?: CanonicalUrl;
  /** Human-readable reason if invalid */
  reason?: string;
  /** Specific validation failures for debugging */
  failures?: string[];
}

/**
 * SSRF blocklist — destinations that must never be fetched.
 * Includes localhost, loopback, private RFC1918 ranges, link-local, and cloud metadata endpoints.
 */
const SSRF_BLOCKLIST_CIDRS: string[] = [
  // Loopback
  "127.0.0.0/8",
  "::1/128",
  // Private RFC1918
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // Link-local
  "169.254.0.0/16",
  "fe80::/10",
  // Cloud metadata endpoints (common)
  "169.254.169.254/32",     // AWS, GCE, Azure, DigitalOcean
  "fd00::/8",                // ULA (unique local addresses)
];

/**
 * Hostnames that are always blocked (exact match, case-insensitive).
 */
const SSRF_BLOCKLIST_HOSTNAMES = new Set<string>([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "169.254.169.254",
  "[::1]",
  "[fe80::1]",
]);

/**
 * Schemes allowed for acquisition. Only HTTP and HTTPS are permitted.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Maximum number of redirects to follow (configurable via env or default).
 */
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Default request timeout in milliseconds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Default maximum response body size in bytes (5 MB).
 */
export const DEFAULT_MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

/**
 * Parse an IPv4 CIDR and return [networkAddress, maskLength].
 * Returns null if invalid.
 */
function parseCidr(cidr: string): [number, number] | null {
  const match = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return null;
  const ip = match[1].split(".").map(Number);
  if (ip.some((octet) => octet < 0 || octet > 255)) return null;
  const prefix = parseInt(match[2], 10);
  if (prefix < 0 || prefix > 32) return null;
  const addr = (ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3];
  return [addr >>> 0, prefix];
}

/**
 * Parse an IPv6 CIDR and return [Uint8Array(16), prefixLength].
 * Returns null if invalid or if the CIDR is not an IPv6 CIDR.
 */
function parseCidr6(cidr: string): [Uint8Array, number] | null {
  // Find the last "/" to separate IP from prefix
  const lastSlash = cidr.lastIndexOf("/");
  if (lastSlash === -1) return null;
  const ipPart = cidr.slice(0, lastSlash);
  const prefixStr = cidr.slice(lastSlash + 1);
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 128) return null;
  // Quick check: if ipPart contains ".", it's IPv4, not IPv6
  if (ipPart.includes(".")) return null;
  const expanded = expandIPv6(ipPart);
  if (!expanded) return null;
  return [expanded, prefix];
}

/**
 * Expand a compressed IPv6 address to 16-byte Uint8Array.
 * Returns null if invalid.
 */
function expandIPv6(addr: string): Uint8Array | null {
  try {
    const parts = addr.split(":");
    // Find the :: run - consecutive empty parts represent a single ::
    let firstEmpty = -1;
    let lastEmpty = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "") {
        if (firstEmpty === -1) firstEmpty = i;
        lastEmpty = i;
      }
    }
    const hasDoubleColon = firstEmpty !== -1;
    const doubleColonStart = firstEmpty;
    const doubleColonEnd = lastEmpty;

    const result = new Uint8Array(16);
    let resultIndex = 0;
    const processPart = (part: string): boolean => {
      if (part === "") return true;
      const val = parseInt(part, 16);
      if (isNaN(val) || val > 0xffff) return false;
      if (resultIndex >= 16) return false;
      result[resultIndex++] = (val >> 8) & 0xff;
      result[resultIndex++] = val & 0xff;
      return true;
    };
    if (hasDoubleColon) {
      // Process parts before ::
      for (let i = 0; i < doubleColonStart; i++) {
        if (!processPart(parts[i])) return null;
      }
      // Count non-empty parts after :: (these are real groups)
      let groupsAfter = 0;
      for (let i = doubleColonEnd + 1; i < parts.length; i++) {
        if (parts[i] !== "") groupsAfter++;
      }
      const groupsBefore = resultIndex / 2;
      const zeroGroups = 8 - groupsBefore - groupsAfter;
      if (zeroGroups < 1) return null; // :: must represent at least 1 group
      resultIndex += zeroGroups * 2;
      // Process parts after ::
      for (let i = doubleColonEnd + 1; i < parts.length; i++) {
        if (!processPart(parts[i])) return null;
      }
    } else {
      if (parts.length !== 8) return null;
      for (const part of parts) {
        if (!processPart(part)) return null;
      }
    }
    if (resultIndex !== 16) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Check if an IPv4 address (as 32-bit unsigned int) is in a CIDR range.
 */
function ipv4InCidr(ip: number, cidr: [number, number]): boolean {
  const [network, prefix] = cidr;
  if (prefix === 0) return true;
  const mask = 0xffffffff << (32 - prefix);
  return (ip & mask) === (network & mask);
}

/**
 * Check if an IPv6 address (as Uint8Array[16]) is in a CIDR range.
 */
function ipv6InCidr(ip: Uint8Array, cidr: [Uint8Array, number]): boolean {
  const [network, prefix] = cidr;
  const fullBytes = prefix >> 3;
  const remainingBits = prefix & 7;
  for (let i = 0; i < fullBytes; i++) {
    if (ip[i] !== network[i]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((ip[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
  }
  return true;
}

/**
 * Resolve a hostname to IP addresses (IPv4 and IPv6).
 * This is a pure DNS lookup — no HTTP request is made.
 * In production, this would use `dns.promises.lookup` or similar.
 * For the deterministic utilities, we provide the interface;
 * the actual resolution happens in the acquisition layer.
 */
export async function resolveHostname(_hostname: string): Promise<{
  ipv4: string[];
  ipv6: string[];
}> {
  // This is a stub — actual resolution uses Node's dns module in the acquisition layer.
  // The deterministic utilities expose the interface; implementation is in browser.ts.
  return { ipv4: [], ipv6: [] };
}

/**
 * Check if an IP address (string) is in the SSRF blocklist.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 formats.
 */
export function isIpBlocked(ip: string): boolean {
  const cleanIp = ip.replace(/^\[/, "").replace(/\]$/, "");
  // IPv4 (no colons)
  if (cleanIp.includes(".") && !cleanIp.includes(":")) {
    const parts = cleanIp.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
      const addr = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
      for (const cidr of SSRF_BLOCKLIST_CIDRS) {
        const parsed = parseCidr(cidr);
        if (parsed && ipv4InCidr(addr >>> 0, parsed)) return true;
      }
    }
    return false;
  }
  // IPv4-mapped IPv6 (contains both : and .) — compressed form like ::ffff:127.0.0.1
  if (cleanIp.includes(":") && cleanIp.includes(".")) {
    // Extract the last 32 bits (the embedded IPv4)
    const parts = cleanIp.split(":");
    const lastPart = parts[parts.length - 1];
    if (lastPart.includes(".")) {
      const ipv4Parts = lastPart.split(".").map(Number);
      if (ipv4Parts.length === 4 && ipv4Parts.every((p) => p >= 0 && p <= 255)) {
        const addr = (ipv4Parts[0] << 24) | (ipv4Parts[1] << 16) | (ipv4Parts[2] << 8) | ipv4Parts[3];
        for (const cidr of SSRF_BLOCKLIST_CIDRS) {
          const parsed = parseCidr(cidr);
          if (parsed && ipv4InCidr(addr >>> 0, parsed)) return true;
        }
      }
    }
    // Also try full IPv6 expansion for other edge cases
    const expanded = expandIPv6(cleanIp);
    if (expanded) {
      for (const cidr of SSRF_BLOCKLIST_CIDRS) {
        const parsed = parseCidr6(cidr);
        if (parsed && ipv6InCidr(expanded, parsed)) return true;
      }
    }
    return false;
  }
  // IPv6 — also check for IPv4-mapped IPv6 in expanded form (e.g., 0:0:0:0:0:ffff:7f00:1)
  const expanded = expandIPv6(cleanIp);
  if (expanded) {
    // Check for IPv4-mapped IPv6 prefix (::ffff:0:0/96) in expanded form
    // First 10 bytes should be 0, bytes 10-11 should be 0xff, 0xff
    const isIpv4Mapped =
      expanded[0] === 0 &&
      expanded[1] === 0 &&
      expanded[2] === 0 &&
      expanded[3] === 0 &&
      expanded[4] === 0 &&
      expanded[5] === 0 &&
      expanded[6] === 0 &&
      expanded[7] === 0 &&
      expanded[8] === 0 &&
      expanded[9] === 0 &&
      expanded[10] === 0xff &&
      expanded[11] === 0xff;
    if (isIpv4Mapped) {
      // Extract embedded IPv4 from last 4 bytes
      const addr =
        (expanded[12] << 24) |
        (expanded[13] << 16) |
        (expanded[14] << 8) |
        expanded[15];
      for (const cidr of SSRF_BLOCKLIST_CIDRS) {
        const parsed = parseCidr(cidr);
        if (parsed && ipv4InCidr(addr >>> 0, parsed)) return true;
      }
    }
    // Standard IPv6 CIDR checks
    for (const cidr of SSRF_BLOCKLIST_CIDRS) {
      const parsed = parseCidr6(cidr);
      if (parsed && ipv6InCidr(expanded, parsed)) return true;
    }
  }
  return false;
}

/**
 * Check if a hostname is in the SSRF blocklist (exact match, case-insensitive).
 * Strips trailing dots (DNS absolute names) before matching.
 */
export function isHostnameBlocked(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  return SSRF_BLOCKLIST_HOSTNAMES.has(normalized);
}

/**
 * Canonicalize a URL string.
 * - Lowercases the hostname
 * - Removes default ports (80 for HTTP, 443 for HTTPS)
 * - Sorts query parameters alphabetically
 * - Removes fragment
 * - Normalizes path (removes ./ and ../ where possible)
 * - Percent-encodes non-ASCII characters
 */
export function canonicalizeUrl(input: string): CanonicalUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  // Only allow http/https
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return null;
  }
  // Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();
  // Remove default ports
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  // Remove fragment
  parsed.hash = "";
  // Sort query parameters for deterministic canonicalization
  if (parsed.search) {
    const params = new URLSearchParams(parsed.search);
    const sorted = Array.from(params.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    parsed.search = new URLSearchParams(sorted).toString();
  }
  // Normalize path: resolve . and .. segments
  const pathParts = parsed.pathname.split("/");
  const normalized: string[] = [];
  for (const part of pathParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (normalized.length > 0) normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  parsed.pathname = "/" + normalized.join("/");
  return {
    url: parsed.toString(),
    parsed,
    original: input,
  };
}

/**
 * Validate a URL against all deterministic checks:
 * - Well-formed URL
 * - Allowed scheme (http/https)
 * - Not in SSRF hostname blocklist
 * - Hostname is not an IP address in the SSRF blocklist
 * - Hostname resolves to non-blocked IPs (if resolution provided)
 * - Not a data:, file:, ftp:, etc. scheme
 */
export function validateUrl(
  input: string,
  options?: { resolvedIps?: { ipv4: string[]; ipv6: string[] } }
): UrlValidationResult {
  const failures: string[] = [];
  const canonical = canonicalizeUrl(input);
  if (!canonical) {
    failures.push("Malformed URL or unsupported scheme (only http/https allowed)");
    return { valid: false, reason: failures[0], failures };
  }
  const { parsed } = canonical;
  // SSRF hostname blocklist (exact match)
  if (isHostnameBlocked(parsed.hostname)) {
    failures.push(`Hostname '${parsed.hostname}' is blocked (SSRF protection)`);
  }
  // SSRF IP blocklist: check if hostname itself is an IP address
  const hostnameIpCheck = isIpBlocked(parsed.hostname);
  if (hostnameIpCheck) {
    failures.push(
      `Hostname '${parsed.hostname}' resolves to blocked IP (SSRF protection)`
    );
  }
  // SSRF IP blocklist (if resolved IPs provided)
  if (options?.resolvedIps) {
    for (const ip of options.resolvedIps.ipv4) {
      if (isIpBlocked(ip)) {
        failures.push(`Resolved IPv4 '${ip}' is blocked (SSRF protection)`);
      }
    }
    for (const ip of options.resolvedIps.ipv6) {
      if (isIpBlocked(ip)) {
        failures.push(`Resolved IPv6 '${ip}' is blocked (SSRF protection)`);
      }
    }
  }
  // Additional structural checks
  if (!parsed.hostname) {
    failures.push("URL has no hostname");
  }
  if (parsed.pathname === "" || parsed.pathname === "/") {
    // Not a failure, but worth noting — root paths are often not useful
  }
  return {
    valid: failures.length === 0,
    canonical: failures.length === 0 ? canonical : undefined,
    reason: failures[0],
    failures: failures.length > 0 ? failures : undefined,
  };
}

/**
 * Check if a URL scheme is allowed (http/https only).
 */
export function isAllowedScheme(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Extract the registrable domain (eTLD+1) from a URL for domain-based operations.
 * Uses a simple heuristic — for production, consider using a proper PSL library.
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    // Remove www. prefix
    const withoutWww = hostname.replace(/^www\./, "");
    // Simple heuristic: for known TLDs, take last 2 parts; otherwise last 2
    const parts = withoutWww.split(".");
    if (parts.length <= 2) return withoutWww;
    // Known multi-part TLDs (not exhaustive)
    const multiPartTlds = new Set([
      "co.uk",
      "com.au",
      "org.uk",
      "ac.uk",
      "gov.uk",
      "co.jp",
      "com.br",
      "com.mx",
    ]);
    const lastTwo = parts.slice(-2).join(".");
    const lastThree = parts.slice(-3).join(".");
    // Check if the last two parts form a known multi-part TLD (e.g., "co.uk")
    if (multiPartTlds.has(lastTwo)) return lastThree;
    return lastTwo;
  } catch {
    return null;
  }
}

/**
 * Normalize a URL for deduplication purposes.
 * Returns a deterministic key that can be used to identify duplicate URLs.
 * This is more aggressive than canonicalizeUrl — it also:
 * - Removes common tracking parameters (utm_*, fbclid, gclid, etc.)
 * - Normalizes www vs non-www
 */
export function normalizeForDedup(url: string): string | null {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return null;
  const { parsed } = canonical;
  // Remove tracking parameters
  const trackingParams = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "msclkid",
    "yclid",
    "ref",
    "source",
    "mc_cid",
    "mc_eid",
    "_ga",
    "_gl",
  ]);
  const params = new URLSearchParams(parsed.search);
  for (const key of trackingParams) {
    params.delete(key);
  }
  parsed.search = params.toString();
  // Normalize www
  if (parsed.hostname.startsWith("www.")) {
    parsed.hostname = parsed.hostname.slice(4);
  }
  return parsed.toString();
}

/**
 * Generate a deterministic cache key for a URL.
 * Uses the normalized-for-dedup URL as the base.
 */
export function urlCacheKey(url: string, version = "v1"): string | null {
  const normalized = normalizeForDedup(url);
  if (!normalized) return null;
  return `url:${version}:${normalized}`;
}