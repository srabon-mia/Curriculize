/**
 * Phase 6C Deterministic Verification - Public API
 * Exports types and deterministic verification function.
 */

export type {
  VerificationStatus,
  DeterministicChecks,
  AdvisorySignals,
  VerificationInput,
  VerificationResult,
  SourceHashes,
} from "./types";

export { verifyContent, validateVerificationInput } from "./deterministic";