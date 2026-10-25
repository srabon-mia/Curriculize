/**
 * Phase 6C Deterministic Verification Tests
 * Pure functions - no network, no AI, fully deterministic.
 */

import { verifyContent, validateVerificationInput } from "../deterministic";
import type {
  VerificationInput,
  VerificationStatus,
} from "../types";
import type {
  StructuredContent,
  DocumentStatistics,
  Heading,
  TextBlock,
  Link,
} from "@/lib/acquisition/structuredExtract";
import type { EducationalEvidence, PatternMatch } from "@/lib/evidence/types";
import { extractEducationalEvidence } from "@/lib/evidence/deterministic";

function makeStructuredContent(overrides: Partial<StructuredContent> = {}): StructuredContent {
  const baseBlocks: TextBlock[] = [
    { text: "Learning Objectives:", tagName: "p" },
    { text: "Students will be able to solve quadratic equations.", tagName: "p" },
    { text: "A quadratic equation is defined as an equation of the form ax² + bx + c = 0.", tagName: "p" },
    { text: "Practice Problems:", tagName: "p" },
    { text: "1. Solve x² - 5x + 6 = 0", tagName: "p" },
  ];

  const baseHeadings: Heading[] = [
    { level: 1, text: "Quadratic Equations" },
    { level: 2, text: "Learning Objectives" },
    { level: 2, text: "Definitions" },
    { level: 2, text: "Practice" },
  ];

  const baseLinks: Link[] = [];

  const baseStats: DocumentStatistics = {
    wordCount: 150,
    headingCount: 4,
    headingCountsByLevel: { 1: 1, 2: 3, 3: 0, 4: 0, 5: 0, 6: 0 },
    paragraphCount: 5,
    linkCount: 0,
    externalLinkCount: 0,
  };

  const baseMetadata = {
    title: "Quadratic Equations",
    description: "Learn about quadratic equations",
    author: "Test Author",
    datePublished: "2024-01-15",
    language: "en",
  };

  return {
    source: {
      cleanedHash: "cleaned-hash-123",
      contentHash: "content-hash-456",
    },
    metadata: baseMetadata,
    headings: baseHeadings,
    blocks: baseBlocks,
    links: baseLinks,
    statistics: baseStats,
    ...overrides,
  };
}

function makeEducationalEvidence(overrides: Partial<EducationalEvidence> = {}): EducationalEvidence {
  const baseObjectives: PatternMatch[] = [
    { text: "Learning Objectives:", blockIndex: 0, pattern: "^learning objectives?:", confidence: "high" },
    { text: "Students will be able to solve quadratic equations.", blockIndex: 1, pattern: "^students? will (be able to|learn to|understand|master|demonstrate|gain|develop)", confidence: "high" },
  ];
  const baseDefinitions: PatternMatch[] = [
    { text: "A quadratic equation is defined as an equation of the form ax² + bx + c = 0.", blockIndex: 2, pattern: "^([A-Z][a-zA-Z0-9\\s\\-]+) is defined as\\b", confidence: "high" },
  ];
  const baseExercises: PatternMatch[] = [
    { text: "Practice Problems:", blockIndex: 3, pattern: "^practice (problems?|exercises?|questions?):", confidence: "high" },
    { text: "1. Solve x² - 5x + 6 = 0", blockIndex: 4, pattern: "^\\d+\\.\\s*(solve|calculate|prove|show|find|determine|evaluate|compute)", confidence: "high" },
  ];

  return {
    source: {
      cleanedHash: "cleaned-hash-123",
      contentHash: "content-hash-456",
    },
    interpreted: {
      explicitLearningObjectives: baseObjectives,
      explicitDefinitions: baseDefinitions,
      explicitExercises: baseExercises,
    },
    ...overrides,
  };
}

function makeVerificationInput(overrides: Partial<VerificationInput> = {}): VerificationInput {
  const baseAcquiredPage = {
    contentHash: "content-hash-456",
    canonicalUrl: "https://example.com/quadratics",
    finalUrl: "https://example.com/quadratics",
    statusCode: 200,
    contentType: "text/html",
    acquiredAt: "2024-01-15T10:00:00.000Z",
  };

  return {
    acquiredPage: baseAcquiredPage,
    structuredContent: makeStructuredContent(),
    educationalEvidence: makeEducationalEvidence(),
    ...overrides,
  };
}

describe("verifyContent", () => {
  test("uses target-relevant fetched instructional evidence for the approval signal", () => {
    const structuredContent = makeStructuredContent({
      blocks: [
        { text: "We begin with the first-order differential equation y' + 2y = e^x.", tagName: "p" },
        { text: "Multiplying both sides by the integrating factor e^(2x) gives the left side as a product derivative.", tagName: "p" },
        { text: "Integrating gives e^(2x)y = (1/3)e^(3x) + C, therefore y = (1/3)e^x + Ce^(-2x).", tagName: "p" },
      ],
    });
    const educationalEvidence = extractEducationalEvidence(structuredContent, {
      topicTitle: "Differential Equations",
      conceptDescription: "First-order linear differential equations and integrating factors",
    });

    const result = verifyContent(makeVerificationInput({
      structuredContent,
      educationalEvidence,
    }));

    expect(result.status).toBe("verified");
    expect(result.advisorySignals.educationalEvidencePresent).toBe(true);
  });

  test("does not signal an explicit but off-target lesson as approval evidence", () => {
    const structuredContent = makeStructuredContent({
      blocks: [
        { text: "Students will be able to solve quadratic equations.", tagName: "p" },
        { text: "A quadratic equation is defined as ax^2 + bx + c = 0.", tagName: "p" },
      ],
    });
    const educationalEvidence = extractEducationalEvidence(structuredContent, {
      topicTitle: "Differential Equations",
      conceptDescription: "First-order linear differential equations",
    });

    const result = verifyContent(makeVerificationInput({
      structuredContent,
      educationalEvidence,
    }));

    expect(result.status).toBe("verified");
    expect(result.advisorySignals.educationalEvidencePresent).toBe(false);
  });

  describe("hard gate: cleanedContentNonEmpty", () => {
    test("1. Normal educational resource - verified", () => {
      const input = makeVerificationInput();
      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.deterministicChecks.cleanedContentNonEmpty).toBe(true);
      expect(result.advisorySignals.wordCount).toBe(150);
      expect(result.advisorySignals.titlePresent).toBe(true);
      expect(result.advisorySignals.educationalEvidencePresent).toBe(true);
    });

    test("2. Minimal resource (1 word) - verified", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          statistics: {
            wordCount: 1,
            headingCount: 0,
            headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
            paragraphCount: 1,
            linkCount: 0,
            externalLinkCount: 0,
          },
          blocks: [{ text: "Content", tagName: "p" }],
          headings: [],
          metadata: { ...makeStructuredContent().metadata, title: "" },
        }),
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [],
            explicitDefinitions: [],
            explicitExercises: [],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.deterministicChecks.cleanedContentNonEmpty).toBe(true);
      expect(result.advisorySignals.wordCount).toBe(1);
    });

    test("3. Empty resource (0 words) - failed", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          statistics: {
            wordCount: 0,
            headingCount: 0,
            headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
            paragraphCount: 0,
            linkCount: 0,
            externalLinkCount: 0,
          },
          blocks: [],
          headings: [],
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("failed");
      expect(result.deterministicChecks.cleanedContentNonEmpty).toBe(false);
      expect(result.advisorySignals.wordCount).toBe(0);
    });
  });

  describe("advisory signals do not affect status", () => {
    test("4. No title - still verified", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          metadata: { ...makeStructuredContent().metadata, title: "" },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.titlePresent).toBe(false);
    });

    test("5. No educational evidence - still verified", () => {
      const input = makeVerificationInput({
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [],
            explicitDefinitions: [],
            explicitExercises: [],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.educationalEvidencePresent).toBe(false);
    });

    test("6. Definitions only - still verified", () => {
      const input = makeVerificationInput({
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [],
            explicitDefinitions: [
              { text: "A quadratic equation is defined as...", blockIndex: 0, pattern: "^([A-Z][a-zA-Z0-9\\s\\-]+) is defined as\\b", confidence: "high" },
            ],
            explicitExercises: [],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.educationalEvidencePresent).toBe(true);
    });

    test("7. Exercises only - still verified", () => {
      const input = makeVerificationInput({
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [],
            explicitDefinitions: [],
            explicitExercises: [
              { text: "1. Solve x² - 5x + 6 = 0", blockIndex: 0, pattern: "^\\d+\\.\\s*(solve|calculate|prove|show|find|determine|evaluate|compute)", confidence: "high" },
            ],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.educationalEvidencePresent).toBe(true);
    });

    test("8. Prose-only page (no headings) - still verified", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          statistics: {
            wordCount: 200,
            headingCount: 0,
            headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
            paragraphCount: 5,
            linkCount: 0,
            externalLinkCount: 0,
          },
          headings: [],
          blocks: Array(5).fill({ text: "This is a paragraph about quadratic equations with educational content.", tagName: "p" }),
          metadata: { ...makeStructuredContent().metadata, title: "Quadratic Equations" },
        }),
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [],
            explicitDefinitions: [],
            explicitExercises: [],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.headingCount).toBe(0);
      expect(result.advisorySignals.educationalEvidencePresent).toBe(false);
    });

    test("9. Very short legitimate resource - verified", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          statistics: {
            wordCount: 1,
            headingCount: 0,
            headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
            paragraphCount: 1,
            linkCount: 0,
            externalLinkCount: 0,
          },
          blocks: [{ text: "x²", tagName: "p" }],
          headings: [],
          metadata: { ...makeStructuredContent().metadata, title: "" },
        }),
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [],
            explicitDefinitions: [],
            explicitExercises: [],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.wordCount).toBe(1);
    });
  });

  describe("hash preservation", () => {
    test("10. Result contentHash equals Phase 5 AcquiredPage.contentHash", () => {
      const input = makeVerificationInput({
        acquiredPage: {
          ...makeVerificationInput().acquiredPage,
          contentHash: "specific-content-hash-abc123",
        },
        structuredContent: makeStructuredContent({
          source: { cleanedHash: "cleaned-xyz", contentHash: "specific-content-hash-abc123" },
        }),
        educationalEvidence: makeEducationalEvidence({
          source: { cleanedHash: "cleaned-xyz", contentHash: "specific-content-hash-abc123" },
        }),
      });

      const result = verifyContent(input);

      expect(result.contentHash).toBe("specific-content-hash-abc123");
    });

    test("11. Result canonicalUrl uses Phase 5 canonical URL without re-canonicalizing", () => {
      const input = makeVerificationInput({
        acquiredPage: {
          ...makeVerificationInput().acquiredPage,
          canonicalUrl: "https://example.com/canonical-path",
        },
      });

      const result = verifyContent(input);

      expect(result.canonicalUrl).toBe("https://example.com/canonical-path");
    });
  });

  describe("advisory signals completeness", () => {
    test("12. All advisory signals populated correctly", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          statistics: {
            wordCount: 250,
            headingCount: 3,
            headingCountsByLevel: { 1: 1, 2: 2, 3: 0, 4: 0, 5: 0, 6: 0 },
            paragraphCount: 7,
            linkCount: 2,
            externalLinkCount: 1,
          },
          metadata: { ...makeStructuredContent().metadata, title: "Test Title" },
        }),
        educationalEvidence: makeEducationalEvidence({
          interpreted: {
            explicitLearningObjectives: [{ text: "Obj", blockIndex: 0, pattern: "pat", confidence: "high" }],
            explicitDefinitions: [],
            explicitExercises: [],
          },
        }),
      });

      const result = verifyContent(input);

      expect(result.advisorySignals).toEqual({
        titlePresent: true,
        educationalEvidencePresent: true,
        wordCount: 250,
        headingCount: 3,
        paragraphCount: 7,
      });
    });
  });

  describe("deterministic repeatability", () => {
    test("13. Same input produces identical output (except timestamp)", () => {
      const input = makeVerificationInput();

      const result1 = verifyContent(input);
      const result2 = verifyContent(input);

      // Compare everything except verifiedAt
      const { verifiedAt: _, ...rest1 } = result1;
      const { verifiedAt: __, ...rest2 } = result2;

      expect(rest1).toEqual(rest2);
    });

    test("13b. Deterministic across multiple calls", () => {
      const input = makeVerificationInput();

      for (let i = 0; i < 10; i++) {
        const result = verifyContent(input);
        expect(result.status).toBe("verified");
        expect(result.deterministicChecks.cleanedContentNonEmpty).toBe(true);
      }
    });
  });

  describe("source hash consistency validation", () => {
    test("14. validateVerificationInput throws on contentHash mismatch", () => {
      const input = makeVerificationInput({
        acquiredPage: { ...makeVerificationInput().acquiredPage, contentHash: "hash-1" },
        structuredContent: makeStructuredContent({ source: { cleanedHash: "cleaned", contentHash: "hash-2" } }),
        educationalEvidence: makeEducationalEvidence({ source: { cleanedHash: "cleaned", contentHash: "hash-1" } }),
      });

      expect(() => validateVerificationInput(input)).toThrow("contentHash mismatch");
    });

    test("14b. validateVerificationInput throws on cleanedHash mismatch", () => {
      const input = makeVerificationInput({
        acquiredPage: { ...makeVerificationInput().acquiredPage, contentHash: "content-hash-456" },
        structuredContent: makeStructuredContent({ source: { cleanedHash: "cleaned-1", contentHash: "content-hash-456" } }),
        educationalEvidence: makeEducationalEvidence({ source: { cleanedHash: "cleaned-2", contentHash: "content-hash-456" } }),
      });

      expect(() => validateVerificationInput(input)).toThrow("cleanedHash mismatch");
    });

    test("14c. validateVerificationInput passes when hashes are consistent", () => {
      const input = makeVerificationInput();

      expect(() => validateVerificationInput(input)).not.toThrow();
    });

    test("14d. validateVerificationInput throws on missing hashes", () => {
      const input = makeVerificationInput({
        acquiredPage: { ...makeVerificationInput().acquiredPage, contentHash: "" },
      });

      expect(() => validateVerificationInput(input)).toThrow("missing acquiredPage.contentHash");
    });
  });

  describe("edge cases", () => {
    test("15. Handles minimal StructuredContent with zero stats but wordCount > 0", () => {
      const input = makeVerificationInput({
        structuredContent: makeStructuredContent({
          statistics: {
            wordCount: 5,
            headingCount: 0,
            headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
            paragraphCount: 0,
            linkCount: 0,
            externalLinkCount: 0,
          },
          headings: [],
          blocks: [{ text: "Short content here", tagName: "p" }],
        }),
      });

      const result = verifyContent(input);

      expect(result.status).toBe("verified");
      expect(result.advisorySignals.paragraphCount).toBe(0);
      expect(result.advisorySignals.wordCount).toBe(5);
    });

    test("16. verifiedAt is valid ISO timestamp", () => {
      const input = makeVerificationInput();
      const result = verifyContent(input);

      expect(() => new Date(result.verifiedAt)).not.toThrow();
      expect(new Date(result.verifiedAt).toISOString()).toBe(result.verifiedAt);
    });

    test("17. Does not require network/AI/Supabase/env - pure function", () => {
      // This test verifies the function runs without any external dependencies
      // If it required network/AI/DB/env, it would fail in this test environment
      const input = makeVerificationInput();
      const result = verifyContent(input);

      expect(result).toBeDefined();
      expect(typeof result.status).toBe("string");
      expect(typeof result.deterministicChecks.cleanedContentNonEmpty).toBe("boolean");
    });
  });

  describe("verifyContent behavior summary", () => {
    test("only wordCount > 0 determines status", () => {
      const testCases = [
        { wordCount: 0, expectedStatus: "failed" as VerificationStatus, desc: "zero words" },
        { wordCount: 1, expectedStatus: "verified" as VerificationStatus, desc: "one word" },
        { wordCount: 10, expectedStatus: "verified" as VerificationStatus, desc: "ten words" },
        { wordCount: 1000, expectedStatus: "verified" as VerificationStatus, desc: "many words" },
      ];

      for (const { wordCount, expectedStatus, desc } of testCases) {
        const input = makeVerificationInput({
          structuredContent: makeStructuredContent({
            statistics: {
              ...makeStructuredContent().statistics,
              wordCount,
            },
            blocks: wordCount > 0 ? [{ text: "x".repeat(wordCount), tagName: "p" }] : [],
          }),
        });

        const result = verifyContent(input);
        expect(result.status).toBe(expectedStatus);
        expect(result.deterministicChecks.cleanedContentNonEmpty).toBe(wordCount > 0);
      }
    });
  });
});
