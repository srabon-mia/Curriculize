import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBulkDiscovery, type BulkDiscoveryConfig } from "./CurriculumBuilder";

interface MajorUnderstanding {
  id: string;
  node_id: string;
  external_key: string | null;
  code: string | null;
  description: string;
  order_index: number;
}

function createMockMU(overrides: Partial<MajorUnderstanding> = {}): MajorUnderstanding {
  return {
    id: "mu-1",
    node_id: "node-1",
    external_key: "1.1",
    code: "1.1a",
    description: "Understanding 1",
    order_index: 0,
    ...overrides,
  };
}

function createMockConfig(overrides: Partial<BulkDiscoveryConfig> = {}): BulkDiscoveryConfig {
  return {
    delayMs: 10, // Very short delay for tests
    curriculumId: "curriculum-1",
    nodeId: "node-1",
    mus: [createMockMU({ id: "mu-1", code: "1.1a" }), createMockMU({ id: "mu-2", code: "1.1b" }), createMockMU({ id: "mu-3", code: "1.1c" })],
    ...overrides,
  };
}

describe("runBulkDiscovery - Core bulk discovery logic", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("makes sequential requests for each major understanding", async () => {
    const config = createMockConfig();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 2, skipped: 0, unprocessed: 0, message: "2 new resources persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 1, unprocessed: 0, message: "0 new resources persisted; 1 skipped" }),
      });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.totalInserted).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({ muId: "mu-1", success: true, inserted: 2 });
    expect(result.results[1]).toMatchObject({ muId: "mu-2", success: true, inserted: 1 });
    expect(result.results[2]).toMatchObject({ muId: "mu-3", success: true, inserted: 0 });
  });

  it("continues processing remaining understandings after one request fails (network error)", async () => {
    const config = createMockConfig();
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "Internal server error" }),
      });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.totalInserted).toBe(1);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({ muId: "mu-1", success: false, errorType: "network", inserted: 0 });
    expect(result.results[1]).toMatchObject({ muId: "mu-2", success: true, inserted: 1 });
    expect(result.results[2]).toMatchObject({ muId: "mu-3", success: false, errorType: "http", inserted: 0 });
  });

  it("handles non-2xx HTTP responses without throwing", async () => {
    const config = createMockConfig();
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Bad request" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "Service unavailable" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 0, unprocessed: 0, message: "Done" }),
      });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.totalInserted).toBe(0);
    expect(result.results[0]).toMatchObject({ success: false, errorType: "http" });
    expect(result.results[1]).toMatchObject({ success: false, errorType: "http" });
    expect(result.results[2]).toMatchObject({ success: true, inserted: 0 });
  });

  it("handles malformed JSON responses gracefully", async () => {
    const config = createMockConfig();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.reject(new Error("Unexpected token < in JSON")),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 0, unprocessed: 0, message: "Done" }),
      });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.totalInserted).toBe(1);
    expect(result.results[0]).toMatchObject({ success: false, errorType: "json" });
    expect(result.results[1]).toMatchObject({ success: true, inserted: 1 });
    expect(result.results[2]).toMatchObject({ success: true, inserted: 0 });
  });

  it("handles zero-resource results (inserted: 0) correctly", async () => {
    const config = createMockConfig();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 0, unprocessed: 0, message: "0 new resources persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 0, unprocessed: 0, message: "0 new resources persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 0, unprocessed: 0, message: "0 new resources persisted" }),
      });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.totalInserted).toBe(0);
    expect(result.results.every((r) => r.success && r.inserted === 0)).toBe(true);
  });

  it("distinguishes between failed requests and zero-result requests in summary", async () => {
    const config = createMockConfig();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 2, skipped: 0, unprocessed: 0, message: "2 new resources persisted" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "Internal server error" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 0, skipped: 0, unprocessed: 0, message: "0 new resources persisted" }),
      });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(result.totalInserted).toBe(2);
    // Two successful requests (one with 2 inserted, one with 0 inserted)
    expect(result.summary).toContain("2 successful");
    expect(result.summary).toContain("1 failed");
    expect(result.summary).toContain("1 with no new resources");
    expect(result.summary).toContain("2 resources added");
  });

  it("uses the configured delay between requests (not 60 seconds)", async () => {
    const config = createMockConfig({ delayMs: 100 });
    const startTime = Date.now();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      });

    await runBulkDiscovery(config, mockFetch);

    const elapsed = Date.now() - startTime;
    // With 100ms delay between 3 requests = ~200ms total (skip first)
    // Should be much less than 60 seconds (60000ms)
    expect(elapsed).toBeLessThan(5000);
  });

  it("sends correct payload for each major understanding", async () => {
    const config = createMockConfig();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inserted: 1, skipped: 0, unprocessed: 0, message: "1 new resource persisted" }),
      });

    await runBulkDiscovery(config, mockFetch);

    // Verify each call has the correct major_understanding_id
    const calls = mockFetch.mock.calls;
    expect(calls[0][1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining('"major_understanding_id":"mu-1"'),
    });
    expect(calls[1][1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining('"major_understanding_id":"mu-2"'),
    });
    expect(calls[2][1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining('"major_understanding_id":"mu-3"'),
    });
    // All should have the same curriculum_id and node_id
    for (const call of calls) {
      const body = JSON.parse(call[1].body as string);
      expect(body.curriculum_id).toBe("curriculum-1");
      expect(body.node_id).toBe("node-1");
      expect(body.granularity).toBe("understanding");
    }
  });

  it("handles empty major understandings array", async () => {
    const config = createMockConfig({ mus: [] });
    mockFetch.mockReset();

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.totalInserted).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.summary).toBe("Done — 0 resources added across 0 understandings (0 successful)");
  });

  it("handles single major understanding", async () => {
    const config = createMockConfig({
      mus: [createMockMU({ id: "mu-single", code: "1.1" })],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ inserted: 2, skipped: 0, unprocessed: 0, message: "2 new resources persisted" }),
    });

    const result = await runBulkDiscovery(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.totalInserted).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ muId: "mu-single", success: true, inserted: 2 });
  });
});