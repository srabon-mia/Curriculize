/**
 * Phase 5 Content Cleaner
 * Deterministic HTML/text cleaning - removes boilerplate, extracts text.
 * Delegates to shared cleanedDocument pipeline.
 */

import { buildCleanedDocument, serializeCleanedDocument } from "./cleanedDocument";
import type { AcquiredPage, CleanedPage } from "./types";

/**
 * Main cleaning function - converts AcquiredPage to CleanedPage
 * Preserves exact existing Phase 5 behavior by delegating to shared pipeline.
 */
export function cleanPage(acquired: AcquiredPage): CleanedPage {
  const doc = buildCleanedDocument(acquired);
  return serializeCleanedDocument(doc);
}

/**
 * Internal accessor for the shared CleanedDocument.
 * Used by the acquisition engine to avoid duplicate HTML processing.
 * Not part of the public Phase 5 API.
 */
export function getCleanedDocument(acquired: AcquiredPage) {
  return buildCleanedDocument(acquired);
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