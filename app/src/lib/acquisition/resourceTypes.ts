/** Resource types accepted by the resources_resource_type_check constraint. */
export const RESOURCE_TYPES = [
  "video",
  "text",
  "textbook",
  "problem_set",
  "reference_tool",
  "practice_exam",
  "other",
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(RESOURCE_TYPES);

/**
 * Normalize a discovery classification to one database-supported type.
 * Some model output follows the prompt's pipe-separated alternatives literally
 * (for example, "text|practice_exam"). In that case choose the first valid
 * alternative, preserving the model's stated preference.
 */
export function normalizeResourceType(value: unknown): ResourceType {
  if (typeof value !== "string") return "other";

  for (const candidate of value.split("|")) {
    const normalized = candidate.trim().toLowerCase();
    if (RESOURCE_TYPE_SET.has(normalized)) return normalized as ResourceType;
  }

  return "other";
}
