/**
 * Tests for Phase 5/6A Shared Cleaned Document Pipeline
 */

import { buildCleanedDocument, serializeCleanedDocument } from "../cleanedDocument";
import { extractStructuredContentFromDoc } from "../structuredExtract";
import { extractEducationalEvidence } from "@/lib/evidence/deterministic";
import { cleanPage } from "../cleaner";
import type { AcquiredPage } from "../types";

function makeAcquiredPage(overrides: Partial<AcquiredPage> = {}): AcquiredPage {
  return {
    finalUrl: "https://example.com/page",
    canonicalUrl: { url: "https://example.com/page", parsed: new URL("https://example.com/page"), original: "https://example.com/page" },
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<html><body><h1>Test</h1><p>Content</p></body></html>",
    contentType: "text/html",
    charset: "utf-8",
    contentHash: "abc123",
    acquiredAt: new Date().toISOString(),
    redirectChain: [],
    resolvedIps: { ipv4: ["93.184.216.34"], ipv6: [] },
    ...overrides,
  };
}

describe("buildCleanedDocument", () => {
  describe("HTML processing", () => {
    test("parses and cleans HTML", () => {
      const acquired = makeAcquiredPage({
        body: "<html><head><title>Page Title</title></head><body><nav>Navigation</nav><main><h1>Main Content</h1><p>Paragraph text</p></main><footer>Footer</footer></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.title).toBe("Page Title");
      expect(doc.tree.tagName).toBe("main");
    });

    test("extracts title from <title> tag", () => {
      const acquired = makeAcquiredPage({
        body: "<html><head><title>Custom Title</title></head><body><p>Content</p></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.title).toBe("Custom Title");
    });

    test("falls back to <h1> when no title tag", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><h1>Heading Title</h1><p>Content</p></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.title).toBe("Heading Title");
    });

    test("falls back to empty string when no title or h1", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><p>Content</p></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.title).toBe("");
    });

    test("extracts meta description", () => {
      const acquired = makeAcquiredPage({
        body: '<html><head><meta name="description" content="Page description"></head><body><p>Content</p></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.description).toBe("Page description");
    });

    test("extracts og:description", () => {
      const acquired = makeAcquiredPage({
        body: '<html><head><meta property="og:description" content="OG description"></head><body><p>Content</p></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.description).toBe("OG description");
    });

    test("removes script and style tags", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><script>alert('xss')</script><style>body { color: red; }</style><p>Content</p></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      const text = serializeCleanedDocument(doc).text;
      expect(text).not.toContain("alert");
      expect(text).not.toContain("color: red");
      expect(text).toContain("Content");
    });

    test("removes nav, footer, header, aside", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><nav>Navigation</nav><main><p>Main content</p></main><footer>Footer</footer></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      const text = serializeCleanedDocument(doc).text;
      expect(text).not.toContain("Navigation");
      expect(text).not.toContain("Footer");
      expect(text).toContain("Main content");
    });

    test("removes boilerplate by class patterns", () => {
      const acquired = makeAcquiredPage({
        body: '<html><body><div class="cookie-banner">Cookie notice</div><main><p>Content</p></main></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      const text = serializeCleanedDocument(doc).text;
      expect(text).not.toContain("Cookie notice");
      expect(text).toContain("Content");
    });

    test("removes boilerplate by id patterns", () => {
      const acquired = makeAcquiredPage({
        body: '<html><body><div id="newsletter-signup">Subscribe</div><main><p>Content</p></main></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      const text = serializeCleanedDocument(doc).text;
      expect(text).not.toContain("Subscribe");
      expect(text).toContain("Content");
    });

    test("prefers main content area", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><nav>Nav</nav><main><article><p>Main article</p></article></main><footer>Footer</footer></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      const text = serializeCleanedDocument(doc).text;
      expect(text).toContain("Main article");
      expect(text).not.toContain("Nav");
      expect(text).not.toContain("Footer");
    });

    test("normalizes whitespace", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><p>  Hello    World  </p><p>  Foo\n\n\nBar  </p></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      const cleaned = serializeCleanedDocument(doc);
      // Phase 5 serialization joins text with spaces; newlines only from explicit \n in source
      expect(cleaned.text).toBe("Hello World Foo\nBar");
    });

    test("handles malformed HTML gracefully", () => {
      const acquired = makeAcquiredPage({
        body: "<html><body><p>Unclosed tag<div>Content</p></div></body></html>",
      });
      const doc = buildCleanedDocument(acquired);
      const text = serializeCleanedDocument(doc).text;
      expect(text).toContain("Content");
    });
  });

  describe("plain text processing", () => {
    test("handles text/plain content type", () => {
      const acquired = makeAcquiredPage({
        contentType: "text/plain",
        body: "  Line 1\n\n\nLine 2  \t\nLine 3  ",
      });
      const doc = buildCleanedDocument(acquired);
      const cleaned = serializeCleanedDocument(doc);
      expect(cleaned.text).toBe("Line 1\nLine 2 \nLine 3");
      expect(cleaned.title).toBe("Line 1");
    });

    test("extracts first line as title for plain text", () => {
      const acquired = makeAcquiredPage({
        contentType: "text/plain",
        body: "Just content",
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.title).toBe("Just content");
    });
  });

  describe("metadata extraction", () => {
    test("extracts author from meta[name=author]", () => {
      const acquired = makeAcquiredPage({
        body: '<html><head><meta name="author" content="John Doe"></head><body><p>Content</p></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.metadata.author).toBe("John Doe");
    });

    test("extracts author from meta[property=article:author]", () => {
      const acquired = makeAcquiredPage({
        body: '<html><head><meta property="article:author" content="Jane Smith"></head><body><p>Content</p></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.metadata.author).toBe("Jane Smith");
    });

    test("extracts datePublished from meta[property=article:published_time]", () => {
      const acquired = makeAcquiredPage({
        body: '<html><head><meta property="article:published_time" content="2024-01-15T10:00:00Z"></head><body><p>Content</p></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.metadata.datePublished).toBe("2024-01-15T10:00:00Z");
    });

    test("extracts language from html[lang]", () => {
      const acquired = makeAcquiredPage({
        body: '<html lang="en"><body><p>Content</p></body></html>',
      });
      const doc = buildCleanedDocument(acquired);
      expect(doc.metadata.language).toBe("en");
    });
  });
});

describe("serializeCleanedDocument", () => {
  test("produces CleanedPage with correct fields", () => {
    const acquired = makeAcquiredPage({
      body: "<html><head><title>Test</title></head><body><p>Content here</p></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const cleaned = serializeCleanedDocument(doc);

    expect(cleaned.acquiredPage).toBe(acquired);
    expect(cleaned.title).toBe("Test");
    expect(cleaned.text).toContain("Content here");
    expect(cleaned.wordCount).toBeGreaterThan(0);
    expect(cleaned.cleanedHash).toHaveLength(64);
  });

  test("cleanedHash is deterministic", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>Test content</p></body></html>",
    });
    const doc1 = buildCleanedDocument(acquired);
    const doc2 = buildCleanedDocument(acquired);
    const cleaned1 = serializeCleanedDocument(doc1);
    const cleaned2 = serializeCleanedDocument(doc2);
    expect(cleaned1.cleanedHash).toBe(cleaned2.cleanedHash);
  });
});

describe("extractStructuredContentFromDoc (Phase 6A)", () => {
  test("extracts headings with correct levels", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><h1>H1 Title</h1><h2>H2 Title</h2><h3>H3 Title</h3></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.headings).toHaveLength(3);
    expect(structured.headings[0]).toEqual({ level: 1, text: "H1 Title" });
    expect(structured.headings[1]).toEqual({ level: 2, text: "H2 Title" });
    expect(structured.headings[2]).toEqual({ level: 3, text: "H3 Title" });
  });

  test("headings are NOT duplicated in blocks", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><h1>Heading</h1><p>Paragraph</p></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    const headingTexts = structured.headings.map(h => h.text);
    const blockTexts = structured.blocks.map(b => b.text);
    expect(headingTexts).toContain("Heading");
    expect(blockTexts).not.toContain("Heading");
  });

  test("extracts text blocks from paragraph tags", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>First paragraph</p><p>Second paragraph</p></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.blocks).toHaveLength(2);
    expect(structured.blocks[0]).toEqual({ text: "First paragraph", tagName: "p" });
    expect(structured.blocks[1]).toEqual({ text: "Second paragraph", tagName: "p" });
  });

  test("extracts list items as text blocks", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><ul><li>Item 1</li><li>Item 2</li></ul></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    const liBlocks = structured.blocks.filter(b => b.tagName === "li");
    expect(liBlocks).toHaveLength(2);
    expect(liBlocks[0].text).toBe("Item 1");
    expect(liBlocks[1].text).toBe("Item 2");
  });

  test("nested lists do not duplicate content", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><ul><li>Parent<li>Child</li></li></ul></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    // Each li should be extracted once
    const liBlocks = structured.blocks.filter(b => b.tagName === "li");
    expect(liBlocks.length).toBeGreaterThanOrEqual(2);
  });

  test("extracts blockquote as text block", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><blockquote>Quoted text</blockquote></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.blocks).toHaveLength(1);
    expect(structured.blocks[0]).toEqual({ text: "Quoted text", tagName: "blockquote" });
  });

  test("extracts code and pre blocks", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><pre>code block</pre><p>inline <code>code</code> here</p></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    const preBlock = structured.blocks.find(b => b.tagName === "pre");
    expect(preBlock).toBeDefined();
    expect(preBlock?.text).toBe("code block");

    // inline code inside p should be part of paragraph text
    const pBlock = structured.blocks.find(b => b.tagName === "p");
    expect(pBlock?.text).toContain("code");
  });

  test("structural containers (div, section, article) do not create blocks", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><div><section><article><p>Deep content</p></article></section></div></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    // Only the p should create a block
    expect(structured.blocks).toHaveLength(1);
    expect(structured.blocks[0].tagName).toBe("p");
  });

  test("extracts MIT-style instructional text from divs and ignores navigation", () => {
    const nav = Array.from({ length: 25 }, (_, index) =>
      `<h2>Course navigation ${index + 1}</h2><a href="/week-${index + 1}">Week ${index + 1}</a>`
    ).join("");
    const acquired = makeAcquiredPage({
      body: `<html><body><nav>${nav}</nav><aside class="sidebar">Course menu</aside><main>
        <h1>Differential Equations</h1>
        <div><span>For a first-order differential equation,</span> multiplying by the integrating factor gives a derivative of a product. Integrating both sides yields the general solution.</div>
        <div><h2>Solution method</h2><p>Apply the initial condition to determine the constant.</p></div>
      </main></body></html>`,
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);
    const evidence = extractEducationalEvidence(structured, {
      topicTitle: "Differential Equations",
      conceptDescription: "Solving first-order differential equations with an integrating factor",
    });

    expect(doc.tree.tagName).toBe("main");
    expect(structured.headings).toHaveLength(2);
    expect(structured.statistics.paragraphCount).toBe(1);
    expect(structured.blocks.some((block) => block.tagName === "div" && block.text.includes("integrating factor"))).toBe(true);
    expect(structured.blocks.map((block) => block.text).join(" ")).not.toContain("Course navigation");
    expect(evidence.interpreted.targetRelevantEvidence?.length).toBeGreaterThan(0);
  });

  test("heading-heavy lesson indexes do not turn headings or links into lesson blocks", () => {
    const index = Array.from({ length: 26 }, (_, index) =>
      `<h2>Lecture ${index + 1}</h2><a href="/lecture-${index + 1}">Slides and notes</a>`
    ).join("");
    const acquired = makeAcquiredPage({
      body: `<html><head><title>Differential Equations Course</title></head><body><main><h1>Differential Equations</h1>${index}</main></body></html>`,
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);
    const evidence = extractEducationalEvidence(structured, { topicTitle: "Differential Equations" });

    expect(structured.statistics.headingCount).toBe(27);
    expect(structured.blocks).toHaveLength(0);
    expect(structured.links).toHaveLength(26);
    expect(evidence.interpreted.targetRelevantEvidence).toEqual([]);
  });

  test("extracts substantial instructional prose in generic div containers", () => {
    const acquired = makeAcquiredPage({
      body: `<html><body><main><div class="lesson-content"><div>When solving a differential equation, first separate the variables. Integrate each side and apply the initial condition to find the particular solution.</div></div></main></body></html>`,
    });
    const structured = extractStructuredContentFromDoc(buildCleanedDocument(acquired));

    expect(structured.blocks).toEqual([{
      tagName: "div",
      text: "When solving a differential equation, first separate the variables. Integrate each side and apply the initial condition to find the particular solution.",
    }]);
  });

  test("extracts links with resolved hrefs", () => {
    const acquired = makeAcquiredPage({
      body: '<html><body><p><a href="/page1">Link 1</a></p><p><a href="https://other.com/page2">Link 2</a></p></body></html>',
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.links).toHaveLength(2);
    expect(structured.links[0].href).toBe("https://example.com/page1");
    expect(structured.links[0].text).toBe("Link 1");
    expect(structured.links[1].href).toBe("https://other.com/page2");
    expect(structured.links[1].text).toBe("Link 2");
  });

  test("filters out non-http/https links", () => {
    const acquired = makeAcquiredPage({
      body: '<html><body><a href="javascript:alert(1)">JS</a><a href="mailto:test@test.com">Email</a><a href="#fragment">Fragment</a><a href="/valid">Valid</a></body></html>',
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.links).toHaveLength(1);
    expect(structured.links[0].href).toBe("https://example.com/valid");
  });

  test("computes statistics correctly", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><h1>Title</h1><h2>Subtitle</h2><p>Paragraph one</p><p>Paragraph two</p><ul><li>Item</li></ul></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.statistics.headingCount).toBe(2);
    expect(structured.statistics.headingCountsByLevel[1]).toBe(1);
    expect(structured.statistics.headingCountsByLevel[2]).toBe(1);
    expect(structured.statistics.paragraphCount).toBe(2);
    expect(structured.statistics.linkCount).toBe(0);
  });

  test("wordCount matches Phase 5 wordCount", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>Hello world test</p></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const cleaned = serializeCleanedDocument(doc);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.statistics.wordCount).toBe(cleaned.wordCount);
  });

  test("deterministic: same input produces identical output", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><h1>Test</h1><p>Content</p><a href='/link'>Link</a></body></html>",
    });
    const doc1 = buildCleanedDocument(acquired);
    const doc2 = buildCleanedDocument(acquired);
    const structured1 = extractStructuredContentFromDoc(doc1);
    const structured2 = extractStructuredContentFromDoc(doc2);

    expect(JSON.stringify(structured1)).toBe(JSON.stringify(structured2));
  });

  test("plain text produces sparse but valid structure", () => {
    const acquired = makeAcquiredPage({
      contentType: "text/plain",
      body: "Line 1\nLine 2\nLine 3",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.headings).toHaveLength(0);
    expect(structured.blocks).toHaveLength(1);
    expect(structured.blocks[0].tagName).toBe("text");
    expect(structured.links).toHaveLength(0);
    expect(structured.statistics.headingCount).toBe(0);
    expect(structured.statistics.linkCount).toBe(0);
  });

  test("empty content produces empty structure", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body></body></html>",
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.headings).toHaveLength(0);
    expect(structured.blocks).toHaveLength(0);
    expect(structured.links).toHaveLength(0);
    expect(structured.statistics.wordCount).toBe(0);
  });

  test("link title attribute preserved", () => {
    const acquired = makeAcquiredPage({
      body: '<html><body><a href="/page" title="Tooltip">Link</a></body></html>',
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.links[0].title).toBe("Tooltip");
  });

  test("removes fragment from resolved URLs", () => {
    const acquired = makeAcquiredPage({
      body: '<html><body><a href="/page#section">Link</a></body></html>',
    });
    const doc = buildCleanedDocument(acquired);
    const structured = extractStructuredContentFromDoc(doc);

    expect(structured.links[0].href).toBe("https://example.com/page");
  });
});

describe("Phase 5 regression - cleanPage behavior unchanged", () => {
  test("cleanPage produces same output as before refactor", () => {
    const acquired = makeAcquiredPage({
      body: "<html><head><title>Test Page</title></head><body><nav>Nav</nav><main><h1>Content</h1><p>Text</p></main><footer>Footer</footer></body></html>",
    });
    const cleaned = cleanPage(acquired);

    expect(cleaned.title).toBe("Test Page");
    expect(cleaned.text).toContain("Content");
    expect(cleaned.text).toContain("Text");
    expect(cleaned.text).not.toContain("Nav");
    expect(cleaned.text).not.toContain("Footer");
    expect(cleaned.wordCount).toBeGreaterThan(0);
    expect(cleaned.cleanedHash).toHaveLength(64);
  });
});
