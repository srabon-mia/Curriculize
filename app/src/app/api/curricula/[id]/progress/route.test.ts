import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgressAccessToken } from "@/lib/generation/resultAccess";

const state = vi.hoisted(() => ({
  progressToken: undefined as string | undefined,
  curriculum: null as { status: string; created_by: string | null } | null,
  user: null as { id: string } | null,
  admin: null as { user_id: string } | null,
  jobStatus: "running",
  events: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name.startsWith("curriculum_progress_") && state.progressToken
      ? { value: state.progressToken }
      : undefined,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: state.user } })) },
    from: (table: string) => {
      state.events.push(`rls:${table}`);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) query[method] = () => query;
      query.maybeSingle = async () => ({
        data: table === "curricula" ? state.curriculum : state.admin,
        error: null,
      });
      return query;
    },
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      state.events.push(`service:${table}`);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "or", "order", "limit"]) query[method] = () => query;
      query.maybeSingle = async () => ({ data: { status: state.jobStatus }, error: null });
      const data = table === "nodes"
        ? [{ id: "node-1" }]
        : table === "major_understandings"
          ? [{ id: "mu-1", node_id: "node-1" }]
          : table === "resources"
            ? [{ id: "resource-1", node_id: "node-1", major_understanding_id: "mu-1" }]
            : null;
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve, reject);
      return query;
    },
  })),
}));

const { GET } = await import("./route");
const curriculumId = "curriculum-1";
const signingSecret = "test-stream-signing-secret";

function request() {
  return new Request(`http://localhost/api/curricula/${curriculumId}/progress`);
}

async function getProgress() {
  return GET(request(), { params: Promise.resolve({ id: curriculumId }) });
}

describe("GET /api/curricula/[id]/progress authorization", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = signingSecret;
    state.progressToken = undefined;
    state.curriculum = null;
    state.user = null;
    state.admin = null;
    state.jobStatus = "running";
    state.events.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret;
  });

  it("denies anonymous access to unpublished progress using only the curriculum ID", async () => {
    const response = await getProgress();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(state.events).toEqual(["rls:curricula"]);
  });

  it("allows the authenticated creator and preserves detailed progress polling", async () => {
    state.user = { id: "creator-1" };
    state.curriculum = { status: "draft", created_by: "creator-1" };

    const response = await getProgress();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      total: 1,
      with_resources: 1,
      complete: false,
      job_status: "running",
      generation_finished: false,
      coverage_status: "pending",
      topics: [{ id: "node-1", resource_count: 1, sufficient: false }],
      understandings: [{ id: "mu-1", resource_count: 1, sufficient: false }],
    });
    expect(state.events.slice(0, 2)).toEqual(["rls:curricula", "rls:admins"]);
    expect(state.events.slice(2)).toContain("service:nodes");
    expect(state.events.slice(2)).toContain("service:acquisition_jobs");
  });

  it("allows an admin to read unpublished progress", async () => {
    state.user = { id: "admin-1" };
    state.admin = { user_id: "admin-1" };
    state.curriculum = { status: "draft", created_by: null };

    const response = await getProgress();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      job_status: "running",
      topics: [{ id: "node-1", resource_count: 1, sufficient: false }],
      understandings: [{ id: "mu-1", resource_count: 1, sufficient: false }],
    });
    expect(state.events.slice(0, 2)).toEqual(["rls:curricula", "rls:admins"]);
  });

  it("allows anonymous published polling while omitting private job and target metadata", async () => {
    state.curriculum = { status: "published", created_by: null };
    state.jobStatus = "completed";

    const response = await getProgress();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      total: 1,
      with_resources: 1,
      complete: false,
      generation_finished: true,
      coverage_status: "insufficient",
    });
    expect(body).not.toHaveProperty("job_status");
    expect(body).not.toHaveProperty("topics");
    expect(body).not.toHaveProperty("understandings");
    expect(Object.keys(body).sort()).toEqual([
      "complete",
      "coverage_status",
      "generation_finished",
      "total",
      "with_resources",
    ]);
  });

  it("rejects missing, malformed, mismatched, and expired guest capabilities before service reads", async () => {
    const missing = await getProgress();
    expect(missing.status).toBe(404);
    expect(state.events).toEqual(["rls:curricula"]);

    state.events.length = 0;
    state.progressToken = "invalid-capability";
    const invalid = await getProgress();
    expect(invalid.status).toBe(404);
    expect(state.events).toEqual(["rls:curricula"]);

    state.events.length = 0;
    state.progressToken = createProgressAccessToken("another-curriculum", signingSecret);
    const mismatched = await getProgress();
    expect(mismatched.status).toBe(404);
    expect(state.events).toEqual(["rls:curricula"]);

    state.events.length = 0;
    state.progressToken = createProgressAccessToken(curriculumId, signingSecret, 1);
    const expired = await getProgress();
    expect(expired.status).toBe(404);
    expect(state.events).toEqual(["rls:curricula"]);
  });

  it("accepts a valid progress capability and returns only fields needed by guest polling", async () => {
    state.progressToken = createProgressAccessToken(curriculumId, signingSecret);
    state.jobStatus = "completed";

    const response = await getProgress();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      total: 1,
      with_resources: 1,
      complete: false,
      generation_finished: true,
      coverage_status: "insufficient",
    });
    expect(body).not.toHaveProperty("job_status");
    expect(body).not.toHaveProperty("topics");
    expect(body).not.toHaveProperty("understandings");
    expect(state.events[0]).toBe("rls:curricula");
    expect(state.events[1]).toBe("service:nodes");
  });

  it("keeps a capability-only caller on aggregate fields even when RLS returns a draft row", async () => {
    state.progressToken = createProgressAccessToken(curriculumId, signingSecret);
    state.curriculum = { status: "draft", created_by: null };

    const response = await getProgress();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "complete",
      "coverage_status",
      "generation_finished",
      "total",
      "with_resources",
    ]);
    expect(body).toMatchObject({
      total: 1,
      with_resources: 1,
      complete: false,
      generation_finished: false,
      coverage_status: "pending",
    });
    expect(body).not.toHaveProperty("job_status");
    expect(body).not.toHaveProperty("topics");
    expect(body).not.toHaveProperty("understandings");
  });

  it("checks authorization before any service-role read", async () => {
    const response = await getProgress();
    expect(response.status).toBe(404);
    expect(state.events).not.toContain("service:nodes");
    expect(state.events).not.toContain("service:major_understandings");
    expect(state.events).not.toContain("service:resources");
    expect(state.events).not.toContain("service:acquisition_jobs");
  });
});
