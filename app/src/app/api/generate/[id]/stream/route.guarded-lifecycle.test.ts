import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamAccessToken } from "@/lib/generation/resultAccess";

const state = vi.hoisted(() => ({
  scenario: "register" as "register" | "observer",
  streamToken: undefined as string | undefined,
  events: [] as string[],
  rpcCalls: [] as string[],
  insertedJobs: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name.startsWith("curriculum_stream_") && state.streamToken
      ? { value: state.streamToken }
      : undefined,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      let selection = "";
      let inserted = false;
      const query = {
        select(fields?: string) {
          selection = fields ?? "";
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        abortSignal() {
          return query;
        },
        insert(row: Record<string, unknown>) {
          inserted = true;
          state.insertedJobs.push(row);
          state.events.push("insert:acquisition_jobs");
          return query;
        },
        async single() {
          if (table === "curricula") {
            state.events.push("single:curriculum");
            return {
              data: { id: "curriculum-guarded", title: "Test curriculum", status: "draft", notes: "{}" },
              error: null,
            };
          }
          if (table === "acquisition_jobs" && inserted) {
            if (state.scenario === "observer") {
              return { data: null, error: { code: "23505", message: "active generation already exists" } };
            }
            return {
              data: { id: "job-registered", claim_token: "test-claim-token", claim_version: 1 },
              error: null,
            };
          }
          if (table === "acquisition_jobs" && selection.includes("curricula!inner(status)")) {
            state.events.push("single:observer-attachment");
            return {
              data: {
                id: "job-existing",
                result_data: {
                  checkpoint: { completedTopicIds: ["topic-1"] },
                  skeleton: { title: "Saved skeleton", nodes: [{}] },
                },
                curricula: { status: "draft" },
              },
              error: null,
            };
          }
          if (table === "acquisition_jobs" && selection.includes("status, error, result_data")) {
            state.events.push("single:observer-poll");
            return {
              data: { status: "pending", error: null, result_data: { checkpoint: { completedTopicIds: ["topic-1"] } } },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const result = table === "nodes" && state.scenario === "register"
            ? { data: null, error: { message: "stop owner path after job registration" } }
            : { data: [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      state.events.push(`from:${table}`);
      return query;
    },
    rpc: vi.fn(async (name: string) => {
      state.events.push(`rpc:${name}`);
      state.rpcCalls.push(name);
      if (name === "claim_next_job") return { data: null, error: null };
      return { data: true, error: null };
    }),
  })),
}));

const { GET } = await import("./route");
const curriculumId = "curriculum-guarded";
const signingSecret = "test-stream-signing-secret";

function request(signal?: AbortSignal) {
  return new Request(`http://localhost/api/generate/${curriculumId}/stream`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal,
  });
}

const context = { params: Promise.resolve({ id: curriculumId }) };

describe("guarded stream GET lifecycle", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = signingSecret;
    state.scenario = "register";
    state.streamToken = createStreamAccessToken(curriculumId, signingSecret);
    state.events.length = 0;
    state.rpcCalls.length = 0;
    state.insertedJobs.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret;
  });

  it("passes an authorized guest through the guard into claim and job registration", async () => {
    const response = await GET(request(), context);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(state.events).toContain("single:curriculum");
    expect(state.rpcCalls[0]).toBe("claim_next_job");
    expect(state.events).toContain("insert:acquisition_jobs");
    expect(state.insertedJobs[0]).toMatchObject({
      curriculum_id: curriculumId,
      job_type: "curriculum_generation",
      status: "running",
      created_by: null,
    });
    expect(body).toContain("event: error");
  });

  it("passes an authorized reconnect through the guard into observer attachment and polling", async () => {
    state.scenario = "observer";
    const controller = new AbortController();
    const response = await GET(request(controller.signal), context);
    const reader = response.body!.getReader();
    let streamed = "";

    for (let index = 0; index < 8 && !streamed.includes("event: continue"); index++) {
      const { value, done } = await reader.read();
      if (done) break;
      streamed += new TextDecoder().decode(value);
    }

    controller.abort();
    await reader.cancel();

    expect(response.status).toBe(200);
    expect(streamed).toContain('"step":"reconnect"');
    expect(streamed).toContain('"is_reconnect":true');
    expect(streamed).toContain('"step":"resume"');
    expect(streamed).toContain("event: continue");
    expect(state.rpcCalls.filter((name) => name === "claim_next_job")).toHaveLength(2);
    expect(state.events).toContain("insert:acquisition_jobs");
    expect(state.events).toContain("single:observer-attachment");
    expect(state.events).toContain("single:observer-poll");
  });
});
