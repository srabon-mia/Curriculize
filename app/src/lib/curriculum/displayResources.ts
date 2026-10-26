import type { Resource } from "@/lib/curriculum-data";
import { normalizeForDedup } from "@/lib/deterministic/url";

export type ResourceMap = Record<string, Resource[]>;

function usableResource(resource: Resource): boolean {
  const title = resource.title?.trim();
  if (!title || !resource.url?.trim()) return false;
  if (/^(?:untitled|unknown|n\/?a|no title)$/i.test(title) || title === resource.url.trim()) return false;
  try {
    const url = new URL(resource.url);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function dedupeKey(urlValue: string): string {
  return normalizeForDedup(urlValue) ?? new URL(urlValue).toString();
}

/** Normalize resources once for both viewer rendering and sidebar counts. */
export function normalizeDisplayedResources(
  approved: ResourceMap,
  candidates: ResourceMap = {}
): { approved: ResourceMap; candidates: ResourceMap } {
  const approvedOutput: ResourceMap = {};
  const candidateOutput: ResourceMap = {};
  const targets = new Set([...Object.keys(approved), ...Object.keys(candidates)]);

  for (const target of targets) {
    const seen = new Set<string>();
    approvedOutput[target] = (approved[target] ?? []).filter((resource) => {
      if (!usableResource(resource)) return false;
      const key = dedupeKey(resource.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    candidateOutput[target] = (candidates[target] ?? []).filter((resource) => {
      if (!usableResource(resource)) return false;
      const key = dedupeKey(resource.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return { approved: approvedOutput, candidates: candidateOutput };
}
