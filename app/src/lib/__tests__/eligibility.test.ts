/**
 * Student Resource Eligibility Regression Tests
 *
 * Ensures the student-facing CurriculumViewer consistently excludes resources
 * unless BOTH conditions are satisfied:
 *   - status === "approved"
 *   - content_type_verified === true
 *
 * Reuses the canonical selectEligibleResources() helper.
 * Verifies approved-but-unverified, verified-but-draft, and draft-and-unverified
 * resources are all excluded.
 */

import { describe, it, expect } from "vitest";
import { selectEligibleResources, type Resource } from "@/lib/curriculum-data";

describe("Student Resource Eligibility Gate (selectEligibleResources)", () => {
  const baseResource: Resource = {
    id: "res-1",
    node_id: "node-1",
    major_understanding_id: null,
    url: "https://example.org/resource",
    title: "Test Resource",
    source_domain: "example.org",
    resource_type: "text",
    license_status: "link_only",
    embed_allowed: false,
    ai_note: null,
    created_at: "2026-10-18T00:00:00Z",
    content_type_verified: false,
    status: "draft",
  };

  it("includes resource with status='approved' AND content_type_verified=true", () => {
    const resources: Resource[] = [
      { ...baseResource, id: "r1", status: "approved", content_type_verified: true },
    ];
    const eligible = selectEligibleResources(resources);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe("r1");
  });

  it("excludes approved-but-unverified resources (seed demo case)", () => {
    const resources: Resource[] = [
      { ...baseResource, id: "r1", status: "approved", content_type_verified: false },
    ];
    const eligible = selectEligibleResources(resources);
    expect(eligible).toHaveLength(0);
  });

  it("excludes verified-but-draft resources (AI-discovered not yet approved)", () => {
    const resources: Resource[] = [
      { ...baseResource, id: "r1", status: "draft", content_type_verified: true },
    ];
    const eligible = selectEligibleResources(resources);
    expect(eligible).toHaveLength(0);
  });

  it("excludes draft-and-unverified resources", () => {
    const resources: Resource[] = [
      { ...baseResource, id: "r1", status: "draft", content_type_verified: false },
    ];
    const eligible = selectEligibleResources(resources);
    expect(eligible).toHaveLength(0);
  });

  it("excludes rejected resources even if verified", () => {
    const resources: Resource[] = [
      { ...baseResource, id: "r1", status: "rejected", content_type_verified: true },
    ];
    const eligible = selectEligibleResources(resources);
    expect(eligible).toHaveLength(0);
  });

  it("filters mixed resources correctly", () => {
    const resources: Resource[] = [
      { ...baseResource, id: "r1", status: "approved", content_type_verified: true },
      { ...baseResource, id: "r2", status: "approved", content_type_verified: false },
      { ...baseResource, id: "r3", status: "draft", content_type_verified: true },
      { ...baseResource, id: "r4", status: "draft", content_type_verified: false },
      { ...baseResource, id: "r5", status: "rejected", content_type_verified: true },
    ];
    const eligible = selectEligibleResources(resources);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe("r1");
  });

  it("handles empty input", () => {
    const eligible = selectEligibleResources([]);
    expect(eligible).toHaveLength(0);
  });
});