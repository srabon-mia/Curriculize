/**
 * Regression tests for generation stream resource insertion status.
 * These tests EXERCISE the actual route handler and assert on the
 * arguments passed to supabase.from("resources").insert(...).
 * If production code reverts to status: "approved", these tests will fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockProvider } from "@/lib/ai/mock";

// ============================================================
// Mock Supabase client - captures insert calls for assertion
// ============================================================

const capturedInserts: Array<{ table: string; resources: any[] }> = [];

function createMockSupabaseClient() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb) => Promise.resolve({ data: [], error: null }).then(cb)),
  };

  chain.insert.mockImplementation((resources: any[]) => {
    capturedInserts.push({ table: "resources", resources });
    return Promise.resolve({ data: resources.map((r, i) => ({ id: `new-resource-${i}` })), error: null });
  });

  chain.select.mockImplementation(() => chain);
  chain.single.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  chain.maybeSingle.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  chain.eq.mockImplementation(() => chain);
  chain.order.mockImplementation(() => chain);
  chain.limit.mockImplementation(() => chain);
  chain.in.mockImplementation(() => chain);
  chain.update.mockImplementation(() => Promise.resolve({ data: null, error: null }));

  const client = {
    from: vi.fn((table: string) => {
      const tableChain = { ...chain };

      if (table === "curricula") {
        tableChain.select.mockImplementation(() => {
          const selectChain = { ...chain };
          selectChain.single.mockImplementation(() =>
            Promise.resolve({ data: createMockCurriculum(), error: null })
          );
          selectChain.maybeSingle.mockImplementation(() =>
            Promise.resolve({ data: createMockCurriculum(), error: null })
          );
          return selectChain;
        });
        tableChain.update.mockImplementation(() => ({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }));
      }

      if (table === "nodes") {
        tableChain.select.mockImplementation(() => {
          const selectChain = { ...chain };
          selectChain.then = vi.fn().mockImplementation((cb) =>
            Promise.resolve({ data: createMockNodes(), error: null }).then(cb)
          );
          return selectChain;
        });
        tableChain.insert.mockImplementation(() => ({
          select: vi.fn().mockImplementation(() => ({
            single: vi.fn().mockResolvedValue({ data: { id: "new-node-id" }, error: null }),
          })),
        }));
      }

      if (table === "major_understandings") {
        tableChain.insert.mockResolvedValue({ data: null, error: null });
        tableChain.select.mockImplementation(() => ({
          eq: vi.fn().mockReturnThis(),
          then: vi.fn().mockImplementation((cb) =>
            Promise.resolve({ data: createMockNodes()[0].major_understandings, error: null }).then(cb)
          ),
        }));
      }

      if (table === "resources") {
        tableChain.insert.mockImplementation((resources: any[]) => {
          capturedInserts.push({ table, resources });
          return Promise.resolve({ data: resources.map((r, i) => ({ id: `new-resource-${i}` })), error: null });
        });
      }

      return tableChain;
    }),
  };

  return client;
}

const mockSupabaseClient = createMockSupabaseClient();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}));

// Mock AI provider factory - return the mock provider directly
let mockAIInstance: MockProvider;

vi.mock("@/lib/ai", () => ({
  getAIProvider: vi.fn(() => mockAIInstance),
  setAIProvider: vi.fn((p) => { mockAIInstance = p; }),
  resetAIProvider: vi.fn(() => { mockAIInstance = undefined as any; }),
  createProvider: vi.fn(),
}));

// Mock prompt builders - return simple predictable prompts
vi.mock("@/lib/prompts/skeleton", () => ({
  buildSkeletonPrompt: vi.fn(() => "skeleton prompt"),
}));

vi.mock("@/lib/prompts/sources", () => ({
  buildSourceDiscoveryPrompt: vi.fn(() => "sources prompt"),
}));

vi.mock("@/lib/prompts/discover", () => ({
  buildDiscoverPrompt: vi.fn(() => "discover prompt"),
  buildTopicBatchPrompt: vi.fn(() => "batch prompt"),
}));

// Mock curriculum-data
vi.mock("@/lib/curriculum-data", () => ({
  getNodesWithUnderstandings: vi.fn(),
  getDomainScores: vi.fn(() => Promise.resolve({})),
}));

// Import the route AFTER mocks are set up
const { GET } = await import("./route");

// ============================================================
// Test utilities
// ============================================================

function createMockRequest(id: string): Request {
  return new Request(`http://localhost/api/generate/${id}/stream`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
}

function createMockCurriculum() {
  return {
    id: "test-curriculum-id",
    title: "Test Curriculum",
    subject: "Test Subject",
    source_type: "adapted",
    source_attribution: "Test Source",
    source_url: "https://example.com",
    notes: JSON.stringify({
      grade_level: "high school",
      difficulty: "standard",
      existing_knowledge: "",
      learning_goal: "understand the subject",
      time_available: "no time pressure",
      added_context: "",
    }),
    status: "draft",
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function createMockNodes() {
  return [
    {
      id: "node-1",
      curriculum_id: "test-curriculum-id",
      external_key: "topic-1",
      title: "Test Topic",
      order_index: 1,
      exam_weight_pct: "20-30%",
      claim_statement: null,
      major_understandings: [
        { id: "mu-1", node_id: "node-1", external_key: "1.1", code: "1.1a", description: "Understanding 1", order_index: 0 },
        { id: "mu-2", node_id: "node-1", external_key: "1.2", code: "1.1b", description: "Understanding 2", order_index: 1 },
      ],
    },
    {
      id: "node-2",
      curriculum_id: "test-curriculum-id",
      external_key: "topic-2",
      title: "Another Topic",
      order_index: 2,
      exam_weight_pct: "30-40%",
      claim_statement: null,
      major_understandings: [
        { id: "mu-3", node_id: "node-2", external_key: "2.1", code: "2.1a", description: "Understanding 3", order_index: 0 },
      ],
    },
  ];
}

function createMockSkeletonResponse() {
  return JSON.stringify({
    title: "Generated Curriculum",
    source_type: "adapted",
    source_attribution: "Test Source",
    source_url: "https://example.com/curriculum",
    nodes: [
      { title: "Test Topic", order_index: 1, major_understandings: [{ code: "1.1a", description: "Understanding 1" }, { code: "1.1b", description: "Understanding 2" }] },
      { title: "Another Topic", order_index: 2, major_understandings: [{ code: "2.1a", description: "Understanding 3" }] },
    ],
  });
}

function createMockSourcesResponse() {
  return JSON.stringify([{ domain: "khanacademy.org", name: "Khan Academy", why: "Great videos", best_for: "video" }, { domain: "nysed.gov", name: "NYSED", why: "Official standards", best_for: "textbook" }]);
}

function createMockDiscoverResponse() {
  return JSON.stringify([{ url: "https://khanacademy.org/science/test-topic", title: "Test Topic Video", resource_type: "video", source_domain: "khanacademy.org", ai_note: "Great introductory video", license_status: "cc_open" }, { url: "https://nysed.gov/resources/test-doc", title: "Test Document", resource_type: "textbook", source_domain: "nysed.gov", ai_note: "Official textbook chapter", license_status: "cc_open" }]);
}

function createMockBatchResponse() {
  return JSON.stringify({ topic_resources: [{ url: "https://khanacademy.org/practice/1.1a", title: "Practice for 1.1a", resource_type: "problem_set", source_domain: "khanacademy.org", ai_note: "Practice problems for 1.1a", license_status: "cc_open", understanding_codes: ["1.1a"] }, { url: "https://nysed.gov/practice/1.1b", title: "Practice for 1.1b", resource_type: "problem_set", source_domain: "nysed.gov", ai_note: "Practice problems for 1.1b", license_status: "cc_open", understanding_codes: ["1.1b"] }, { url: "https://khanacademy.org/practice/2.1a", title: "Practice for 2.1a", resource_type: "problem_set", source_domain: "khanacademy.org", ai_note: "Practice problems for 2.1a", license_status: "cc_open", understanding_codes: ["2.1a"] }] });
}

// ============================================================
// Tests
// ============================================================

describe("Generation Stream - Resource Status Regression (Route Integration)", () => {
  let originalSetTimeout: typeof global.setTimeout;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedInserts.length = 0;

    // Create and set mock AI provider
    mockAIInstance = new MockProvider();

    // Mock setTimeout to execute callbacks immediately (for background batch)
    originalSetTimeout = global.setTimeout;
    // @ts-expect-error - mocking global setTimeout for test
    global.setTimeout = vi.fn((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      // Execute callback immediately with a microtask to preserve async behavior
      return originalSetTimeout(() => {
        try {
          callback();
        } catch (e) {
          console.error("setTimeout callback error:", e);
        }
      }, 0);
    }) as typeof global.setTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    vi.clearAllMocks();
    capturedInserts.length = 0;
    mockAIInstance = undefined as any;
  });

  async function runStreamAndCaptureInserts(curriculumId: string = "test-curriculum-id") {
    // Configure AI responses
    mockAIInstance.setDefaultResponse({
      completeText: createMockSkeletonResponse(),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    mockAIInstance.setResponse("sources prompt", {
      completeText: createMockSourcesResponse(),
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    mockAIInstance.setResponse("discover prompt", {
      completeText: createMockDiscoverResponse(),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    mockAIInstance.setResponse("batch prompt", {
      completeText: createMockBatchResponse(),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // Mock getNodesWithUnderstandings for background batch
    const { getNodesWithUnderstandings } = await import("@/lib/curriculum-data");
    (getNodesWithUnderstandings as ReturnType<typeof vi.fn>).mockResolvedValue(createMockNodes());

    // Run the stream handler
    const request = createMockRequest(curriculumId);
    const response = await GET(request, { params: Promise.resolve({ id: curriculumId }) });

    // Consume the stream to trigger all SSE events
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Give background batch time to complete (it runs in async IIFE after stream closes)
    // With mocked setTimeout, it should run synchronously, but we need to yield to the event loop
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    return capturedInserts;
  }

  it("topic-level SSE resource insertion uses draft status", async () => {
    const inserts = await runStreamAndCaptureInserts();

    // Find resources.insert calls from the SSE (topic-level) path
    // These have node_id set and major_understanding_id = null
    const topicLevelInserts = inserts.filter(
      (call) => call.table === "resources" && call.resources.some((r: any) => r.node_id && r.major_understanding_id === null)
    );

    expect(topicLevelInserts.length).toBeGreaterThan(0);

    // Assert every inserted resource in the topic-level path has status: "draft"
    for (const call of topicLevelInserts) {
      for (const resource of call.resources) {
        expect(resource.status).toBe("draft");
        expect(resource.status).not.toBe("approved");
        expect(resource.content_type_verified).toBe(false);
        expect(resource.node_id).toBeTruthy();
        expect(resource.major_understanding_id).toBeNull();
      }
    }
  }, 15000);

  it("background batch per-understanding resource insertion uses draft status", async () => {
    const inserts = await runStreamAndCaptureInserts();

    // Find resources.insert calls from the background batch path
    // These have major_understanding_id set and node_id = null
    const batchInserts = inserts.filter(
      (call) => call.table === "resources" && call.resources.some((r: any) => r.major_understanding_id && r.node_id === null)
    );

    expect(batchInserts.length).toBeGreaterThan(0);

    // Assert every inserted resource in the batch path has status: "draft"
    for (const call of batchInserts) {
      for (const resource of call.resources) {
        expect(resource.status).toBe("draft");
        expect(resource.status).not.toBe("approved");
        expect(resource.content_type_verified).toBe(false);
        expect(resource.major_understanding_id).toBeTruthy();
        expect(resource.node_id).toBeNull();
      }
    }
  }, 15000);

  it("both insertion paths are exercised and produce resources", async () => {
    const inserts = await runStreamAndCaptureInserts();

    const topicLevelInserts = inserts.filter(
      (call) => call.table === "resources" && call.resources.some((r: any) => r.node_id && r.major_understanding_id === null)
    );

    const batchInserts = inserts.filter(
      (call) => call.table === "resources" && call.resources.some((r: any) => r.major_understanding_id && r.node_id === null)
    );

    // Both paths should have executed and inserted resources
    expect(topicLevelInserts.length).toBeGreaterThan(0);
    expect(batchInserts.length).toBeGreaterThan(0);

    // Total resources should be > 0
    const totalResources = inserts
      .filter((call) => call.table === "resources")
      .flatMap((call) => call.resources)
      .length;
    expect(totalResources).toBeGreaterThan(0);
  }, 15000);
});