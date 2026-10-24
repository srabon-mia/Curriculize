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

  it("shows curriculum-wide shortfalls even when the selected topic is fully covered", async () => {
    const progress = {
      complete: false,
      generation_finished: true,
      coverage_status: "insufficient",
      total: 2,
      with_resources: 1,
      topics: [
        { id: "node-1", resource_count: 3, sufficient: true },
        { id: "node-2", resource_count: 0, sufficient: false },
      ],
      understandings: [
        { id: "mu-1", resource_count: 2, sufficient: true },
        { id: "mu-2", resource_count: 0, sufficient: false },
      ],
    };
    const resource = (id: string, nodeId: string | null, muId: string | null) => ({
      id, node_id: nodeId, major_understanding_id: muId,
      url: `https://example.org/${id}`, title: id, source_domain: "example.org",
      resource_type: "text", license_status: "link_only" as const,
      embed_allowed: false, ai_note: null, status: "approved" as const,
      created_at: "2026-01-01T00:00:00.000Z", content_type_verified: true,
    });
    const selectedTopicResources = [1, 2, 3].map((i) => resource(`topic-${i}`, "node-1", null));
    const selectedUnderstandingResources = [1, 2].map((i) => resource(`concept-${i}`, null, "mu-1"));

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/progress")) return { ok: true, json: async () => progress };
      if (url.includes("node_id=node-1")) return { ok: true, json: async () => ({ resources: selectedTopicResources }) };
      if (url.includes("major_understanding_id=mu-1")) return { ok: true, json: async () => ({ resources: selectedUnderstandingResources }) };
      return { ok: true, json: async () => ({ resources: [] }) };
    }));

    render(<CurriculumViewer nodes={[
      {
        id: "node-1", curriculum_id: "curriculum-1", external_key: null,
        title: "Fractions", order_index: 1, exam_weight_pct: null, claim_statement: null,
        major_understandings: [{ id: "mu-1", node_id: "node-1", external_key: "1.1", code: "1.1", description: "Compare fractions", order_index: 0 }],
      },
      {
        id: "node-2", curriculum_id: "curriculum-1", external_key: null,
        title: "Decimals", order_index: 2, exam_weight_pct: null, claim_statement: null,
        major_understandings: [{ id: "mu-2", node_id: "node-2", external_key: "2.1", code: "2.1", description: "Convert decimals", order_index: 0 }],
      },
    ]} resourcesByTarget={{
      "node:node-1": selectedTopicResources,
      "mu:mu-1": selectedUnderstandingResources,
    }} />);

    expect(await screen.findByText(/Generation finished, but resource coverage is incomplete/i)).toBeTruthy();
    expect(screen.getByText(/1 topic\(s\) are below 3 resources and 1 concept\(s\) are below 2/i)).toBeTruthy();
  });
});
