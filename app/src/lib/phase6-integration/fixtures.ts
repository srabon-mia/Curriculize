/**
 * Phase 6 Integration Test Fixtures
 * Realistic acquisition fixtures that exercise the full 5 → 6A → 6B → 6C → 6D pipeline.
 */

import type { AcquiredPage } from "@/lib/acquisition/types";
import type { CanonicalUrl } from "@/lib/deterministic/url";

function makeCanonicalUrl(url: string): CanonicalUrl {
  return {
    url,
    parsed: new URL(url),
    original: url,
  };
}

function makeAcquiredPage(overrides: Partial<AcquiredPage> = {}): AcquiredPage {
  return {
    finalUrl: "https://example.com/math/quadratics",
    canonicalUrl: makeCanonicalUrl("https://example.com/math/quadratics"),
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "",
    contentType: "text/html",
    charset: "utf-8",
    contentHash: "",
    acquiredAt: new Date().toISOString(),
    redirectChain: [],
    resolvedIps: { ipv4: ["93.184.216.34"], ipv6: [] },
    ...overrides,
  };
}

/**
 * Fixture 1: Standard educational page with explicit learning objectives, definitions, and exercises.
 * Should pass verification (wordCount > 0) and have educational evidence.
 */
export const FIXTURE_STANDARD_EDUCATIONAL = makeAcquiredPage({
  body: `
    <html>
      <head>
        <title>Quadratic Equations - Complete Lesson</title>
        <meta name="description" content="Learn to solve quadratic equations with step-by-step examples">
        <meta name="author" content="Math Department">
        <meta property="article:published_time" content="2024-01-15T10:00:00Z">
      </head>
      <body>
        <nav>Site Navigation</nav>
        <main>
          <h1>Quadratic Equations</h1>
          <h2>Learning Objectives</h2>
          <p>Students will be able to solve quadratic equations using the quadratic formula.</p>
          <p>Students will be able to identify the discriminant and determine the number of solutions.</p>
          <h2>Definitions</h2>
          <p>A quadratic equation is defined as an equation of the form ax² + bx + c = 0 where a ≠ 0.</p>
          <p>The discriminant refers to the expression b² - 4ac which determines the nature of the roots.</p>
          <h2>Practice Problems</h2>
          <p>Practice Problems:</p>
          <p>1. Solve x² - 5x + 6 = 0</p>
          <p>2. Calculate the discriminant of 2x² + 3x + 1 = 0</p>
          <p>3. Find the roots of x² + 4x + 4 = 0</p>
        </main>
        <footer>Footer content</footer>
        <script>console.log('tracking')</script>
        <style>.hidden { display: none; }</style>
      </body>
    </html>
  `,
  contentHash: "standard-educational-content-hash",
});

/**
 * Fixture 2: Minimal content - single word.
 * Should pass verification (wordCount > 0) but have no educational evidence.
 */
export const FIXTURE_MINIMAL_CONTENT = makeAcquiredPage({
  body: `
    <html>
      <head><title>Minimal</title></head>
      <body><p>Content</p></body>
    </html>
  `,
  contentHash: "minimal-content-hash",
});

/**
 * Fixture 3: Empty content - no text after cleaning.
 * Should FAIL verification (wordCount === 0).
 */
export const FIXTURE_EMPTY_CONTENT = makeAcquiredPage({
  body: `
    <html>
      <head><title>Empty</title></head>
      <body><nav>Nav</nav><main></main><footer>Footer</footer></body>
    </html>
  `,
  contentHash: "empty-content-hash",
});

/**
 * Fixture 4: Content with relative links that need resolution.
 */
export const FIXTURE_RELATIVE_LINKS = makeAcquiredPage({
  body: `
    <html>
      <head><title>Relative Links Test</title></head>
      <body>
        <main>
          <h1>Chapter 1</h1>
          <p>See <a href="/chapter2">Chapter 2</a> for more details.</p>
          <p>Also check <a href="../appendix">Appendix</a>.</p>
          <p>External link: <a href="https://other.com/resource">Other Site</a></p>
        </main>
      </body>
    </html>
  `,
  contentHash: "relative-links-content-hash",
  finalUrl: "https://example.com/math/chapter1",
  canonicalUrl: makeCanonicalUrl("https://example.com/math/chapter1"),
});

/**
 * Fixture 5: Plain text content (text/plain).
 */
export const FIXTURE_PLAIN_TEXT = makeAcquiredPage({
  body: "Learning Objectives:\nStudents will understand quadratic equations.\n\nDefinition: A quadratic equation is an equation of the form ax² + bx + c = 0.\n\nExercises:\n1. Solve x² - 4 = 0\n2. Find roots of x² + 2x + 1 = 0",
  contentType: "text/plain",
  contentHash: "plain-text-content-hash",
  headers: { "content-type": "text/plain; charset=utf-8" },
});

/**
 * Fixture 6: Educational content with different hash (for content change testing).
 */
export const FIXTURE_CHANGED_CONTENT = makeAcquiredPage({
  body: `
    <html>
      <head><title>Quadratic Equations - Updated</title></head>
      <body>
        <main>
          <h1>Quadratic Equations</h1>
          <h2>Learning Objectives</h2>
          <p>Students will be able to solve quadratic equations using factoring.</p>
          <p>Students will be able to complete the square.</p>
          <h2>Definitions</h2>
          <p>A quadratic equation is defined as an equation of the form ax² + bx + c = 0 where a ≠ 0.</p>
          <h2>Exercises</h2>
          <p>Exercises:</p>
          <p>1. Solve x² - 9 = 0</p>
          <p>2. Complete the square for x² + 6x + 5 = 0</p>
        </main>
      </body>
    </html>
  `,
  contentHash: "changed-content-hash-v2",
});

/**
 * Fixture 7: Content with only definitions (no objectives, no exercises).
 */
export const FIXTURE_DEFINITIONS_ONLY = makeAcquiredPage({
  body: `
    <html>
      <head><title>Mathematical Definitions</title></head>
      <body>
        <main>
          <h1>Key Definitions</h1>
          <p>A quadratic equation is defined as an equation of the form ax² + bx + c = 0.</p>
          <p>The vertex form refers to the expression a(x-h)² + k where (h,k) is the vertex.</p>
        </main>
      </body>
    </html>
  `,
  contentHash: "definitions-only-hash",
});

/**
 * Fixture 8: Content with only exercises (no objectives, no definitions).
 */
export const FIXTURE_EXERCISES_ONLY = makeAcquiredPage({
  body: `
    <html>
      <head><title>Practice Problems</title></head>
      <body>
        <main>
          <h1>Practice Problems</h1>
          <p>Exercises:</p>
          <p>1. Solve x² - 4x + 4 = 0</p>
          <p>2. Calculate the roots of 2x² + 4x + 2 = 0</p>
          <p>3. Find the vertex of y = x² - 6x + 9</p>
        </main>
      </body>
    </html>
  `,
  contentHash: "exercises-only-hash",
});

/**
 * All fixtures as an array for iteration tests.
 */
export const ALL_FIXTURES = [
  FIXTURE_STANDARD_EDUCATIONAL,
  FIXTURE_MINIMAL_CONTENT,
  FIXTURE_EMPTY_CONTENT,
  FIXTURE_RELATIVE_LINKS,
  FIXTURE_PLAIN_TEXT,
  FIXTURE_CHANGED_CONTENT,
  FIXTURE_DEFINITIONS_ONLY,
  FIXTURE_EXERCISES_ONLY,
];

export type FixtureName =
  | "STANDARD_EDUCATIONAL"
  | "MINIMAL_CONTENT"
  | "EMPTY_CONTENT"
  | "RELATIVE_LINKS"
  | "PLAIN_TEXT"
  | "CHANGED_CONTENT"
  | "DEFINITIONS_ONLY"
  | "EXERCISES_ONLY";

export const FIXTURE_MAP: Record<FixtureName, AcquiredPage> = {
  STANDARD_EDUCATIONAL: FIXTURE_STANDARD_EDUCATIONAL,
  MINIMAL_CONTENT: FIXTURE_MINIMAL_CONTENT,
  EMPTY_CONTENT: FIXTURE_EMPTY_CONTENT,
  RELATIVE_LINKS: FIXTURE_RELATIVE_LINKS,
  PLAIN_TEXT: FIXTURE_PLAIN_TEXT,
  CHANGED_CONTENT: FIXTURE_CHANGED_CONTENT,
  DEFINITIONS_ONLY: FIXTURE_DEFINITIONS_ONLY,
  EXERCISES_ONLY: FIXTURE_EXERCISES_ONLY,
};