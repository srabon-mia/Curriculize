/** Quality targets used for reporting discovered resource coverage. */
export const MIN_TOPIC_RESOURCES = 3;
export const MIN_UNDERSTANDING_RESOURCES = 2;

export type CoverageStatus = "pending" | "complete" | "insufficient" | "failed";
export type CoverageAttemptDecision =
  | { status: "retrying"; retry: true; attempts: number }
  | { status: "complete" | "insufficient"; retry: false; attempts: number }
  | { status: "ownership_lost"; retry: false };

/** Status for the lightweight job endpoint; missing terminal records are never success. */
export function getStoredCoverageStatus(input: {
  jobStatus: string;
  coverage: Record<string, { status?: string }> | null | undefined;
  expectedTargets: number;
}): CoverageStatus {
  if (input.jobStatus === "failed") return "failed";
  if (input.jobStatus !== "completed") return "pending";
  const records = Object.values(input.coverage ?? {});
  if (records.some((record) => record.status === "insufficient")) return "insufficient";
  return input.expectedTargets > 0 && records.length >= input.expectedTargets &&
    records.every((record) => record.status === "complete")
    ? "complete"
    : "insufficient";
}

/** Run a bounded target retry loop; persistence exceptions intentionally escape. */
export async function runBoundedCoverageAttempts(input: {
  maxAttempts: number;
  initialAttempts?: number;
  attemptIdFor?: (attemptIndex: number) => string;
  attempt: (attemptIndex: number) => Promise<"attempted" | "budget_exhausted" | "ownership_lost">;
  measureEligibleResources: () => Promise<number>;
  threshold: number;
  record: (result: { resourcesFound: number; sufficient: boolean; budgetExhausted: boolean; attemptId: string }) => Promise<CoverageAttemptDecision>;
}): Promise<"complete" | "insufficient" | "ownership_lost"> {
  const startAt = Math.min(input.maxAttempts, Math.max(0, input.initialAttempts ?? 0));
  for (let attemptIndex = startAt; attemptIndex < input.maxAttempts; attemptIndex++) {
    const outcome = await input.attempt(attemptIndex);
    if (outcome === "ownership_lost") return "ownership_lost";
    const budgetExhausted = outcome === "budget_exhausted";
    const resourcesFound = await input.measureEligibleResources();
    const decision = await input.record({
      resourcesFound,
      sufficient: resourcesFound >= input.threshold,
      budgetExhausted,
      attemptId: input.attemptIdFor?.(attemptIndex) ?? crypto.randomUUID(),
    });
    if (decision.status === "ownership_lost") return "ownership_lost";
    if (!decision.retry) return decision.status === "complete" ? "complete" : "insufficient";
  }
  return "insufficient";
}

export function mapUnderstandingCodesToIds(
  codes: string[] | undefined,
  understandings: Array<{ id: string; code: string | null; external_key: string | null }>
): string[] {
  if (!codes?.length) return [];
  const requested = new Set(codes);
  return understandings
    .filter((mu) => (mu.code !== null && requested.has(mu.code)) || (mu.external_key !== null && requested.has(mu.external_key)))
    .map((mu) => mu.id);
}

export function getCoverageStatus(input: {
  jobStatus: string | null;
  topicCounts: number[];
  understandingCounts: number[];
}): CoverageStatus {
  if (input.jobStatus === "failed") return "failed";
  if (input.jobStatus !== "completed") return "pending";
  const topicsCovered = input.topicCounts.every((count) => count >= MIN_TOPIC_RESOURCES);
  const understandingsCovered = input.understandingCounts.every(
    (count) => count >= MIN_UNDERSTANDING_RESOURCES
  );
  return topicsCovered && understandingsCovered ? "complete" : "insufficient";
}
