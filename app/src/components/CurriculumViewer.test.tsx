// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CurriculumViewer } from "./CurriculumViewer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CurriculumViewer coverage status", () => {
  it("shows an honest insufficient-coverage message after retries are exhausted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        complete: false,
        generation_finished: true,
        coverage_status: "insufficient",
        total: 1,
        with_resources: 0,
      }),
    }));
    render(<CurriculumViewer nodes={[{
      id: "node-1",
      curriculum_id: "curriculum-1",
      external_key: null,
      title: "Fractions",
      order_index: 1,
      exam_weight_pct: null,
      claim_statement: null,
      major_understandings: [{
        id: "mu-1", node_id: "node-1", external_key: "1.1", code: "1.1",
        description: "Compare fractions", order_index: 0,
      }],
    }]} resourcesByTarget={{}} />);
    await waitFor(() => expect(screen.getByText(/Coverage is insufficient/i)).toBeTruthy());
    expect(screen.getByText(/quality target is at least 3/i)).toBeTruthy();
  });
});
