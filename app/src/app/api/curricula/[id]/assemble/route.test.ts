import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockSupabaseClient } from "@/lib/phase6-integration/mock-supabase";

const mockClient = new MockSupabaseClient();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockClient),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => mockClient),
}));

const mod = await import("./route");
const GET = mod.GET;

const CURR_ID = "curriculum-1";
const NODE_A = "node-a";
const NODE_B = "node-b";
const MU_A1 = "mu-a1";
const MU_B1 = "mu-b1";

function seedStructure() {
  const muA1 = { id: MU_A1, node_id: NODE_A, external_key: "I.1", code: "3.1a", description: "Desc A1", order_index: 1 };
  const muB1 = { id: MU_B1, node_id: NODE_B, external_key: "II.1", code: "3.1y", description: "Desc B1", order_index: 1 };

  // Insert curriculum.
  mockClient.insert("curricula", {
    id: CURR_ID,
    title: "AP Chemistry",
    subject: "chemistry",
    source_type: "ai_organized",
    status: "published",
    notes: "{}",
  });

  // Insert nodes WITH embedded major_understandings arrays (mock doesn't do joins).
  mockClient.insert("nodes", {
    id: NODE_A,
    curriculum_id: CURR_ID,
    external_key: "topic-1",
    title: "Atomic Concepts",
    order_index: 1,
    exam_weight_pct: null,
    claim_statement: null,
    major_understandings: [muA1],
  });
  mockClient.insert("nodes", {
    id: NODE_B,
    curriculum_id: CURR_ID,
    external_key: "topic-2",
    title: "Periodic Table",
    order_index: 2,
    exam_weight_pct: null,
    claim_statement: null,
    major_understandings: [muB1],
  });

  // Also insert MUs as rows (for completeness, though getNodesWithUnderstandings returns embedded array).
  mockClient.insert("major_understandings", muA1);
  mockClient.insert("major_understandings", muB1);

  // Domain scores.
  mockClient.insert("domain_scores", { domain: "nysed.gov", score: 5, category: "official_source", notes: null });
  mockClient.insert("domain_scores", { domain: "openstax.org", score: 4, category: "textbook", notes: null });
  mockClient.insert("domain_scores", { domain: "unknownblog.com", score: 1, category: "low", notes: null });
}

describe("GET /api/curricula/[id]/assemble (warm-path assembly)", () => {
  let nodeA: string, nodeB: string, muA1: string, muB1: string;

  beforeEach(() => {
    mockClient.reset();
    vi.clearAllMocks();
    seedStructure();
    nodeA = NODE_A;
    nodeB = NODE_B;
    muA1 = MU_A1;
    muB1 = MU_B1;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("404s for unknown / non-published curriculum", async () => {
    const res = await GET(new Request("http://localhost/api/curricula/nope/assemble"), { params: Promise.resolve({ id: "nope" }) } as any);
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBeDefined();
  });

  it("selects only approved + verified resources in the student-facing response", async () => {
    // Approved + verified → eligible
    resource({ id: "eligible-1", major_understanding_id: muA1, source_domain: "nysed.gov" });
    verifiedVr("eligible-1", "2026-09-01T00:00:00Z");

    // Approved but NOT content_type_verified → excluded (unverified)
    resource({ id: "seed-yet-unverified", major_understanding_id: muA1, status: "approved", content_type_verified: false });

    // content_type_verified but DRAFT → excluded (not admin-approved)
    resource({ id: "draft-verified", node_id: nodeA, source_domain: "nysed.gov", status: "draft", content_type_verified: true });
    verifiedVr("draft-verified", "2026-09-01T00:00:00Z");
    resource({ id: "draft-unverified", node_id: nodeA, status: "draft", content_type_verified: false });
    resource({ id: "rejected-candidate", node_id: nodeA, status: "rejected", content_type_verified: false });

    const res = await callAssemble();
    const json = await res.json();

    expect(res.status).toBe(200);
    // MU_A1 has exactly 1 eligible resource; node_a has 0; node_b has 0; mu_b1 has 0
    expect(json.resourcesByTarget[`mu:${muA1}`].map((r: any) => r.id)).toEqual(["eligible-1"]);
    expect(json.resourcesByTarget[`node:${nodeA}`]).toEqual([]);
    expect(json.resourcesByTarget[`node:${nodeB}`]).toEqual([]);
    expect(json.resourcesByTarget[`mu:${muB1}`]).toEqual([]);
    // No draft/unverified resource leaks
    const allReturned = Object.values(json.resourcesByTarget).flat() as any[];
    expect(allReturned.map((r) => r.id)).not.toContain("draft-verified");
    expect(allReturned.map((r) => r.id)).not.toContain("seed-yet-unverified");
    expect(json.candidateResourcesByTarget[`node:${nodeA}`].map((r: any) => r.id)).toEqual(["draft-verified", "draft-unverified"]);
    expect(json.candidateResourcesByTarget[`node:${nodeA}`].map((r: any) => r.content_type_verified)).toEqual([true, false]);
    expect(json.candidateResourcesByTarget[`mu:${muA1}`]).toEqual([]);
    expect(json.candidateResourcesByTarget[`node:${nodeB}`]).toEqual([]);
    expect(json.candidateResourcesByTarget[`mu:${muB1}`]).toEqual([]);
  });

  it("ranks eligible resources by domain score (primary), then recency", async () => {
    // Same MU, three eligible resources on different domains + recencies.
    resource({ id: "r-high-old", major_understanding_id: muA1, source_domain: "unknownblog.com" }); // score 1
    verifiedVr("r-high-old", "2026-01-01T00:00:00Z");
    resource({ id: "r-low-new", major_understanding_id: muA1, source_domain: "openstax.org" }); // score 4
    verifiedVr("r-low-new", "2026-09-10T00:00:00Z");
    resource({ id: "r-high", major_understanding_id: muA1, source_domain: "nysed.gov" }); // score 5
    verifiedVr("r-high", "2026-01-01T00:00:00Z");

    const res = await callAssemble();
    const json = await res.json();
    // nysed(5) > openstax(4) > unknownblog(1)
    expect(json.resourcesByTarget[`mu:${muA1}`].map((r: any) => r.id)).toEqual(["r-high", "r-low-new", "r-high-old"]);
  });

  it("stably preserves insertion order for equal-ranked resources", async () => {
    // Same score (unknownblog=1), identical fetched_at → stable sort keeps insertion order.
    resource({ id: "r-new-1", major_understanding_id: muA1, source_domain: "unknownblog.com" });
    verifiedVr("r-new-1", "2026-09-01T00:00:00Z");
    resource({ id: "r-new-2", major_understanding_id: muA1, source_domain: "unknownblog.com" });
    verifiedVr("r-new-2", "2026-09-01T00:00:00Z");
    resource({ id: "r-new-3", major_understanding_id: muA1, source_domain: "unknownblog.com" });
    verifiedVr("r-new-3", "2026-09-01T00:00:00Z");

    const res = await callAssemble();
    const json = await res.json();
    expect(json.resourcesByTarget[`mu:${muA1}`].map((r: any) => r.id)).toEqual(["r-new-1", "r-new-2", "r-new-3"]);
  });

  it("reports honest coverage when resources are missing", async () => {
    // Only MU_A1 has one eligible resource; everything else empty.
    resource({ id: "only-1", major_understanding_id: muA1, source_domain: "nysed.gov" });
    verifiedVr("only-1", "2026-09-01T00:00:00Z");

    const res = await callAssemble();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.coverage.total_targets).toBe(4); // 2 node + 2 mu
    expect(json.coverage.eligible_targets).toBe(1);
  });

  it("assembles with zero resources for a freshly published curriculum", async () => {
    // No resource rows seeded → all targets have empty arrays, coverage 0.
    const res = await callAssemble();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.coverage.eligible_targets).toBe(0);
    expect(json.coverage.total_targets).toBe(4);
    // All targets present but empty — the response includes all node/MU keys.
    expect(Object.keys(json.resourcesByTarget || {}).length).toBe(4);
    // Each target has an empty array.
    for (const arr of Object.values(json.resourcesByTarget)) {
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.length).toBe(0);
    }
  });

  it("matches the student-facing response contract ({nodes, resourcesByTarget})", async () => {
    resource({ id: "ok", major_understanding_id: muA1, source_domain: "nysed.gov" });
    verifiedVr("ok", "2026-09-01T00:00:00Z");

    const res = await callAssemble();
    const json = await res.json();

    expect(json).toHaveProperty("curriculum");
    expect(json.curriculum.id).toBe(CURR_ID);
    expect(json.curriculum.status).toBe("published");
    expect(json).toHaveProperty("nodes");
    expect(json).toHaveProperty("resourcesByTarget");
    expect(json).toHaveProperty("coverage");

    // nodes carry their MUs in order.
    const nodeResult = (json.nodes as any[]).find((n) => n.id === nodeA);
    expect(nodeResult).toBeDefined();
    expect(nodeResult.major_understandings[0].id).toBe(muA1);

    // resourcesByTarget is keyed node:<id> / mu:<id>.
    expect(json.resourcesByTarget[`mu:${muA1}`][0].id).toBe("ok");
  });
});

// Helper functions
function resource(over: Record<string, unknown>) {
  return mockClient.insert("resources", {
    source_domain: "nysed.gov",
    resource_type: "text",
    license_status: "link_only",
    embed_allowed: false,
    ai_note: null,
    status: "approved",
    content_type_verified: true,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  });
}

function verifiedVr(resId: string, fetchedAt: string) {
  mockClient.insert("verification_records", {
    resource_id: resId,
    url: `https://example.com/${resId}`,
    canonical_url: `https://example.com/${resId}`,
    content_hash: resId,
    http_status: 200,
    fetched_at: fetchedAt,
    verified_at: fetchedAt,
    verification_method: "deterministic_v1",
    status: "verified",
  });
}

async function callAssemble() {
  return GET(new Request(`http://localhost/api/curricula/${CURR_ID}/assemble`), { params: Promise.resolve({ id: CURR_ID }) } as any);
}
