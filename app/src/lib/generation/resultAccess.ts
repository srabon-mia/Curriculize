import { createHmac, timingSafeEqual } from "node:crypto";

export function resultAccessCookieName(curriculumId: string): string {
  return `curriculum_result_${curriculumId}`;
}

export function streamAccessCookieName(curriculumId: string): string {
  return `curriculum_stream_${curriculumId}`;
}

export function progressAccessCookieName(curriculumId: string): string {
  return `curriculum_progress_${curriculumId}`;
}

const STREAM_ACCESS_TTL_SECONDS = 60 * 60 * 24 * 7;
// A generation session should finish well within this window; keeping the
// polling capability shorter-lived limits the impact of a copied cookie.
const PROGRESS_ACCESS_TTL_SECONDS = 60 * 60 * 2;

export function createStreamAccessToken(
  curriculumId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const expiresAt = nowSeconds + STREAM_ACCESS_TTL_SECONDS;
  const signature = createHmac("sha256", secret)
    .update(`curriculum-stream:${curriculumId}:${expiresAt}`)
    .digest("base64url");
  return `${expiresAt}.${signature}`;
}

export function verifyStreamAccessToken(
  curriculumId: string,
  secret: string,
  token: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return false;

  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) return false;

  const expected = Buffer.from(createHmac("sha256", secret)
    .update(`curriculum-stream:${curriculumId}:${expiresAt}`)
    .digest("base64url"));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createProgressAccessToken(
  curriculumId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const expiresAt = nowSeconds + PROGRESS_ACCESS_TTL_SECONDS;
  const signature = createHmac("sha256", secret)
    .update(`curriculum-progress:${curriculumId}:${expiresAt}`)
    .digest("base64url");
  return `${expiresAt}.${signature}`;
}

export function verifyProgressAccessToken(
  curriculumId: string,
  secret: string,
  token: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return false;

  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) return false;

  const expected = Buffer.from(createHmac("sha256", secret)
    .update(`curriculum-progress:${curriculumId}:${expiresAt}`)
    .digest("base64url"));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const RESULT_ACCESS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function createResultAccessToken(
  curriculumId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const expiresAt = nowSeconds + RESULT_ACCESS_TTL_SECONDS;
  const signature = createHmac("sha256", secret)
    .update(`curriculum-result:${curriculumId}:${expiresAt}`)
    .digest("base64url");
  return `${expiresAt}.${signature}`;
}

export function verifyResultAccessToken(
  curriculumId: string,
  secret: string,
  token: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return false;

  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret)
      .update(`curriculum-result:${curriculumId}:${expiresAt}`)
      .digest("base64url")
  );
  const actual = Buffer.from(signature);
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
