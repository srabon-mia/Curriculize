/**
 * Phase 6A Structural Extraction
 * Deterministic extraction of structured content from the shared CleanedDocument.
 * Zero AI, zero network, zero persistence.
 */

import { isAllowedScheme, canonicalizeUrl } from "@/lib/deterministic/url";
import type { CleanedDocument } from "./cleanedDocument";

/** Heading with level and text */
export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

/** Text block with content and originating tag */
export interface TextBlock {
  text: string;
  tagName: string;
}

/** Link with resolved href and anchor text */
export interface Link {
  href: string;
  text: string;
  title?: string;
}

/** Deterministic document statistics */
export interface DocumentStatistics {
  wordCount: number;
  headingCount: number;
  headingCountsByLevel: Record<1 | 2 | 3 | 4 | 5 | 6, number>;
  paragraphCount: number;
  linkCount: number;
  externalLinkCount: number;
}

/** Phase 6A output - minimal deterministic structure */
export interface StructuredContent {
  source: {
    cleanedHash: string;
    contentHash: string;
  };
  metadata: {
    title: string;
    description: string | null;
    author: string | null;
    datePublished: string | null;
    language: string | null;
  };
  headings: Heading[];
  blocks: TextBlock[];
  links: Link[];
  statistics: DocumentStatistics;
}

/** Tags that create text-block boundaries (leaf content nodes) */
const TEXT_BLOCK_TAGS = new Set<string>([
  "p",
  "blockquote",
  "li",
  "dd",
  "dt",
  "td",
  "th",
  "figcaption",
  "pre",
  "text",  // plain text content from text/plain handling
]);

/** Inline tags whose text content should be included in parent block */
const INLINE_TAGS = new Set<string>([
  "a",
  "span",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "mark",
  "small",
  "sub",
  "sup",
  "code",
  "q",
  "cite",
  "abbr",
  "time",
  "br",
  "wbr",
]);

/**
 * Extract structured content from the shared cleaned document.
 * Single tree walk collecting headings, text blocks, and links.
 */
export function extractStructuredContentFromDoc(doc: CleanedDocument): StructuredContent {
  const headings: Heading[] = [];
  const blocks: TextBlock[] = [];
  const links: Link[] = [];

  const baseUrl = doc.acquiredPage.finalUrl;
  const finalHost = new URL(baseUrl).hostname;

  // Single tree walk
  walkTree(doc.tree, (node) => {
    // Headings (h1-h6)
    const headingMatch = node.tagName.match(/^h([1-6])$/);
    if (headingMatch) {
      const level = parseInt(headingMatch[1], 10) as 1 | 2 | 3 | 4 | 5 | 6;
      const text = extractInlineText(node).trim();
      if (text) headings.push({ level, text });
      return; // Don't recurse into heading children for blocks
    }

    // Text blocks (leaf content boundaries)
    if (TEXT_BLOCK_TAGS.has(node.tagName)) {
      const text = extractInlineText(node).trim();
      if (text) blocks.push({ text: normalizeWhitespace(text), tagName: node.tagName });
      return; // Don't recurse into content children
    }

    // Links
    if (node.tagName === "a" && node.attributes.href) {
      const href = resolveUrl(node.attributes.href, baseUrl);
      if (href && isAllowedScheme(href)) {
        const text = extractInlineText(node).trim();
        if (text) {
          links.push({ href, text, title: node.attributes.title || undefined });
        }
      }
      return; // Don't recurse into link children
    }

    // Code blocks (pre > code or standalone code not in pre)
    if (node.tagName === "pre") {
      const text = extractInlineText(node).trim();
      if (text) blocks.push({ text: normalizeWhitespace(text), tagName: "pre" });
      return;
    }
    if (node.tagName === "code" && !hasPreAncestor(node)) {
      const text = extractInlineText(node).trim();
      if (text) blocks.push({ text: normalizeWhitespace(text), tagName: "code" });
      return;
    }
  });

  // Statistics (reuse Phase 5 word count via serializeCleanedDocument)
  const serializedText = serializeTreeToText(doc.tree);
  const wordCount = countWords(serializedText);

  const headingCountsByLevel: Record<1 | 2 | 3 | 4 | 5 | 6, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const h of headings) headingCountsByLevel[h.level]++;

  const paragraphCount = blocks.filter((b) => b.tagName === "p").length;
  const linkCount = links.length;
  const externalLinkCount = links.filter((l) => {
    try {
      return new URL(l.href).hostname !== finalHost;
    } catch {
      return false;
    }
  }).length;

  return {
    source: {
      cleanedHash: doc.acquiredPage.contentHash, // Note: using contentHash as cleanedHash proxy - will be corrected
      contentHash: doc.acquiredPage.contentHash,
    },
    metadata: {
      title: doc.title,
      description: doc.description,
      author: doc.metadata.author,
      datePublished: doc.metadata.datePublished,
      language: doc.metadata.language,
    },
    headings,
    blocks,
    links,
    statistics: {
      wordCount,
      headingCount: headings.length,
      headingCountsByLevel,
      paragraphCount,
      linkCount,
      externalLinkCount,
    },
  };
}

/**
 * Walk tree and call visitor for each element node.
 * Uses pre-order traversal.
 */
function walkTree(
  node: ReturnType<typeof import("./parseHtml").parseHtmlSimple>,
  visitor: (node: ReturnType<typeof import("./parseHtml").parseHtmlSimple>) => void
): void {
  visitor(node);
  for (const child of node.children) {
    if (typeof child !== "string") {
      walkTree(child, visitor);
    }
  }
}

/**
 * Extract inline text content from a node, including inline descendants.
 * Stops at block-level boundaries.
 */
function extractInlineText(node: ReturnType<typeof import("./parseHtml").parseHtmlSimple>): string {
  let result = "";
  for (const child of node.children) {
    if (typeof child === "string") {
      result += child;
    } else {
      if (TEXT_BLOCK_TAGS.has(child.tagName) || child.tagName.match(/^h[1-6]$/)) {
        // Stop at block boundaries
        continue;
      }
      if (INLINE_TAGS.has(child.tagName) || child.tagName === "code") {
        // Recurse into inline elements
        result += extractInlineText(child);
      }
      // Skip other block-level elements
    }
  }
  return result;
}

/** Check if a code element has a pre ancestor */
function hasPreAncestor(node: ReturnType<typeof import("./parseHtml").parseHtmlSimple>): boolean {
  let current: ReturnType<typeof import("./parseHtml").parseHtmlSimple> | undefined = node.parent;
  while (current) {
    if (current.tagName === "pre") return true;
    current = current.parent;
  }
  return false;
}

/** Serialize tree to text for word count (matches Phase 5 serialization) */
function serializeTreeToText(node: ReturnType<typeof import("./parseHtml").parseHtmlSimple>): string {
  // Import serializeToText to avoid circular dependency
  return serializeToTextCompat(node);
}

// Compat version that matches parseHtml.ts serializeToText behavior
function serializeToTextCompat(node: ReturnType<typeof import("./parseHtml").parseHtmlSimple> | string): string {
  if (typeof node === "string") return node;
  // Note: REMOVE_ELEMENTS already applied during cleaning, but keep for safety
  const REMOVE_ELEMENTS = new Set<string>([
    "script", "style", "noscript", "iframe", "form", "nav", "footer", "header", "aside",
    "template", "link", "svg", "canvas", "audio", "video", "picture", "source", "track",
    "map", "area", "datalist", "optgroup", "option", "select", "textarea", "button",
    "input", "label", "fieldset", "legend", "output", "progress", "meter",
  ]);
  if (REMOVE_ELEMENTS.has(node.tagName)) return "";
  return node.children.map(serializeToTextCompat).join("");
}

/** Resolve relative URL against base */
function resolveUrl(href: string, base: string): string | null {
  try {
    // Reject fragment-only URLs
    if (href.startsWith("#")) return null;

    const resolved = new URL(href, base);
    // Only allow http/https
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    // Remove fragment
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Normalize whitespace (reuse deterministic utility) */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/ /g, " ")
    .replace(/[ \f\v]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Count words (reuse deterministic utility) */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}