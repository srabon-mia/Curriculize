/**
 * Phase 6B Deterministic Educational Evidence Extraction
 * Pure, side-effect-free extraction of explicit educational signals from StructuredContent.
 * Zero AI, zero network, zero persistence.
 */

import type { StructuredContent, TextBlock } from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence, EvidenceTargetContext, PatternMatch } from "./types";

/**
 * Extract educational evidence from Phase 6A StructuredContent.
 * Pure function - same input always produces same output.
 */
export function extractEducationalEvidence(
  structuredContent: StructuredContent,
  targetContext?: EvidenceTargetContext
): EducationalEvidence {
  let explicitLearningObjectives = extractLearningObjectives(structuredContent.blocks);
  let explicitDefinitions = extractDefinitions(structuredContent.blocks);
  let explicitExercises = extractExercises(structuredContent.blocks);
  let workedExamples: PatternMatch[] = [];
  let instructionalExplanations: PatternMatch[] = [];
  let targetRelevantEvidence: PatternMatch[] | undefined;
  let targetTermsMatched: string[] | undefined;

  if (targetContext) {
    const terms = getTargetTerms(targetContext);
    const repeatedBlockIndexes = findRepeatedBlockIndexes(structuredContent.blocks);
    const originalMatches = [
      ...explicitLearningObjectives,
      ...explicitDefinitions,
      ...explicitExercises,
    ];
    const relevantMatches = originalMatches.filter((match) =>
      evidenceMatchesTarget(match, structuredContent.blocks, terms, repeatedBlockIndexes)
    );
    const relevantKeys = new Set(relevantMatches.map(matchKey));
    explicitLearningObjectives = explicitLearningObjectives.filter((match) => relevantKeys.has(matchKey(match)));
    explicitDefinitions = explicitDefinitions.filter((match) => relevantKeys.has(matchKey(match)));
    explicitExercises = explicitExercises.filter((match) => relevantKeys.has(matchKey(match)));

    const instructional = extractTargetRelevantInstructionalContent(
      structuredContent.blocks,
      terms,
      repeatedBlockIndexes
    );
    workedExamples = instructional.workedExamples;
    instructionalExplanations = instructional.explanations;
    targetRelevantEvidence = [
      ...relevantMatches,
      ...workedExamples,
      ...instructionalExplanations,
    ];
    targetTermsMatched = Array.from(new Set(
      targetRelevantEvidence.flatMap((match) => getMatchedTargetTerms(match.text, terms))
    )).sort();
  }

  return {
    source: {
      cleanedHash: structuredContent.source.cleanedHash,
      contentHash: structuredContent.source.contentHash,
    },
    interpreted: {
      explicitLearningObjectives,
      explicitDefinitions,
      explicitExercises,
      ...(targetContext ? {
        workedExamples,
        instructionalExplanations,
        targetRelevantEvidence,
        targetTermsMatched,
      } : {}),
    },
  };
}

const MAX_EVIDENCE_BLOCKS = 500;
const MAX_EVIDENCE_WINDOW_CHARS = 1400;
const TARGET_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "in", "into", "is", "it", "of", "on", "or", "that", "the", "their",
  "this", "to", "using", "what", "when", "where", "which", "with", "you",
  "learn", "learning", "understand", "understanding", "introduction", "intro",
  "course", "lesson", "unit", "topic", "concept", "method", "methods",
]);
const BOILERPLATE_PATTERNS = [
  /\b(?:accept|manage) cookies\b/i,
  /\bprivacy policy\b/i,
  /\bterms of (?:use|service)\b/i,
  /\ball rights reserved\b/i,
  /\bskip to (?:content|main content)\b/i,
  /\b(?:sign in|sign up|log in|create an account)\b/i,
  /\bsubscribe to (?:our|the) newsletter\b/i,
  /\b(?:share this page|print this page|back to top)\b/i,
];
const INSTRUCTIONAL_LANGUAGE =
  /\b(?:because|therefore|thus|hence|substitut\w*|differentiat\w*|integrat\w*|rearrang\w*|simplif\w*|factor\w*|expand\w*|isolat\w*|derive\w*|solv\w*|we obtain|which gives|it follows|satisf\w*|relat\w*|represent\w*|model\w*|describ\w*|consider|initial condition|general solution|particular solution)\b/i;
const MATHEMATICAL_CONTENT =
  /(?:[=≈≠≤≥∫∑√∂∇]|\b(?:equation|derivative|integral|function|matrix|matrices|vector|eigenvalue|polynomial|variable|initial condition|boundary condition|differential)\b)/i;
const MECHANISTIC_EXPLANATION =
  /\b(?:works|operates|functions) by\s+[a-z-]+ing\b|\bby\s+[a-z-]+ing\b[^.!?]{0,100}\b(?:allowing|enabling)\b/i;
const WORKED_STEP_LANGUAGE =
  /\b(?:substitut(?:e|ed|ing)|differentiat(?:e|ed|ing)|integrat(?:e|ed|ing\s+(?:both sides|the equation|to|gives))|rearrang(?:e|ed|ing)|simplif(?:y|ied|ying)|factor\s+(?:the|both)|expand(?:ed|ing)?|isolat(?:e|ed|ing)|deriv(?:e|ed|ing)|solv(?:e|ed|ing)|we obtain|which gives|it follows|therefore|thus|hence)\b/i;

function getTargetTerms(context: EvidenceTargetContext): string[] {
  const words = `${context.topicTitle} ${context.conceptDescription ?? ""}`
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return Array.from(new Set(words.filter((word) =>
    word.length >= 3 && !TARGET_STOP_WORDS.has(word)
  ).map(normalizeTargetToken))).slice(0, 24);
}

function getMatchedTargetTerms(text: string, targetTerms: string[]): string[] {
  const contentTerms = new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeTargetToken)
  );
  return targetTerms.filter((term) => contentTerms.has(term));
}

function normalizeTargetToken(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function requiredTargetTermMatches(targetTerms: string[]): number {
  return targetTerms.length > 1 ? 2 : targetTerms.length;
}

function matchKey(match: PatternMatch): string {
  return `${match.blockIndex}:${match.pattern}:${match.text}`;
}

function evidenceMatchesTarget(
  match: PatternMatch,
  blocks: TextBlock[],
  targetTerms: string[],
  repeatedBlockIndexes: Set<number>
): boolean {
  const block = blocks[match.blockIndex];
  if (targetTerms.length === 0 || repeatedBlockIndexes.has(match.blockIndex) ||
      !block || !isSubstantiveContentBlock(block)) return false;

  // A heading or neighboring paragraph must not lend its topic words to an
  // otherwise generic objective, definition, or exercise.
  return getMatchedTargetTerms(match.text, targetTerms).length >=
    requiredTargetTermMatches(targetTerms);
}

function isSubstantiveContentBlock(block: TextBlock): boolean {
  const tagName = block.tagName.trim().toLowerCase();
  return !/^(?:h[1-6]|a|nav|header|footer|button|script|style|title)$/.test(tagName);
}

function isBoilerplate(text: string): boolean {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

function extractTargetRelevantInstructionalContent(
  blocks: TextBlock[],
  targetTerms: string[],
  repeatedBlockIndexes: Set<number>
): { workedExamples: PatternMatch[]; explanations: PatternMatch[] } {
  const usableBlocks = blocks.slice(0, MAX_EVIDENCE_BLOCKS);
  const workedExamples: PatternMatch[] = [];
  const explanations: PatternMatch[] = [];
  const seenBlocks = new Set<string>();

  for (let i = 0; i < usableBlocks.length; i++) {
    for (let length = 1; length <= 3 && i + length <= usableBlocks.length; length++) {
      const rangeIndexes = Array.from({ length }, (_, offset) => i + offset);
      const range = rangeIndexes.map((index) => usableBlocks[index]);
      // A heading, navigation item, boilerplate block, or repeated block ends
      // the local passage. Do not skip it and join content from either side.
      if (rangeIndexes.some((index, offset) =>
        repeatedBlockIndexes.has(index) || !isSubstantiveContentBlock(range[offset]) ||
        isBoilerplate(range[offset].text)
      )) break;

      const text = range.map((block) => block.text.slice(0, 700)).join(" ")
        .slice(0, MAX_EVIDENCE_WINDOW_CHARS).trim();
      if (!text || seenBlocks.has(text)) continue;
      seenBlocks.add(text);

      const tokenCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
      if (tokenCount < 12) continue;
      const termsByBlock = range.map((block) => getMatchedTargetTerms(block.text, targetTerms));
      const matchedTerms = Array.from(new Set(termsByBlock.flat()));
      if (matchedTerms.length < requiredTargetTermMatches(targetTerms)) continue;

      // Every block that supplies instructional, mathematical, or mechanistic
      // signals must itself mention a target term. A topical introduction may
      // provide context for subsequent derivation steps, but cannot bless generic math.
      const signalsAreTargetBound = range.every((block, index) => {
        const contributesSignal = INSTRUCTIONAL_LANGUAGE.test(block.text) ||
          MATHEMATICAL_CONTENT.test(block.text) ||
          MECHANISTIC_EXPLANATION.test(block.text);
        return !contributesSignal || termsByBlock[index].length > 0;
      });
      const hasMathBackedExplanation = INSTRUCTIONAL_LANGUAGE.test(text) &&
        MATHEMATICAL_CONTENT.test(text);
      const hasMechanisticExplanation = MECHANISTIC_EXPLANATION.test(text);
      if (!signalsAreTargetBound ||
          (!hasMathBackedExplanation && !hasMechanisticExplanation)) continue;

      const match: PatternMatch = {
        text: truncateForEvidence(text),
        blockIndex: i,
        pattern: hasMechanisticExplanation
          ? "target-relevant-mechanistic-explanation"
          : "target-relevant-instructional-math-content",
        confidence: "medium",
      };
      if (WORKED_STEP_LANGUAGE.test(text)) workedExamples.push(match);
      else explanations.push(match);
    }
  }

  return {
    workedExamples: dedupeMatches(workedExamples),
    explanations: dedupeMatches(explanations),
  };
}

function dedupeMatches(matches: PatternMatch[]): PatternMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = match.text.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findRepeatedBlockIndexes(blocks: TextBlock[]): Set<number> {
  const normalized = blocks.slice(0, MAX_EVIDENCE_BLOCKS).map((block) =>
    block.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  );
  const counts = new Map<string, number>();
  for (const text of normalized) {
    if (text.length >= 30) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return new Set(
    normalized.flatMap((text, index) =>
      (text.length >= 30 && (counts.get(text) ?? 0) >= 3) ? [index] : []
    )
  );
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
  // Tutorial-specific patterns: genuine educational introductions with specific learning activities
  // Require "guide" or "tutorial" + specific activity verb (not vague "learn about")
  /^in this (guide|tutorial),? you will (learn|build|make|create|program|control|wire|connect) (how to )?/i,
  /^this (guide|tutorial) (shows|teaches) (you )?how to/i,
  /^let's (learn|build|make|create|program) (how to )?/i,
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
