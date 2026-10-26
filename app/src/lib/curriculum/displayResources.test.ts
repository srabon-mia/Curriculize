import { describe, expect, it } from "vitest";
import type { Resource } from "@/lib/curriculum-data";
import { normalizeDisplayedResources } from "./displayResources";

function resource(id: string, url: string, title = id, type = "text"): Resource {
  return {
    id, node_id: null, major_understanding_id: null, url, title, source_domain: null,
    resource_type: type, license_status: "link_only", embed_allowed: false, ai_note: null,
    status: "approved", created_at: "2026-01-01T00:00:00.000Z", content_type_verified: true,
  };
}

describe("normalizeDisplayedResources", () => {
  it("keeps usable approved and candidate links, preferring approved duplicates", () => {
    const normalized = normalizeDisplayedResources(
      { "node:n1": [resource("approved", "https://example.org/lesson#part")] },
      { "node:n1": [
        resource("duplicate", "https://example.org/lesson", "Duplicate"),
        resource("candidate", "https://example.org/practice", "Practice", "problem_set"),
        resource("missing-url", ""),
        resource("bad-url", "javascript:alert(1)"),
        resource("missing-title", "https://example.org/no-title", "  "),
      ] }
    );
    expect(normalized.approved["node:n1"].map((item) => item.id)).toEqual(["approved"]);
    expect(normalized.candidates["node:n1"].map((item) => item.id)).toEqual(["candidate"]);
  });

  it("normalizes host casing and drops URL fragments for duplicate detection", () => {
    const normalized = normalizeDisplayedResources(
      { "mu:m1": [resource("one", "https://EXAMPLE.org/page#section-a")] },
      { "mu:m1": [resource("two", "https://example.org/page#section-b")] }
    );
    expect(normalized.candidates["mu:m1"]).toHaveLength(0);
  });
});
