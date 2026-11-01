import { describe, expect, it } from "vitest";
import {
  canReadCurriculumResult,
  createProgressAccessToken,
  createResultAccessToken,
  createStreamAccessToken,
  progressAccessCookieName,
  resultAccessCookieName,
  streamAccessCookieName,
  splitResultResources,
  verifyProgressAccessToken,
  verifyResultAccessToken,
  verifyStreamAccessToken,
} from "./resultAccess";

describe("generation result access", () => {
  it("signs a cookie token for one curriculum and rejects a different ID or token", () => {
    const now = 1_800_000_000;
    const token = createResultAccessToken("curriculum-a", "server-secret", now);
    expect(resultAccessCookieName("curriculum-a")).toBe("curriculum_result_curriculum-a");
    expect(verifyResultAccessToken("curriculum-a", "server-secret", token, now)).toBe(true);
    expect(verifyResultAccessToken("curriculum-b", "server-secret", token, now)).toBe(false);
    expect(verifyResultAccessToken("curriculum-a", "other-secret", token, now)).toBe(false);
    expect(verifyResultAccessToken("curriculum-a", "server-secret", undefined, now)).toBe(false);
  });

  it("issues a result capability with seven-day expiration and rejects expired tokens", () => {
    const now = 1_800_000_000;
    const token = createResultAccessToken("curriculum-a", "server-secret", now);
    // Token is valid within the 7-day window
    expect(verifyResultAccessToken("curriculum-a", "server-secret", token, now)).toBe(true);
    // Token expires after 7 days
    expect(verifyResultAccessToken("curriculum-a", "server-secret", token, now + 60 * 60 * 24 * 7)).toBe(false);
    // Token is rejected if clock is even one second past expiry
    expect(verifyResultAccessToken("curriculum-a", "server-secret", token, now + 60 * 60 * 24 * 7 + 1)).toBe(false);
  });

  it("rejects malformed, tampered, and incorrectly bound result tokens", () => {
    const now = 1_800_000_000;
    const validToken = createResultAccessToken("curriculum-a", "server-secret", now);
    // Malformed token (no separator)
    expect(verifyResultAccessToken("curriculum-a", "server-secret", "malformed", now)).toBe(false);
    // Malformed token (empty parts)
    expect(verifyResultAccessToken("curriculum-a", "server-secret", ".", now)).toBe(false);
    expect(verifyResultAccessToken("curriculum-a", "server-secret", "123.", now)).toBe(false);
    // Expired token (expiry in the past)
    const expiredToken = createResultAccessToken("curriculum-a", "server-secret", now - 60 * 60 * 24 * 8);
    expect(verifyResultAccessToken("curriculum-a", "server-secret", expiredToken, now)).toBe(false);
    // Tampered signature
    const tampered = validToken.slice(0, -1) + (validToken.endsWith("a") ? "b" : "a");
    expect(verifyResultAccessToken("curriculum-a", "server-secret", tampered, now)).toBe(false);
    // Wrong curriculum ID binding
    expect(verifyResultAccessToken("curriculum-b", "server-secret", validToken, now)).toBe(false);
    // Wrong secret
    expect(verifyResultAccessToken("curriculum-a", "other-secret", validToken, now)).toBe(false);
  });

  it("issues a stream-only capability bound to one curriculum and rejects invalid or expired tokens", () => {
    const now = 1_800_000_000;
    const token = createStreamAccessToken("curriculum-a", "server-secret", now);

    expect(streamAccessCookieName("curriculum-a")).toBe("curriculum_stream_curriculum-a");
    expect(verifyStreamAccessToken("curriculum-a", "server-secret", token, now)).toBe(true);
    expect(verifyStreamAccessToken("curriculum-b", "server-secret", token, now)).toBe(false);
    expect(verifyStreamAccessToken("curriculum-a", "other-secret", token, now)).toBe(false);
    expect(verifyStreamAccessToken("curriculum-a", "server-secret", "invalid", now)).toBe(false);
    expect(verifyStreamAccessToken("curriculum-a", "server-secret", token, now + 60 * 60 * 24 * 7)).toBe(false);
    expect(verifyStreamAccessToken("curriculum-a", "server-secret", undefined, now)).toBe(false);
  });

  it("issues a progress-only two-hour capability bound to one curriculum", () => {
    const now = 1_800_000_000;
    const token = createProgressAccessToken("curriculum-a", "server-secret", now);

    expect(progressAccessCookieName("curriculum-a")).toBe("curriculum_progress_curriculum-a");
    expect(verifyProgressAccessToken("curriculum-a", "server-secret", token, now)).toBe(true);
    expect(verifyProgressAccessToken("curriculum-b", "server-secret", token, now)).toBe(false);
    expect(verifyProgressAccessToken("curriculum-a", "other-secret", token, now)).toBe(false);
    expect(verifyProgressAccessToken("curriculum-a", "server-secret", "malformed", now)).toBe(false);
    expect(verifyProgressAccessToken("curriculum-a", "server-secret", token, now + 60 * 60 * 2)).toBe(false);
    expect(verifyProgressAccessToken("curriculum-a", "server-secret", undefined, now)).toBe(false);
    // Progress and stream capabilities use distinct permission scopes.
    const streamToken = createStreamAccessToken("curriculum-a", "server-secret", now);
    expect(verifyProgressAccessToken("curriculum-a", "server-secret", streamToken, now)).toBe(false);
    expect(verifyStreamAccessToken("curriculum-a", "server-secret", token, now)).toBe(false);
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
