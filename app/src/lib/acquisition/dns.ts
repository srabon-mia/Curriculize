/**
 * Phase 5 DNS Resolution with SSRF Protection
 * Uses Node.js dns.promises and Phase 4 IP validation.
 * Pure implementation, no AI, no external services.
 */

import { promises as dns } from "dns";
import { isIpBlocked, isHostnameBlocked } from "@/lib/deterministic/url";
import { createDnsResolutionFailedError, createBlockedResolvedIpError, createBlockedUrlError } from "./errors";
import type { AcquisitionError } from "./errors";

/** Result of DNS resolution with validation */
export interface ResolvedHost {
  /** The hostname that was resolved */
  hostname: string;
  /** Resolved IPv4 addresses */
  ipv4: string[];
  /** Resolved IPv6 addresses */
  ipv6: string[];
  /** Whether resolution and validation succeeded */
  valid: boolean;
  /** If not valid, the acquisition error */
  error?: AcquisitionError;
}

/** Normalize hostname: lowercase, strip trailing dots */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** Check if a hostname is blocked (SSRF hostname blocklist) */
export function checkHostnameBlocked(hostname: string): AcquisitionError | null {
  const normalized = normalizeHostname(hostname);
  if (isHostnameBlocked(normalized)) {
    return createBlockedUrlError(`http://${normalized}/`, `Hostname '${normalized}' is blocked (SSRF protection)`);
  }
  return null;
}

/** Validate all resolved IPs against Phase 4 SSRF blocklist */
export function validateResolvedIps(ipv4: string[], ipv6: string[]): AcquisitionError | null {
  for (const ip of ipv4) {
    if (isIpBlocked(ip)) {
      return createBlockedResolvedIpError("", ip);
    }
  }
  for (const ip of ipv6) {
    if (isIpBlocked(ip)) {
      return createBlockedResolvedIpError("", ip);
    }
  }
  return null;
}

/**
 * Resolve a hostname and validate all resolved IPs.
 * This is the main DNS security function for Phase 5.
 */
export async function resolveAndValidate(hostname: string): Promise<ResolvedHost> {
  const normalized = normalizeHostname(hostname);

  // Step 1: Check hostname blocklist (fast, no network)
  const hostnameError = checkHostnameBlocked(normalized);
  if (hostnameError) {
    return {
      hostname: normalized,
      ipv4: [],
      ipv6: [],
      valid: false,
      error: hostnameError,
    };
  }

  // Step 2: Resolve A and AAAA records
  let ipv4: string[] = [];
  let ipv6: string[] = [];

  try {
    ipv4 = await dns.resolve4(normalized);
  } catch (err) {
    // No A records or resolution failed - not an error yet
  }

  try {
    ipv6 = await dns.resolve6(normalized);
  } catch (err) {
    // No AAAA records or resolution failed - not an error yet
  }

  // Step 3: Check if we got any records
  if (ipv4.length === 0 && ipv6.length === 0) {
    return {
      hostname: normalized,
      ipv4: [],
      ipv6: [],
      valid: false,
      error: createDnsResolutionFailedError(normalized, "No A or AAAA records found"),
    };
  }

  // Step 4: Validate ALL resolved IPs against SSRF blocklist
  const ipError = validateResolvedIps(ipv4, ipv6);
  if (ipError) {
    return {
      hostname: normalized,
      ipv4,
      ipv6,
      valid: false,
      error: ipError,
    };
  }

  // Step 5: Success
  return {
    hostname: normalized,
    ipv4,
    ipv6,
    valid: true,
  };
}

/**
 * Select the best IP address for connection (Happy Eyeballs style).
 * Prefers IPv6, falls back to IPv4.
 */
export function selectConnectionIp(resolved: ResolvedHost): string | null {
  if (!resolved.valid) return null;
  // Prefer IPv6
  if (resolved.ipv6.length > 0) return resolved.ipv6[0];
  // Fall back to IPv4
  if (resolved.ipv4.length > 0) return resolved.ipv4[0];
  return null;
}

/**
 * Check if a redirect target hostname can reuse the existing resolution.
 * Returns true only if the hostname is exactly the same (after normalization).
 */
export function canReuseResolution(currentHostname: string, redirectHostname: string): boolean {
  return normalizeHostname(currentHostname) === normalizeHostname(redirectHostname);
}