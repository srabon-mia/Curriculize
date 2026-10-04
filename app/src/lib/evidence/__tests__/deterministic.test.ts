/**
 * Phase 6B Deterministic Educational Evidence Extraction Tests
 * Pure functions - no network, no AI, fully deterministic.
 */

import { extractEducationalEvidence } from "../deterministic";
import type { StructuredContent, TextBlock, Heading, Link, DocumentStatistics } from "@/lib/acquisition/structuredExtract";

function makeStructuredContent(overrides: Partial<StructuredContent> = {}): StructuredContent {
  const baseBlocks: TextBlock[] = [
    { text: "Learning Objectives:", tagName: "p" },
    { text: "Students will be able to solve quadratic equations.", tagName: "p" },
    { text: "Students will understand the quadratic formula.", tagName: "p" },
    { text: "A quadratic equation is defined as an equation of the form ax² + bx + c = 0.", tagName: "p" },
    { text: "Practice Problems:", tagName: "p" },
    { text: "1. Solve x² - 5x + 6 = 0", tagName: "p" },
    { text: "2. Find the roots of 2x² + 3x - 2 = 0", tagName: "p" },
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
    paragraphCount: 7,
    linkCount: 0,
    externalLinkCount: 0,
  };

  // StructuredContent.metadata includes title and description from 6A
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

function makeTextBlock(text: string, tagName = "p"): TextBlock {
  return { text, tagName };
}

describe("extractEducationalEvidence", () => {
  describe("learning objectives", () => {
    test("A. extracts explicit learning objective heading", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Learning Objectives:"),
          makeTextBlock("Students will be able to solve quadratic equations."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const objectives = evidence.interpreted.explicitLearningObjectives;

      expect(objectives.length).toBeGreaterThanOrEqual(1);
      expect(objectives[0].text).toContain("Learning Objectives:");
      expect(objectives[0].pattern).toContain("learning objectives");
      expect(objectives[0].confidence).toBe("high");
      expect(objectives[0].blockIndex).toBe(0);
    });

    test("B. extracts objective list under heading", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Learning Objectives"),
          makeTextBlock("Students will be able to solve quadratic equations."),
          makeTextBlock("Students will understand the quadratic formula."),
          makeTextBlock("You will learn to factor polynomials."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const objectives = evidence.interpreted.explicitLearningObjectives;

      // Should match the explicit "Students will..." and "You will learn..." patterns
      const highConfidence = objectives.filter(o => o.confidence === "high");
      expect(highConfidence.length).toBeGreaterThanOrEqual(2);
    });

    test("C. does NOT classify ordinary prose with 'learn' as objective", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("In this chapter, we learn about quadratic equations."),
          makeTextBlock("You will learn many interesting facts about algebra."),
          makeTextBlock("Learning is a lifelong process."),
          makeTextBlock("The student learns by doing."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const objectives = evidence.interpreted.explicitLearningObjectives;

      // Should NOT match vague/ordinary prose
      const highConfidence = objectives.filter(o => o.confidence === "high");
      expect(highConfidence.length).toBe(0);
    });

    test("C2. does NOT classify 'this section teaches...' as learning objective", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("This section teaches the history of the United States."),
          makeTextBlock("This lesson covers quadratic equations in depth."),
          makeTextBlock("This module introduces the concept of derivatives."),
          makeTextBlock("This course explores advanced calculus topics."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const objectives = evidence.interpreted.explicitLearningObjectives;

      // Should NOT match descriptive prose about what the page teaches
      const highConfidence = objectives.filter(o => o.confidence === "high");
      const mediumConfidence = objectives.filter(o => o.confidence === "medium");
      expect(highConfidence.length).toBe(0);
      expect(mediumConfidence.length).toBe(0);
    });

    test("extracts 'by the end of this lesson' pattern", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("By the end of this lesson, you will be able to factor quadratics."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const objectives = evidence.interpreted.explicitLearningObjectives;

      expect(objectives.length).toBe(1);
      expect(objectives[0].confidence).toBe("high");
    });

    test("extracts 'upon completion' pattern", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Upon completion of this module, students will understand derivatives."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const objectives = evidence.interpreted.explicitLearningObjectives;

      expect(objectives.length).toBe(1);
      expect(objectives[0].confidence).toBe("high");
    });
  });

  describe("definitions", () => {
    test("D. extracts explicit definition", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("A quadratic equation is defined as an equation of the form ax² + bx + c = 0."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const definitions = evidence.interpreted.explicitDefinitions;

      expect(definitions.length).toBe(1);
      expect(definitions[0].text).toContain("defined as");
      expect(definitions[0].confidence).toBe("high");
      expect(definitions[0].blockIndex).toBe(0);
    });

    test("extracts 'X refers to' pattern", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("The discriminant refers to the expression b² - 4ac."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const definitions = evidence.interpreted.explicitDefinitions;

      expect(definitions.length).toBe(1);
      expect(definitions[0].confidence).toBe("high");
    });

    test("E. does NOT classify ordinary 'X is Y' prose as definition", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("The quadratic formula is a useful tool for solving equations."),
          makeTextBlock("This chapter is about quadratic equations."),
          makeTextBlock("The answer is 42."),
          makeTextBlock("Math is fun."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const definitions = evidence.interpreted.explicitDefinitions;

      // Should NOT match vague explanatory prose
      const highConfidence = definitions.filter(d => d.confidence === "high");
      expect(highConfidence.length).toBe(0);
    });

    test("E2. does NOT classify 'X means to...' as definition", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("The chapter means to explain the concept."),
          makeTextBlock("This section means to introduce the topic."),
          makeTextBlock("The author means to illustrate the point."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const definitions = evidence.interpreted.explicitDefinitions;

      // Should NOT match "X means to [verb]" - this is intent, not definition
      const highConfidence = definitions.filter(d => d.confidence === "high");
      const mediumConfidence = definitions.filter(d => d.confidence === "medium");
      expect(highConfidence.length).toBe(0);
      expect(mediumConfidence.length).toBe(0);
    });

    test("skips very short blocks", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("X is Y."),
          makeTextBlock("A is B."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const definitions = evidence.interpreted.explicitDefinitions;

      expect(definitions.length).toBe(0);
    });
  });

  describe("exercises", () => {
    test("F. extracts explicit exercise section", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Practice Problems:"),
          makeTextBlock("1. Solve x² - 5x + 6 = 0"),
          makeTextBlock("2. Find the roots of 2x² + 3x - 2 = 0"),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const exercises = evidence.interpreted.explicitExercises;

      expect(exercises.length).toBeGreaterThanOrEqual(1);
      const highConfidence = exercises.filter(e => e.confidence === "high");
      expect(highConfidence.length).toBeGreaterThanOrEqual(1);
    });

    test("extracts numbered problem list", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("1. Solve x² - 5x + 6 = 0"),
          makeTextBlock("2. Find the roots of 2x² + 3x - 2 = 0"),
          makeTextBlock("3. Prove the quadratic formula."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const exercises = evidence.interpreted.explicitExercises;

      const highConfidence = exercises.filter(e => e.confidence === "high");
      expect(highConfidence.length).toBe(3);
    });

    test("extracts lettered exercise list", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("(a) Solve x² - 5x + 6 = 0"),
          makeTextBlock("(b) Find the roots of 2x² + 3x - 2 = 0"),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const exercises = evidence.interpreted.explicitExercises;

      const highConfidence = exercises.filter(e => e.confidence === "high");
      expect(highConfidence.length).toBe(2);
    });

    test("G. does NOT treat arbitrary question mark as exercise", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("What is a quadratic equation?"),
          makeTextBlock("How do we solve it?"),
          makeTextBlock("Why does this work?"),
          makeTextBlock("Is this the right answer?"),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const exercises = evidence.interpreted.explicitExercises;

      // Should NOT match plain questions
      const highConfidence = exercises.filter(e => e.confidence === "high");
      expect(highConfidence.length).toBe(0);
    });

    test("extracts 'try it' pattern", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Try it: Solve x² + 2x - 3 = 0"),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const exercises = evidence.interpreted.explicitExercises;

      expect(exercises.length).toBe(1);
      expect(exercises[0].confidence).toBe("high");
    });

    test("skips very short blocks", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("1."),
          makeTextBlock("2."),
        ],
      });

      const evidence = extractEducationalEvidence(content);
      const exercises = evidence.interpreted.explicitExercises;

      expect(exercises.length).toBe(0);
    });
  });

  describe("multiple evidence types", () => {
    test("H. extracts multiple evidence types on one page", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Learning Objectives:"),
          makeTextBlock("Students will be able to solve quadratic equations."),
          makeTextBlock("A quadratic equation is defined as an equation of the form ax² + bx + c = 0."),
          makeTextBlock("Practice Problems:"),
          makeTextBlock("1. Solve x² - 5x + 6 = 0"),
        ],
      });

      const evidence = extractEducationalEvidence(content);

      expect(evidence.interpreted.explicitLearningObjectives.length).toBeGreaterThanOrEqual(1);
      expect(evidence.interpreted.explicitDefinitions.length).toBeGreaterThanOrEqual(1);
      expect(evidence.interpreted.explicitExercises.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("traceability", () => {
    test("I. preserves blockIndex for traceability", () => {
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock("Learning Objectives:"), // index 0
          makeTextBlock("Students will be able to solve quadratic equations."), // index 1
          makeTextBlock("A quadratic equation is defined as an equation of the form ax² + bx + c = 0."), // index 2
          makeTextBlock("Practice Problems:"), // index 3
          makeTextBlock("1. Solve x² - 5x + 6 = 0"), // index 4
        ],
      });

      const evidence = extractEducationalEvidence(content);

      const obj = evidence.interpreted.explicitLearningObjectives[0];
      expect(obj.blockIndex).toBe(0);

      const def = evidence.interpreted.explicitDefinitions[0];
      expect(def.blockIndex).toBe(2);

      const ex = evidence.interpreted.explicitExercises[0];
      expect(ex.blockIndex).toBe(3);
    });
  });

  describe("deterministic repeatability", () => {
    test("J. same input produces identical output", () => {
      const content = makeStructuredContent();

      const evidence1 = extractEducationalEvidence(content);
      const evidence2 = extractEducationalEvidence(content);

      expect(JSON.stringify(evidence1)).toBe(JSON.stringify(evidence2));
    });

    test("deterministic across multiple calls", () => {
      const content = makeStructuredContent();

      for (let i = 0; i < 10; i++) {
        const evidence = extractEducationalEvidence(content);
        expect(evidence.interpreted.explicitLearningObjectives.length).toBeGreaterThan(0);
      }
    });
  });

  describe("edge cases", () => {
    test("K. handles empty StructuredContent", () => {
      const content = makeStructuredContent({
        blocks: [],
        headings: [],
        links: [],
        statistics: {
          wordCount: 0,
          headingCount: 0,
          headingCountsByLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
          paragraphCount: 0,
          linkCount: 0,
          externalLinkCount: 0,
        },
      });

      const evidence = extractEducationalEvidence(content);

      expect(evidence.interpreted.explicitLearningObjectives).toHaveLength(0);
      expect(evidence.interpreted.explicitDefinitions).toHaveLength(0);
      expect(evidence.interpreted.explicitExercises).toHaveLength(0);
      expect(evidence.source.cleanedHash).toBe("cleaned-hash-123");
      expect(evidence.source.contentHash).toBe("content-hash-456");
    });

    test("L. works without curriculum topic context", () => {
      // 6B has no curriculum context - should still extract evidence
      const content = makeStructuredContent();
      const evidence = extractEducationalEvidence(content);

      // Should extract based purely on textual patterns
      expect(evidence.interpreted.explicitLearningObjectives.length).toBeGreaterThan(0);
      expect(evidence.interpreted.explicitDefinitions.length).toBeGreaterThan(0);
      expect(evidence.interpreted.explicitExercises.length).toBeGreaterThan(0);
    });

    test("M. preserves cleanedHash and contentHash distinction", () => {
      const content = makeStructuredContent({
        source: {
          cleanedHash: "cleaned-abc123",
          contentHash: "content-def456",
        },
      });

      const evidence = extractEducationalEvidence(content);

      expect(evidence.source.cleanedHash).toBe("cleaned-abc123");
      expect(evidence.source.contentHash).toBe("content-def456");
      expect(evidence.source.cleanedHash).not.toBe(evidence.source.contentHash);
    });

    test("N. handles malformed/edge StructuredContent inputs", () => {
      // Blocks with unusual content
      const content = makeStructuredContent({
        blocks: [
          makeTextBlock(""), // empty
          makeTextBlock("   "), // whitespace
          makeTextBlock("Learning Objectives:".repeat(100)), // very long
          makeTextBlock("Students will be able to solve quadratic equations."),
          { text: "Special chars:  ​‌‍", tagName: "p" }, // unicode
        ],
      });

      const evidence = extractEducationalEvidence(content);

      // Should not crash, should extract what it can
      expect(evidence.interpreted.explicitLearningObjectives.length).toBeGreaterThan(0);
      expect(evidence.source.cleanedHash).toBeDefined();
      expect(evidence.source.contentHash).toBeDefined();
    });

    test("handles different tagNames", () => {
      const content = makeStructuredContent({
        blocks: [
          { text: "Learning Objectives:", tagName: "h2" },
          { text: "Students will be able to solve quadratics.", tagName: "li" },
          { text: "A quadratic is defined as...", tagName: "blockquote" },
          { text: "Practice Problems:", tagName: "h3" },
          { text: "1. Solve x² = 0", tagName: "pre" },
        ],
      });

      const evidence = extractEducationalEvidence(content);

      // Should extract regardless of tagName
      expect(evidence.interpreted.explicitLearningObjectives.length).toBeGreaterThan(0);
      expect(evidence.interpreted.explicitDefinitions.length).toBeGreaterThan(0);
      expect(evidence.interpreted.explicitExercises.length).toBeGreaterThan(0);
    });
  });
});