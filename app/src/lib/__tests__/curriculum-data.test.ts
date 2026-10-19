import { describe, it, expect } from "vitest";
import { selectEligibleResources, type Resource } from "@/lib/curriculum-data";

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: "test-id",
    node_id: "node-1",
    major_understanding_id: null,
    url: "https://example.com/resource",
    title: "Test Resource",
    source_domain: "example.com",
    resource_type: "text",
    license_status: "cc_open",
    embed_allowed: false,
    ai_note: null,
    status: "approved",
    created_at: new Date().toISOString(),
    content_type_verified: true,
    ...overrides,
  };
}

describe("selectEligibleResources", () => {
  it("returns fully eligible resources (approved + verified)", () => {
    const resources = [
      makeResource({ id: "1", status: "approved", content_type_verified: true }),
      makeResource({ id: "2", status: "approved", content_type_verified: true }),
    ];
    const result = selectEligibleResources(resources);
    expect(result).toHaveLength(2);
  });

  it("excludes approved-but-unverified resources (seed demo rows)", () => {
    const resources = [
      makeResource({ id: "1", status: "approved", content_type_verified: false }), // seed rows
    ];
    const result = selectEligibleResources(resources);
    expect(result).toHaveLength(0);
  });

  it("excludes verified-but-unapproved resources (AI-discovered drafts)", () => {
    const resources = [
      makeResource({ id: "1", status: "draft", content_type_verified: true }), // AI-discovered, pending admin review
    ];
    const result = selectEligibleResources(resources);
    expect(result).toHaveLength(0);
  });

  it("excludes rejected resources even if verified", () => {
    const resources = [
      makeResource({ id: "1", status: "rejected", content_type_verified: true }),
    ];
    const result = selectEligibleResources(resources);
    expect(result).toHaveLength(0);
  });

  it("excludes draft resources even if verified", () => {
    const resources = [
      makeResource({ id: "1", status: "draft", content_type_verified: true }),
    ];
    const result = selectEligibleResources(resources);
    expect(result).toHaveLength(0);
  });

  it("mixed array: only fully eligible pass", () => {
    const resources = [
      makeResource({ id: "1", status: "approved", content_type_verified: true }),   // eligible
      makeResource({ id: "2", status: "approved", content_type_verified: false }),  // seed demo
      makeResource({ id: "3", status: "draft", content_type_verified: true }),      // AI draft
      makeResource({ id: "4", status: "rejected", content_type_verified: true }),   // rejected
      makeResource({ id: "5", status: "draft", content_type_verified: false }),     // neither
    ];
    const result = selectEligibleResources(resources);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });
});
