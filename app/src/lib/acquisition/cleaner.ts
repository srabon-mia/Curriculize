/**
 * Phase 5 Content Cleaner
 * Deterministic HTML/text cleaning - removes boilerplate, extracts text.
 * No AI, no external dependencies, uses lightweight parsing.
 */

import { sha256 } from "@/lib/deterministic/hash";
import { createMalformedResponseError, AcquisitionError, isAcquisitionError } from "./errors";
import type { AcquiredPage, CleanedPage } from "./types";

/** Elements to remove entirely (boilerplate) - but NOT meta (needed for description) */
const REMOVE_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "form",
  "nav",
  "footer",
  "header",
  "aside",
  "template",
  "link",
  "svg",
  "canvas",
  "audio",
  "video",
  "picture",
  "source",
  "track",
  "map",
  "area",
  "datalist",
  "optgroup",
  "option",
  "select",
  "textarea",
  "button",
  "input",
  "label",
  "fieldset",
  "legend",
  "output",
  "progress",
  "meter",
]);

/** Class/id patterns that indicate boilerplate (conservative) */
const BOILERPLATE_SELECTORS = [
  // Cookie banners
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='consent']",
  "[id*='consent']",
  // Popups/modals
  "[class*='popup']",
  "[id*='popup']",
  "[class*='modal']",
  "[id*='modal']",
  "[class*='overlay']",
  "[id*='overlay']",
  // Newsletter signups
  "[class*='newsletter']",
  "[id*='newsletter']",
  "[class*='subscribe']",
  "[id*='subscribe']",
  // Advertisements
  "[class*='advert']",
  "[id*='advert']",
  "[class*='ad-']",
  "[id*='ad-']",
  "[class*='ads-']",
  "[id*='ads-']",
  "[class*='sponsor']",
  "[id*='sponsor']",
  // Social sharing
  "[class*='share']",
  "[id*='share']",
  "[class*='social']",
  "[id*='social']",
  // Navigation/menus
  "[class*='navbar']",
  "[id*='navbar']",
  "[class*='menu']",
  "[id*='menu']",
  "[class*='sidebar']",
  "[id*='sidebar']",
  // Footers
  "[class*='footer']",
  "[id*='footer']",
  // Headers
  "[class*='header']",
  "[id*='header']",
  // Comments
  "[class*='comment']",
  "[id*='comment']",
  // Related/recirculation
  "[class*='related']",
  "[id*='related']",
  "[class*='recommended']",
  "[id*='recommended']",
];

/** Preferred main content selectors (in priority order) */
const MAIN_CONTENT_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  "#main-content",
  "#content",
  ".main-content",
  ".content",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".page-content",
  "body",
];

/** Simple HTML parser using regex - parses tags with attributes */
interface SimpleNode {
  tagName: string;
  attributes: Record<string, string>;
  children: (SimpleNode | string)[];
  parent?: SimpleNode;
}

function parseHtmlSimple(html: string): SimpleNode {
  const root: SimpleNode = { tagName: "root", attributes: {}, children: [] };
  let current = root;
  const stack: SimpleNode[] = [root];

  // Regex to match tags with attributes: <tag attr="value" ...> or </tag>
  const tagRegex = /<(\/?)([a-zA-Z0-9:-]+)((?:\s+[a-zA-Z0-9:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const [fullTag, isClosing, tagName, attrsStr] = match;

    // Add text before this tag
    if (match.index > lastIndex) {
      const text = html.slice(lastIndex, match.index);
      if (text.trim()) current.children.push(text);
    }

    if (isClosing) {
      // Closing tag - pop stack
      if (stack.length > 1) stack.pop();
      current = stack[stack.length - 1];
    } else {
      // Opening tag - parse attributes
      const attributes: Record<string, string> = {};
      const attrRegex = /([a-zA-Z0-9:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
        const [, name, , doubleQuoted, singleQuoted, unquoted] = attrMatch;
        attributes[name.toLowerCase()] = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      }

      const node: SimpleNode = { tagName: tagName.toLowerCase(), attributes, children: [], parent: current };
      current.children.push(node);

      // Self-closing tags (void elements)
      const isSelfClosing = attrsStr.endsWith("/") ||
        ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(tagName.toLowerCase());

      if (!isSelfClosing) {
        stack.push(node);
        current = node;
      }
    }
    lastIndex = tagRegex.lastIndex;
  }

  // Remaining text
  if (lastIndex < html.length) {
    const text = html.slice(lastIndex);
    if (text.trim()) current.children.push(text);
  }

  return root;
}

/** Serialize simple node tree back to text */
function serializeToText(node: SimpleNode | string): string {
  if (typeof node === "string") return node;
  if (REMOVE_ELEMENTS.has(node.tagName)) return "";
  return node.children.map(serializeToText).join("");
}

/** Remove boilerplate elements by selector patterns */
function removeBoilerplate(node: SimpleNode): void {
  // Check if this node matches boilerplate patterns
  const classAttr = node.attributes.class || "";
  const idAttr = node.attributes.id || "";

  for (const selector of BOILERPLATE_SELECTORS) {
    if (selector.startsWith("[class*=")) {
      const pattern = selector.slice(8, -1); // Remove [class*=" and "]
      if (classAttr.includes(pattern)) return;
    }
    if (selector.startsWith("[id*=")) {
      const pattern = selector.slice(5, -1); // Remove [id*=" and "]
      if (idAttr.includes(pattern)) return;
    }
  }

  // Recurse into children
  for (const child of node.children) {
    if (typeof child !== "string") {
      removeBoilerplate(child);
    }
  }
}

/** Find the main content node */
function findMainContent(node: SimpleNode): SimpleNode | null {
  for (const selector of MAIN_CONTENT_SELECTORS) {
    const found = findBySelector(node, selector);
    if (found) return found;
  }
  return null;
}

/** Simple selector matching (tag, #id, .class) */
function findBySelector(node: SimpleNode, selector: string): SimpleNode | null {
  if (selector.startsWith("#")) {
    const id = selector.slice(1);
    return findById(node, id);
  }
  if (selector.startsWith(".")) {
    const className = selector.slice(1);
    return findByClass(node, className);
  }
  // Tag selector
  return findByTag(node, selector);
}

function findById(node: SimpleNode, id: string): SimpleNode | null {
  if (node.attributes.id === id) return node;
  for (const child of node.children) {
    if (typeof child !== "string") {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function findByClass(node: SimpleNode, className: string): SimpleNode | null {
  const classes = (node.attributes.class || "").split(/\s+/);
  if (classes.includes(className)) return node;
  for (const child of node.children) {
    if (typeof child !== "string") {
      const found = findByClass(child, className);
      if (found) return found;
    }
  }
  return null;
}

function findByTag(node: SimpleNode, tag: string): SimpleNode | null {
  if (node.tagName.toLowerCase() === tag.toLowerCase()) return node;
  for (const child of node.children) {
    if (typeof child !== "string") {
      const found = findByTag(child, tag);
      if (found) return found;
    }
  }
  return null;
}

/** Extract title from HTML */
function extractTitle(node: SimpleNode): string {
  const titleNode = findByTag(node, "title");
  if (titleNode) {
    return titleNode.children.map(serializeToText).join("").trim();
  }
  // Try h1
  const h1Node = findByTag(node, "h1");
  if (h1Node) {
    return h1Node.children.map(serializeToText).join("").trim();
  }
  return "";
}

/** Extract meta description */
function extractDescription(node: SimpleNode): string | null {
  // Find meta[name="description"] or meta[property="og:description"]
  function findMeta(n: SimpleNode): string | null {
    if (n.tagName === "meta") {
      const name = n.attributes.name || n.attributes.property || "";
      if (name === "description" || name === "og:description") {
        return n.attributes.content || null;
      }
    }
    for (const child of n.children) {
      if (typeof child !== "string") {
        const found = findMeta(child);
        if (found) return found;
      }
    }
    return null;
  }
  return findMeta(node);
}

/** Normalize whitespace in text */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/ /g, " ") // &nbsp;
    .replace(/[ \f\v]+/g, " ")
    .replace(/\n{2,}/g, "\n")  // Collapse multiple newlines to single
    .trim();
}

/** Count words in text */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Main cleaning function - converts AcquiredPage to CleanedPage
 * Handles HTML and plain text content types.
 */
export function cleanPage(acquired: AcquiredPage): CleanedPage {
  let text: string;
  let title = "";
  let description: string | null = null;

  if (acquired.contentType === "text/plain") {
    // Plain text - minimal processing
    text = normalizeWhitespace(acquired.body);
    title = extractTitleFromText(text) || acquired.canonicalUrl.parsed.hostname;
  } else if (acquired.contentType === "text/html" || acquired.contentType === "application/xhtml+xml") {
    // HTML - parse and clean
    try {
      const root = parseHtmlSimple(acquired.body);

      // Extract title and description before cleaning
      title = extractTitle(root);
      description = extractDescription(root);

      // Remove boilerplate elements
      removeBoilerplate(root);

      // Find main content
      const mainNode = findMainContent(root);
      const contentNode = mainNode || root;

      // Serialize to text
      text = normalizeWhitespace(serializeToText(contentNode));
    } catch {
      // Fallback: strip tags with regex
      text = normalizeWhitespace(acquired.body.replace(/<[^>]+>/g, " "));
      title = acquired.canonicalUrl.parsed.hostname;
    }
  } else {
    // Unsupported but we got here - fallback
    text = normalizeWhitespace(acquired.body);
    title = acquired.canonicalUrl.parsed.hostname;
  }

  const cleanedHash = sha256(text);

  return {
    acquiredPage: acquired,
    text,
    title,
    description,
    wordCount: countWords(text),
    cleanedHash,
  };
}

/** Extract title from plain text (first non-empty line) */
function extractTitleFromText(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[0] || "";
}

/**
 * High-level acquire and clean function
 */
export async function acquireAndClean(
  url: string,
  options?: Parameters<typeof import("./http").acquireUrl>[1]
): Promise<CleanedPage> {
  const { acquireUrl } = await import("./http");
  const acquired = await acquireUrl(url, options);
  return cleanPage(acquired);
}