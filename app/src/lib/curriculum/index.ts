/**
 * Phase 8 Curriculum Module - Public Exports
 * Curriculum discovery, verification, persistence, and fallback.
 */

// Search provider
export * from "@/lib/search/provider";
export { SeedSearchProvider, createSeedSearchProvider } from "@/lib/search/seed-provider";

// Curriculum finder
export { findExistingCurriculum, type FoundCurriculum } from "./finder";

// Curriculum discovery
export {
  discoverHumanCurriculumCandidates,
  rankCurriculumCandidates,
  type ValidatedCurriculumCandidate,
  type CurriculumStructureSignals,
  type DiscoveryOptions
} from "./discovery";

// Curriculum verification
export {
  verifyCurriculumStructure,
  hasMinimumCurriculumStructure,
  type CurriculumStructureGate
} from "./verification";

// Curriculum persistence
export {
  persistCurriculumWithSources,
  mirrorToLegacy,
  type PersistCurriculumInput,
  type PersistCurriculumResult
} from "./persistence";

// AI fallback
export {
  createAiGeneratedCurriculum,
  type CreateAiFallbackInput,
  type AiFallbackResult
} from "./fallback";