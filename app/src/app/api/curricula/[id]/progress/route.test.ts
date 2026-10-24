import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: mockFrom }) }));

import { GET } from "./route";

describe("curriculum coverage progress", () => {
  let status = "running";
  beforeEach(() => {
    status = "running";
    mockFrom.mockImplementation((table: string) => {
      const result = table === "nodes"
        ? [{ id: "node-1" }]
        : table === "major_understandings"
          ? [{ id: "mu-1", node_id: "node-1" }]
          : table === "resources"
            ? []
            : { status };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "or", "order", "limit"]) query[method] = () => query;
      query.maybeSingle = async () => ({ data: result, error: null });
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: result, error: null }).then(resolve, reject);
      return query;
    });
  });

  it("remains pending while a bounded retry can still run", async () => {
    const response = await GET(new Request("http://local"), { params: Promise.resolve({ id: "curriculum-1" }) });
    const body = await response.json();
    expect(body).toMatchObject({ complete: false, generation_finished: false, coverage_status: "pending" });
  });

  it("reports terminal shortfall instead of success after retry exhaustion", async () => {
    status = "completed";
    const response = await GET(new Request("http://local"), { params: Promise.resolve({ id: "curriculum-1" }) });
    const body = await response.json();
    expect(body).toMatchObject({ complete: false, generation_finished: true, coverage_status: "insufficient" });
    expect(body.topics[0]).toMatchObject({ resource_count: 0, sufficient: false });
    expect(body.understandings[0]).toMatchObject({ resource_count: 0, sufficient: false });
  });
});
