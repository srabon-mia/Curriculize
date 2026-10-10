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
 * If the input is already an IP address (IPv4, IPv6, or IPv4-mapped IPv6),
 * skip DNS resolution and validate directly against the SSRF blocklist.
 */
export async function resolveAndValidate(hostname: string): Promise<ResolvedHost> {
  const normalized = normalizeHostname(hostname);

  // Step 0: Check if input is an IP address (IPv4, IPv6, or IPv4-mapped IPv6)
  // Do this FIRST so IP addresses get BLOCKED_RESOLVED_IP not BLOCKED_URL
  const { isIp, ipv4, ipv6 } = classifyIpAddress(normalized);
  if (isIp) {
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
    return {
      hostname: normalized,
      ipv4,
      ipv6,
      valid: true,
    };
  }

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
  let resolvedIpv4: string[] = [];
  let resolvedIpv6: string[] = [];

  try {
    resolvedIpv4 = await dns.resolve4(normalized);
  } catch {
    // No A records or resolution failed - not an error yet
  }

  try {
    resolvedIpv6 = await dns.resolve6(normalized);
  } catch {
    // No AAAA records or resolution failed - not an error yet
  }

  // Step 3: Check if we got any records
  if (resolvedIpv4.length === 0 && resolvedIpv6.length === 0) {
    return {
      hostname: normalized,
      ipv4: [],
      ipv6: [],
      valid: false,
      error: createDnsResolutionFailedError(normalized, "No A or AAAA records found"),
    };
  }

  // Step 4: Validate ALL resolved IPs against SSRF blocklist
  const ipError = validateResolvedIps(resolvedIpv4, resolvedIpv6);
  if (ipError) {
    return {
      hostname: normalized,
      ipv4: resolvedIpv4,
      ipv6: resolvedIpv6,
      valid: false,
      error: ipError,
    };
  }

  // Step 5: Success
  return {
    hostname: normalized,
    ipv4: resolvedIpv4,
    ipv6: resolvedIpv6,
    valid: true,
  };
}

/**
 * Classify an input string as IPv4, IPv6, or IPv4-mapped IPv6 address.
 * Returns { isIp, ipv4[], ipv6[] } where arrays contain the address if matched.
 */
function classifyIpAddress(input: string): {
  isIp: boolean;
  ipv4: string[];
  ipv6: string[];
} {
  // IPv4: dotted quad
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) {
    const parts = input.split(".").map(Number);
    if (parts.every((p) => p >= 0 && p <= 255)) {
      return { isIp: true, ipv4: [input], ipv6: [] };
    }
  }

  // IPv6 (full or compressed) - contains only colons and hex, no dots
  // But exclude IPv4-mapped which contains dots
  if (input.includes(":") && !input.includes(".")) {
    // Basic IPv6 validation: try to parse
    try {
      // Validate it's a plausible IPv6 by checking it can be expanded
      const expanded = expandIPv6ForValidation(input);
      if (expanded) {
        return { isIp: true, ipv4: [], ipv6: [input] };
      }
    } catch {
      // Not a valid IPv6
    }
  }

  // IPv4-mapped IPv6: ::ffff:x.x.x.x or 0:0:0:0:0:ffff:x.x.x.x
  // Contains both colons and dots
  if (input.includes(":") && input.includes(".")) {
    // Check for IPv4-mapped prefix
    const mappedMatch = input.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedMatch) {
      const ipv4Part = mappedMatch[1];
      const parts = ipv4Part.split(".").map(Number);
      if (parts.every((p) => p >= 0 && p <= 255)) {
        return { isIp: true, ipv4: [ipv4Part], ipv6: [input] };
      }
    }
    // Also check expanded form: 0:0:0:0:0:ffff:xxxx:xxxx where last 4 bytes are IPv4
    try {
      const expanded = expandIPv6ForValidation(input);
      if (expanded) {
        // Check for IPv4-mapped prefix in expanded form (first 10 bytes 0, bytes 10-11 = 0xff, 0xff)
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
          const ipv4Part = `${expanded[12]}.${expanded[13]}.${expanded[14]}.${expanded[15]}`;
          return { isIp: true, ipv4: [ipv4Part], ipv6: [input] };
        }
        // Regular IPv6
        return { isIp: true, ipv4: [], ipv6: [input] };
      }
    } catch {
      // Not a valid IPv6
    }
  }

  return { isIp: false, ipv4: [], ipv6: [] };
}

/**
 * Expand IPv6 address for validation. Returns Uint8Array(16) or null if invalid.
 * Used only for classification, not for connection.
 */
function expandIPv6ForValidation(addr: string): Uint8Array | null {
  try {
    const parts = addr.split(":");
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
      for (let i = 0; i < doubleColonStart; i++) {
        if (!processPart(parts[i])) return null;
      }
      let groupsAfter = 0;
      for (let i = doubleColonEnd + 1; i < parts.length; i++) {
        if (parts[i] !== "") groupsAfter++;
      }
      const groupsBefore = resultIndex / 2;
      const zeroGroups = 8 - groupsBefore - groupsAfter;
      if (zeroGroups < 1) return null;
      resultIndex += zeroGroups * 2;
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