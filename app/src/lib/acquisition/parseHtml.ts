/**
 * Shared HTML Parser and Cleaner
 * Single authoritative implementation of HTML parsing, boilerplate removal, and main-content selection.
 * Used by both Phase 5 serialization and Phase 6A structural extraction.
 */

/** Normalize whitespace in text */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/ /g, " ")
    .replace(/[ \f\v]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Count words in text */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Simple HTML node representation */
export interface SimpleNode {
  tagName: string;
  attributes: Record<string, string>;
  children: (SimpleNode | string)[];
  parent?: SimpleNode;
}

/** Elements to remove entirely (boilerplate) */
export const REMOVE_ELEMENTS = new Set<string>([
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
export const BOILERPLATE_SELECTORS: string[] = [
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
export const MAIN_CONTENT_SELECTORS: string[] = [
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

/**
 * Parse HTML into a SimpleNode tree using regex.
 * Handles tags with attributes, self-closing tags, and text content.
 */
export function parseHtmlSimple(html: string): SimpleNode {
  const root: SimpleNode = { tagName: "root", attributes: {}, children: [] };
  let current = root;
  const stack: SimpleNode[] = [root];

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

/** Serialize SimpleNode tree to text (used by Phase 5) */
export function serializeToText(node: SimpleNode | string): string {
  if (typeof node === "string") return node;
  if (REMOVE_ELEMENTS.has(node.tagName)) return "";
  return node.children.map(serializeToText).join("");
}

/** Remove boilerplate elements by selector patterns (mutates tree) */
export function removeBoilerplate(node: SimpleNode): void {
  const classAttr = node.attributes.class || "";
  const idAttr = node.attributes.id || "";

  for (const selector of BOILERPLATE_SELECTORS) {
    if (selector.startsWith("[class*=")) {
      const pattern = selector.slice(8, -1);
      if (classAttr.includes(pattern)) return;
    }
    if (selector.startsWith("[id*=")) {
      const pattern = selector.slice(5, -1);
      if (idAttr.includes(pattern)) return;
    }
  }

  for (const child of node.children) {
    if (typeof child !== "string") {
      removeBoilerplate(child);
    }
  }
}

/** Find the main content node using priority selectors */
export function findMainContent(node: SimpleNode): SimpleNode | null {
  for (const selector of MAIN_CONTENT_SELECTORS) {
    const found = findBySelector(node, selector);
    if (found) return found;
  }
  return null;
}

/** Simple selector matching (tag, #id, .class) */
export function findBySelector(node: SimpleNode, selector: string): SimpleNode | null {
  if (selector.startsWith("#")) {
    return findById(node, selector.slice(1));
  }
  if (selector.startsWith(".")) {
    return findByClass(node, selector.slice(1));
  }
  return findByTag(node, selector);
}

export function findById(node: SimpleNode, id: string): SimpleNode | null {
  if (node.attributes.id === id) return node;
  for (const child of node.children) {
    if (typeof child !== "string") {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function findByClass(node: SimpleNode, className: string): SimpleNode | null {
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

export function findByTag(node: SimpleNode, tag: string): SimpleNode | null {
  if (node.tagName.toLowerCase() === tag.toLowerCase()) return node;
  for (const child of node.children) {
    if (typeof child !== "string") {
      const found = findByTag(child, tag);
      if (found) return found;
    }
  }
  return null;
}

/** Extract title from HTML (from original tree, per Phase 5 behavior) */
export function extractTitle(node: SimpleNode): string {
  const titleNode = findByTag(node, "title");
  if (titleNode) {
    return titleNode.children.map(serializeToText).join("").trim();
  }
  const h1Node = findByTag(node, "h1");
  if (h1Node) {
    return h1Node.children.map(serializeToText).join("").trim();
  }
  return "";
}

/** Extract meta description from HTML (from original tree, per Phase 5 behavior) */
export function extractDescription(node: SimpleNode): string | null {
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

/** Extract title from plain text (first non-empty line) */
export function extractTitleFromText(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[0] || "";
}