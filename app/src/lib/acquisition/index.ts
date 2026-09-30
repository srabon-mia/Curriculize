/**
 * Phase 5 Acquisition Engine - Public Exports
 * Main entry point for the acquisition module.
 */

export * from "./errors";
export * from "./types";
export * from "./dns";
export * from "./http";
export * from "./cleaner";
export * from "./engine";

/**
 * Convenience re-exports of commonly used types
 */
export type {
  AcquisitionOptions,
  AcquiredPage,
  CleanedPage,
  DiscoveryCandidate,
  AcquisitionResult,
  RedirectHop,
} from "./types";

export type {
  AcquisitionErrorCode,
  AcquisitionErrorDetails,
} from "./errors";

export {
  AcquisitionError,
  isAcquisitionError,
} from "./errors";

export {
  AcquisitionDedupTracker,
  validateCandidate,
  getCandidateDedupKey,
  acquireCandidate,
  acquireCandidates,
  acquireAndClean,
  DEFAULT_ACQUISITION_OPTIONS,
} from "./engine";