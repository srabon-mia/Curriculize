/**
 * Tests for Phase 5 Content Cleaner
 */

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

describe("cleanPage - HTML", () => {
  test("extracts title from <title>", () => {
    const acquired = makeAcquiredPage({
      body: "<html><head><title>Page Title</title></head><body><p>Content</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.title).toBe("Page Title");
  });

  test("extracts title from <h1> if no title", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><h1>Main Heading</h1><p>Content</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.title).toBe("Main Heading");
  });

  test("extracts meta description", () => {
    const acquired = makeAcquiredPage({
      body: '<html><head><meta name="description" content="Page description"></head><body><p>Content</p></body></html>',
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.description).toBe("Page description");
  });

  test("extracts og:description", () => {
    const acquired = makeAcquiredPage({
      body: '<html><head><meta property="og:description" content="OG description"></head><body><p>Content</p></body></html>',
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.description).toBe("OG description");
  });

  test("removes script tags", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><script>alert('xss')</script><p>Content</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).not.toContain("alert");
    expect(cleaned.text).toContain("Content");
  });

  test("removes style tags", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><style>body { color: red; }</style><p>Content</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).not.toContain("color: red");
    expect(cleaned.text).toContain("Content");
  });

  test("removes nav, footer, header, aside", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><nav>Navigation</nav><main><p>Main content</p></main><footer>Footer</footer></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).not.toContain("Navigation");
    expect(cleaned.text).not.toContain("Footer");
    expect(cleaned.text).toContain("Main content");
  });

  test("removes boilerplate by class patterns", () => {
    const acquired = makeAcquiredPage({
      body: '<html><body><div class="cookie-banner">Cookie notice</div><main><p>Content</p></main></body></html>',
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).not.toContain("Cookie notice");
    expect(cleaned.text).toContain("Content");
  });

  test("removes boilerplate by id patterns", () => {
    const acquired = makeAcquiredPage({
      body: '<html><body><div id="newsletter-signup">Subscribe</div><main><p>Content</p></main></body></html>',
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).not.toContain("Subscribe");
    expect(cleaned.text).toContain("Content");
  });

  test("prefers main content area", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><nav>Nav</nav><main><article><p>Main article</p></article></main><footer>Footer</footer></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).toContain("Main article");
    expect(cleaned.text).not.toContain("Nav");
    expect(cleaned.text).not.toContain("Footer");
  });

  test("normalizes whitespace", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>  Hello    World  </p><p>  Foo\n\n\nBar  </p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    // Multiple newlines collapsed to single, spaces normalized
    expect(cleaned.text).toBe("Hello World Foo\nBar");
  });

  test("computes word count", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>One two three</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.wordCount).toBe(3);
  });

  test("computes cleaned hash", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>Test content</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.cleanedHash).toHaveLength(64); // SHA-256 hex
  });

  test("handles malformed HTML gracefully", () => {
    const acquired = makeAcquiredPage({
      body: "<html><body><p>Unclosed tag<div>Content</p></div></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.text).toContain("Content");
  });
});

describe("cleanPage - plain text", () => {
  test("handles text/plain content type", () => {
    const acquired = makeAcquiredPage({
      contentType: "text/plain",
      body: "  Line 1\n\n\nLine 2  \t\nLine 3  ",
    });
    const cleaned = cleanPage(acquired);
    // Multiple newlines collapsed to single, tabs to spaces, trailing spaces trimmed
    expect(cleaned.text).toBe("Line 1\nLine 2 \nLine 3");
    expect(cleaned.title).toBe("Line 1");
  });

  test("extracts first line as title for plain text", () => {
    const acquired = makeAcquiredPage({
      contentType: "text/plain",
      body: "Just content",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.title).toBe("Just content");
  });
});

describe("cleanPage - application/xhtml+xml", () => {
  test("treats as HTML", () => {
    const acquired = makeAcquiredPage({
      contentType: "application/xhtml+xml",
      body: "<html><head><title>XHTML Page</title></head><body><p>Content</p></body></html>",
    });
    const cleaned = cleanPage(acquired);
    expect(cleaned.title).toBe("XHTML Page");
    expect(cleaned.text).toContain("Content");
  });
});

describe("cleanPage - preserves acquiredPage reference", () => {
  test("cleanedPage contains acquiredPage reference", () => {
    const acquired = makeAcquiredPage();
    const cleaned = cleanPage(acquired);
    expect(cleaned.acquiredPage).toBe(acquired);
  });
});