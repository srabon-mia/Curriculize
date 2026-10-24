import { describe, expect, it } from "vitest";
import { normalizeResourceType, RESOURCE_TYPES } from "../resourceTypes";

describe("normalizeResourceType", () => {
  it("normalizes the production failure value to its first supported classification", () => {
    expect(normalizeResourceType("text|practice_exam")).toBe("text");
  });

  it.each(RESOURCE_TYPES)("preserves the supported resource type %s", (resourceType) => {
    expect(normalizeResourceType(resourceType)).toBe(resourceType);
  });

  it("selects the first supported alternative and falls back for unknown values", () => {
    expect(normalizeResourceType("not_a_type | practice_exam")).toBe("practice_exam");
    expect(normalizeResourceType("invalid|also_invalid")).toBe("other");
    expect(normalizeResourceType(null)).toBe("other");
  });
});
