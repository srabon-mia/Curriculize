/**
 * Phase 6B Deterministic Educational Evidence Extraction
 * Pure, side-effect-free extraction of explicit educational signals from StructuredContent.
 * Zero AI, zero network, zero persistence.
 */

import type { StructuredContent, TextBlock } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence, PatternMatch } from "./types";

/**
 * Extract educational evidence from Phase 6A StructuredContent.
 * Pure function - same input always produces same output.
 */
export function extractEducationalEvidence(
  structuredContent: StructuredContent
): EducationalEvidence {
  const explicitLearningObjectives = extractLearningObjectives(structuredContent.blocks);
  const explicitDefinitions = extractDefinitions(structuredContent.blocks);
  const explicitExercises = extractExercises(structuredContent.blocks);

  return {
    source: {
      cleanedHash: structuredContent.source.cleanedHash,
      contentHash: structuredContent.source.contentHash,
    },
    interpreted: {
      explicitLearningObjectives,
      explicitDefinitions,
      explicitExercises,
    },
  };
}

/**
 * High-confidence objective patterns.
 * These match explicit educational objective phrasing.
 */
const HIGH_CONFIDENCE_OBJECTIVE_PATTERNS: RegExp[] = [
  /^learning objectives?:/i,
  /^objectives?:/i,
  /^students? will (be able to|learn to|understand|master|demonstrate|gain|develop)/i,
  /^you will (learn to|understand|be able to|master)/i,
  /^by the end of (this|the) (lesson|unit|course|module|section)/i,
  /^at the end of (this|the) (lesson|unit|course|module|section)/i,
  /^upon completion of (this|the) (lesson|unit|course|module|section)/i,
  /^after (this|the) (lesson|unit|course|module|section)/i,
];

/**
 * Medium-confidence objective patterns.
 * These suggest objectives but are less explicit.
 * "this section teaches/covers..." removed - too broad, matched descriptive prose
 */
const MEDIUM_CONFIDENCE_OBJECTIVE_PATTERNS: RegExp[] = [
  /^in this (lesson|unit|course|module|section),? you will/i,
  /^what you will learn/i,
  /^what you\'ll learn/i,
  /^key (learning )?outcomes?:/i,
  /^intended learning outcomes?:/i,
  /^goals?:/i,
  /^aims?:/i,
];

/**
 * Detect explicit learning objectives from text blocks.
 * Conservative: only matches clear objective-list structures or explicit phrasing.
 */
function extractLearningObjectives(blocks: TextBlock[]): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = block.text.trim();

    // Check high-confidence patterns first
    for (const pattern of HIGH_CONFIDENCE_OBJECTIVE_PATTERNS) {
      if (pattern.test(text)) {
        matches.push({
          text: truncateForEvidence(text),
          blockIndex: i,
          pattern: pattern.source,
          confidence: "high",
        });
        break; // Only record first matching pattern per block
      }
    }

    // If no high-confidence match, check medium-confidence
    if (!matches.some(m => m.blockIndex === i)) {
      for (const pattern of MEDIUM_CONFIDENCE_OBJECTIVE_PATTERNS) {
        if (pattern.test(text)) {
          matches.push({
            text: truncateForEvidence(text),
            blockIndex: i,
            pattern: pattern.source,
            confidence: "medium",
          });
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * High-confidence definition patterns.
 * Match explicit definition structures.
 * "X means" removed - too broad, matched "The chapter means to explain..."
 */
const HIGH_CONFIDENCE_DEFINITION_PATTERNS: RegExp[] = [
  /^([A-Z][a-zA-Z0-9\s\-]+) is defined as\b/i,
  /^([A-Z][a-zA-Z0-9\s\-]+) refers to\b/i,
  /^definition of ([A-Z][a-zA-Z0-9\s\-]+):/i,
  /^([A-Z][a-zA-Z0-9\s\-]+): (a|an|the) (term|concept|notion) (that|which|referring to)/i,
];

/**
 * Medium-confidence definition patterns.
 * Suggest definitions but less explicit.
 */
const MEDIUM_CONFIDENCE_DEFINITION_PATTERNS: RegExp[] = [
  /^we (define|call) ([A-Z][a-zA-Z0-9\s\-]+) (as |to be |)/i,
  /^let ([A-Z][a-zA-Z0-9\s\-]+) (be|denote|represent)/i,
  /^the term ([A-Z][a-zA-Z0-9\s\-]+) (means|refers to)/i,
];

/**
 * Detect explicit definitions from text blocks.
 * Conservative: requires clear definition structure, not just explanatory prose.
 */
function extractDefinitions(blocks: TextBlock[]): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = block.text.trim();

    // Skip very short blocks (likely not definitions)
    if (text.length < 20) continue;

    // Check high-confidence patterns
    for (const pattern of HIGH_CONFIDENCE_DEFINITION_PATTERNS) {
      if (pattern.test(text)) {
        matches.push({
          text: truncateForEvidence(text),
          blockIndex: i,
          pattern: pattern.source,
          confidence: "high",
        });
        break;
      }
    }

    // Medium confidence
    if (!matches.some(m => m.blockIndex === i)) {
      for (const pattern of MEDIUM_CONFIDENCE_DEFINITION_PATTERNS) {
        if (pattern.test(text)) {
          matches.push({
            text: truncateForEvidence(text),
            blockIndex: i,
            pattern: pattern.source,
            confidence: "medium",
          });
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * High-confidence exercise patterns.
 * Match explicit practice/exercise structures.
 */
const HIGH_CONFIDENCE_EXERCISE_PATTERNS: RegExp[] = [
  /^practice (problems?|exercises?|questions?):/i,
  /^exercises?:/i,
  /^problems?:/i,
  /^questions?:/i,
  /^quiz:/i,
  /^try (it|this|these):/i,
  /^practice (set|sheet|worksheet):/i,
  /^homework:/i,
  /^assignment:/i,
  /^\d+\.\s*(solve|calculate|prove|show|find|determine|evaluate|compute)/i,
  /^\([a-z]\)\s*(solve|calculate|prove|show|find|determine|evaluate|compute)/i,
];

/**
 * Medium-confidence exercise patterns.
 * Suggest exercises but less explicit.
 */
const MEDIUM_CONFIDENCE_EXERCISE_PATTERNS: RegExp[] = [
  /practice (problems?|exercises?|questions?)/i,
  /test your (knowledge|understanding)/i,
  /check your (understanding|knowledge)/i,
  /work through/i,
  /try (solving|calculating|proving)/i,
  /exercise \d+/i,
  /problem \d+/i,
  /question \d+/i,
];

/**
 * Detect explicit exercises/practice from text blocks.
 * Conservative: only matches clear exercise structures, not every question mark.
 */
function extractExercises(blocks: TextBlock[]): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const text = block.text.trim();

    // Skip very short blocks
    if (text.length < 15) continue;

    // Check high-confidence patterns
    for (const pattern of HIGH_CONFIDENCE_EXERCISE_PATTERNS) {
      if (pattern.test(text)) {
        matches.push({
          text: truncateForEvidence(text),
          blockIndex: i,
          pattern: pattern.source,
          confidence: "high",
        });
        break;
      }
    }

    // Medium confidence
    if (!matches.some(m => m.blockIndex === i)) {
      for (const pattern of MEDIUM_CONFIDENCE_EXERCISE_PATTERNS) {
        if (pattern.test(text)) {
          matches.push({
            text: truncateForEvidence(text),
            blockIndex: i,
            pattern: pattern.source,
            confidence: "medium",
          });
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * Truncate evidence text for storage/display while preserving the match context.
 * Keeps first 300 characters.
 */
function truncateForEvidence(text: string): string {
  const maxLen = 300;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + "…";
}