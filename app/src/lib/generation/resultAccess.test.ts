import { describe, expect, it } from "vitest";
import {
  canReadCurriculumResult,
  createResultAccessToken,
  resultAccessCookieName,
  splitResultResources,
  verifyResultAccessToken,
} from "./resultAccess";

describe("generation result access", () => {
  it("signs a cookie token for one curriculum and rejects a different ID or token", () => {
    const token = createResultAccessToken("curriculum-a", "server-secret");
    expect(resultAccessCookieName("curriculum-a")).toBe("curriculum_result_curriculum-a");
    expect(verifyResultAccessToken("curriculum-a", "server-secret", token)).toBe(true);
    expect(verifyResultAccessToken("curriculum-b", "server-secret", token)).toBe(false);
    expect(verifyResultAccessToken("curriculum-a", "other-secret", token)).toBe(false);
    expect(verifyResultAccessToken("curriculum-a", "server-secret", undefined)).toBe(false);
  });

  it("keeps unpublished results available only to admins, owners, or a valid generation capability", () => {
    const base = { published: false, createdBy: "owner-1", userId: "other-user", isAdmin: false, hasValidResultToken: false };
    expect(canReadCurriculumResult(base)).toBe(false);
    expect(canReadCurriculumResult({ ...base, userId: "owner-1" })).toBe(true);
    expect(canReadCurriculumResult({ ...base, isAdmin: true })).toBe(true);
    expect(canReadCurriculumResult({ ...base, hasValidResultToken: true })).toBe(true);
    expect(canReadCurriculumResult({ ...base, published: true })).toBe(true);
  });

  it("shows only verified approved resources and draft candidates, never rejected resources", () => {
    const resources = [
      { id: "approved", title: "Approved", url: "https://example.org/a", status: "approved" as const, content_type_verified: true },
      { id: "approved-unverified", title: "Unverified approval", url: "https://example.org/b", status: "approved" as const, content_type_verified: false },
      { id: "candidate-verified", title: "Candidate", url: "https://example.org/c", status: "draft" as const, content_type_verified: true },
      { id: "candidate-unverified", title: "Candidate two", url: "https://example.org/d", status: "draft" as const, content_type_verified: false },
      { id: "rejected", title: "Rejected", url: "https://example.org/e", status: "rejected" as const, content_type_verified: true },
    ];
    const split = splitResultResources(resources);
    expect(split.approved.map((resource) => resource.id)).toEqual(["approved"]);
    expect(split.candidates.map((resource) => resource.id)).toEqual(["candidate-verified", "candidate-unverified"]);
  });
});
