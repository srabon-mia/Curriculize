import { describe, expect, it } from "vitest";
import { parseBatchResources } from "@/lib/acquisition/worker";

const candidate = (overrides: Record<string, unknown> = {}) => ({
  url: "https://example.org/lesson",
  title: "A verified teaching resource",
  resource_type: "text",
  source_domain: "example.org",
  ai_note: "Teaches the concept {with an example}.",
  license_status: "link_only",
  understanding_codes: ["A.1"],
  ...overrides,
});

describe("worker batch candidate parsing", () => {
  it("parses full topic-resource JSON and preserves explicit target codes", () => {
    const parsed = parseBatchResources(JSON.stringify({ topic_resources: [candidate()] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].understanding_codes).toEqual(["A.1"]);
  });

  it("recovers complete candidates from a response truncated after a later item starts", () => {
    const first = JSON.stringify(candidate());
    const partial = JSON.stringify(candidate({ url: "https://example.org/partial", title: "Partial item" }));
    const response = `{"topic_resources":[${first},${partial.slice(0, -24)}`;

    const parsed = parseBatchResources(response);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://example.org/lesson");
  });

  it("drops malformed or unassociated entries without discarding later valid entries", () => {
    const response = JSON.stringify({ topic_resources: [
      candidate({ understanding_codes: [] }),
      candidate({ url: 9 }),
      candidate({ url: "https://example.org/valid" }),
    ] });

    expect(parseBatchResources(response).map((resource) => resource.url)).toEqual([
      "https://example.org/valid",
    ]);
  });
});