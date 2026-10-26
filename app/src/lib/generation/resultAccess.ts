import { createHmac, timingSafeEqual } from "node:crypto";

export function resultAccessCookieName(curriculumId: string): string {
  return `curriculum_result_${curriculumId}`;
}

export function createResultAccessToken(curriculumId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`curriculum-result:${curriculumId}`)
    .digest("base64url");
}

export function verifyResultAccessToken(
  curriculumId: string,
  secret: string,
  token: string | undefined
): boolean {
  if (!token) return false;
  const expected = Buffer.from(createResultAccessToken(curriculumId, secret));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function canReadCurriculumResult(input: {
  published: boolean;
  createdBy: string | null;
  userId: string | null;
  isAdmin: boolean;
  hasValidResultToken: boolean;
}): boolean {
  return input.published || input.isAdmin || input.hasValidResultToken ||
    Boolean(input.userId && input.createdBy && input.userId === input.createdBy);
}

export type ResultResource = {
  id: string;
  url: string;
  title: string;
  source_domain?: string | null;
  ai_note?: string | null;
  status: "draft" | "approved" | "rejected";
  content_type_verified: boolean;
};

export function splitResultResources<T extends ResultResource>(resources: T[]): {
  approved: T[];
  candidates: T[];
} {
  return {
    approved: resources.filter((resource) =>
      resource.status === "approved" && resource.content_type_verified === true
    ),
    candidates: resources.filter((resource) => resource.status === "draft"),
  };
}
