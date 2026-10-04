/**
 * Shared Cleaned Document Pipeline
 * Single authoritative HTML processing pass that produces the cleaned structural representation
 * consumed by both Phase 5 serialization and Phase 6A structural extraction.
 */

import { parseHtmlSimple, removeBoilerplate, findMainContent, extractTitle, extractDescription, extractTitleFromText, serializeToText, normalizeWhitespace, countWords } from "./parseHtml";
import { sha256 } from "@/lib/deterministic/hash";
import type { AcquiredPage, CleanedPage } from "./types";

/** Metadata extracted from the original HTML (before cleaning mutates the tree) */
export interface DocumentMetadata {
  author: string | null;
  datePublished: string | null;
  language: string | null;
}

/** The cleaned document representation shared by Phase 5 and Phase 6A */
export interface CleanedDocument {
  /** The cleaned, main-content-selected tree */
  tree: ReturnType<typeof parseHtmlSimple>;
  /** Title extracted from original tree (Phase 5 behavior) */
  title: string;
  /** Description extracted from original tree (Phase 5 behavior) */
  description: string | null;
  /** Metadata extracted from original tree (single parse) */
  metadata: DocumentMetadata;
  /** Source acquisition reference */
  acquiredPage: AcquiredPage;
}

/**
 * Build the cleaned document from an acquired page.
 * This is the SINGLE HTML processing pass - parse, extract metadata, clean, select main content.
 */
export function buildCleanedDocument(acquired: AcquiredPage): CleanedDocument {
  // Plain text handling (matches Phase 5 behavior)
  if (acquired.contentType === "text/plain") {
    const text = normalizeWhitespace(acquired.body);
    const title = extractTitleFromText(text) || acquired.canonicalUrl.parsed.hostname;
    return {
      tree: { tagName: "text", attributes: {}, children: [text] },
      title,
      description: null,
      metadata: { author: null, datePublished: null, language: null },
      acquiredPage: acquired,
    };
  }

  // HTML/XHTML: parse once
  const originalRoot = parseHtmlSimple(acquired.body);

  // Extract title/description from ORIGINAL tree (Phase 5 behavior)
  // Title: <title> → <h1> → "" (NO hostname fallback for HTML)
  const title = extractTitle(originalRoot);
  const description = extractDescription(originalRoot);

  // Extract metadata from ORIGINAL tree (single parse, before cleaning mutates it)
  const metadata = extractMetadata(originalRoot);

  // Apply cleaning (mutates the tree)
  removeBoilerplate(originalRoot);

  // Select main content
  const mainNode = findMainContent(originalRoot);
  const tree = mainNode || originalRoot;

  return { tree, title, description, metadata, acquiredPage: acquired };
}

/** Serialize cleaned document to Phase 5 CleanedPage (preserves exact existing behavior) */
export function serializeCleanedDocument(doc: CleanedDocument): CleanedPage {
  const text = normalizeWhitespace(serializeToText(doc.tree));
  const cleanedHash = sha256(text);

  return {
    acquiredPage: doc.acquiredPage,
    text,
    title: doc.title,
    description: doc.description,
    wordCount: countWords(text),
    cleanedHash,
  };
}

/** Extract metadata from the original HTML tree (single pass) */
function extractMetadata(root: ReturnType<typeof parseHtmlSimple>): DocumentMetadata {
  let author: string | null = null;
  let datePublished: string | null = null;
  let language: string | null = null;

  function walk(node: ReturnType<typeof parseHtmlSimple>): void {
    // Author metadata
    if (node.tagName === "meta") {
      const name = node.attributes.name || node.attributes.property || "";
      if ((name === "author" || name === "article:author" || name === "byline") && !author) {
        author = node.attributes.content || null;
      }
      if ((name === "article:published_time" || name === "pubdate" || name === "datePublished") && !datePublished) {
        datePublished = node.attributes.content || node.attributes.datetime || null;
      }
    }

    // html[lang]
    if (node.tagName === "html" && node.attributes.lang && !language) {
      language = node.attributes.lang;
    }

    // time[datetime]
    if (node.tagName === "time" && node.attributes.datetime && !datePublished) {
      datePublished = node.attributes.datetime;
    }

    // meta[http-equiv=content-language]
    if (node.tagName === "meta" && node.attributes["http-equiv"] === "content-language" && !language) {
      language = node.attributes.content || null;
    }

    for (const child of node.children) {
      if (typeof child !== "string") walk(child);
    }
  }

  walk(root);
  return { author, datePublished, language };
}