import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canReadCurriculumResult,
  createProgressAccessToken,
  createStreamAccessToken,
} from "@/lib/generation/resultAccess";

const state = vi.hoisted(() => ({
  streamToken: undefined as string | undefined,
  progressToken: undefined as string | undefined,
  curriculum: null as { status: string; created_by: string | null } | null,
  user: null as { id: string } | null,
  admin: null as { user_id: string } | null,
  events: [] as string[],
  serviceReads: 0,
  serviceRpcCalls: 0,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name.startsWith("curriculum_stream_") && state.streamToken
      ? { value: state.streamToken }
      : name.startsWith("curriculum_progress_") && state.progressToken
        ? { value: state.progressToken }
      : undefined,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: state.user } })) },
    from: (table: string) => {
      state.events.push(`rls:${table}`);
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(async () => ({
          data: table === "curricula" ? state.curriculum : state.admin,
          error: null,
        })),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      return query;
    },
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      state.events.push(`service:${table}`);
      state.serviceReads++;
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        single: vi.fn(async () => ({ data: null, error: null })),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      return query;
    },
    rpc: vi.fn(() => {
      state.serviceRpcCalls++;
      return Promise.resolve({ data: null, error: null });
    }),
  })),
}));

const { GET } = await import("./route");

const curriculumId = "curriculum-private-1";
const signingSecret = "test-stream-signing-secret";

function request() {
  return new Request(`http://localhost/api/generate/${curriculumId}/stream`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
}

async function responseText(response: Response) {
  return await response.text();
}

describe("GET /api/generate/[id]/stream authorization", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = signingSecret;
    state.streamToken = undefined;
    state.progressToken = undefined;
    state.curriculum = null;
    state.user = null;
    state.admin = null;
    state.events.length = 0;
    state.serviceReads = 0;
    state.serviceRpcCalls = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret;
  });

  it("denies an unauthenticated caller who only knows an unpublished curriculum ID", async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(state.events).toEqual(["rls:curricula"]);
    expect(state.serviceReads).toBe(0);
    expect(state.serviceRpcCalls).toBe(0);
  });

  it("checks publication through RLS before any service-role read or curriculum-specific stream event", async () => {
    state.curriculum = { status: "published", created_by: null };

    const response = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });
    const body = await responseText(response);

    expect(response.status).toBe(200);
    expect(state.events[0]).toBe("rls:curricula");
    expect(state.events[1]).toBe("service:curricula");
    expect(body).toContain("event: error");
    expect(body).not.toContain(curriculumId);
  });

  it("allows an authenticated creator to reach their own unpublished curriculum", async () => {
    state.user = { id: "creator-1" };
    state.curriculum = { status: "draft", created_by: "creator-1" };

    const response = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });
    await responseText(response);

    expect(response.status).toBe(200);
    expect(state.events).toEqual(["rls:curricula", "rls:admins", "service:curricula"]);
  });

  it("allows an authorized admin to reach an unpublished curriculum", async () => {
    state.user = { id: "admin-1" };
    state.admin = { user_id: "admin-1" };
    state.curriculum = { status: "draft", created_by: null };

    const response = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });
    await responseText(response);

    expect(response.status).toBe(200);
    expect(state.events).toEqual(["rls:curricula", "rls:admins", "service:curricula"]);
  });

  it("accepts a valid, curriculum-bound guest capability before touching service-role data", async () => {
    state.streamToken = createStreamAccessToken(curriculumId, signingSecret);

    const response = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });
    const body = await responseText(response);

    expect(response.status).toBe(200);
    expect(state.events[0]).toBe("service:curricula");
    expect(state.events).not.toContain("rls:curricula");
    expect(body).toContain("event: error");
  });

  it("rejects invalid and expired guest capabilities before service-role access", async () => {
    state.streamToken = "invalid-capability";
    const invalidResponse = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });
    expect(invalidResponse.status).toBe(404);
    expect(state.serviceReads).toBe(0);

    state.streamToken = createStreamAccessToken(curriculumId, signingSecret, 1);
    const expiredResponse = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });
    expect(expiredResponse.status).toBe(404);
    expect(state.serviceReads).toBe(0);
    expect(state.serviceRpcCalls).toBe(0);
  });

  it("does not accept a progress-only capability for the guarded stream route", async () => {
    state.progressToken = createProgressAccessToken(curriculumId, signingSecret);

    const response = await GET(request(), { params: Promise.resolve({ id: curriculumId }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(state.events).toEqual(["rls:curricula"]);
    expect(state.serviceReads).toBe(0);
    expect(state.serviceRpcCalls).toBe(0);
  });

  it("uses the same publication, creator, admin, and capability policy as the results page", () => {
    const base = {
      published: false,
      createdBy: "creator-1",
      userId: null as string | null,
      isAdmin: false,
      hasValidResultToken: false,
    };

    expect(canReadCurriculumResult(base)).toBe(false);
    expect(canReadCurriculumResult({ ...base, published: true })).toBe(true);
    expect(canReadCurriculumResult({ ...base, userId: "creator-1" })).toBe(true);
    expect(canReadCurriculumResult({ ...base, isAdmin: true })).toBe(true);
    expect(canReadCurriculumResult({ ...base, hasValidResultToken: true })).toBe(true);
  });
});
