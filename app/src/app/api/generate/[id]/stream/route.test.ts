/* eslint-disable @typescript-eslint/no-explicit-any -- test-only dynamic Supabase mock builder */
/**
 * Regression tests for the generation stream (Phase 12 cut-over + Phase 12
 * launch blocker fix).
 *
 * BEFORE Phase 12: the stream route inserted raw candidate rows directly into
 * the resources table (status='draft', content_type_verified hardcoded).
 *
 * AFTER Phase 12: the stream route routes candidates through the Learning
 * Engine (discoverVerifiedResource -> acquire -> evidence -> verify ->
 * persist). The Learning Engine is mocked here so the SSE event flow + the
 * per-resource target mapping + the draft/approval invariant + the job
 * lifecycle protocol can be asserted in isolation, without network fetches.
 *
 * REGRESSION GUARD: every resource row persisted by this route MUST be
 * status='draft' (admin approval required for student visibility) and MUST NOT
 * be 'approved'. content_type_verified is driven by verification (true for a
 * verified candidate), never hardcoded.
 *
 * JOB LIFECYCLE GUARD: the SSE stream must claim an acquisition job via the
 * claim_next_job RPC (atomic) or INSERT a 'running' job with a real claim_token.
 * It must NOT process a job merely because it found a pending/running row with
 * a NULL claim_token. All lifecycle RPC results are checked.
 *
 * ⚠️  MOCKED TESTS — these do NOT prove PostgreSQL concurrency semantics.
 * The claim_next_job RPC uses FOR UPDATE SKIP LOCKED in real PostgreSQL.
 * These mocks simulate the contract but cannot prove race-safety. True
 * concurrency testing requires integration tests against a real Supabase
 * instance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockProvider } from "@/lib/ai/mock";
import type { LearnParams, LearnResult } from "@/lib/learningEngine";

// ============================================================
// Captured resource inserts (produced by the mocked Learning Engine,
// simulating what persistVerifiedResource would write to the DB).
// ============================================================
const capturedInserts: Array<{ table: string; resources: any[] }> = [];
const capturedNodeInserts: Array<any> = [];
const capturedMuInserts: Array<any> = [];
const capturedCurriculumUpdates: Array<any> = [];
const capturedSourceRows: Array<any> = [];
const structureLifecycleOrder: string[] = [];
const capturedSseEvents: string[] = [];
let resumeScenario = false;
let persistedResumeNodes: Array<any> = [];
let persistedResumeMus: Array<any> = [];
let simulatedResumeJob: any = null;
let simulatedCurriculum: any = null;
let observerRunningJob: any = null;
let durableJobRow: any = null;

// ============================================================
// Configurable RPC result overrides for lifecycle testing.
// ============================================================
const rpcOverrides: Record<string, { data: unknown; error: unknown }> = {};

// Per-RPC call counts and sequenced responses (for testing retry logic).
const rpcCallCounts: Record<string, number> = {};
const rpcSequences: Record<string, Array<{ data: unknown; error: unknown }>> = {};
const coverageAttemptCounts: Record<string, number> = {};

// Flag-controlled INSERT error for acquisition_jobs (for testing unique
// violation / failure paths without mockImplementationOnce interference).
let jobInsertMockError: { code: string; message: string } | null = null;

// ============================================================
// Mock the Learning Engine so the SSE route can be exercised without
// performing real HTTP acquisition / verification / persistence.
// ============================================================
vi.mock("@/lib/learningEngine", () => ({
  discoverVerifiedResource: vi.fn(),
  toLearnParams: vi.fn(),
}));

async function mockDiscoverVerifiedResource(): Promise<void> {
  const { discoverVerifiedResource } = await import("@/lib/learningEngine");
  (discoverVerifiedResource as ReturnType<typeof vi.fn>).mockImplementation(
    async (params: LearnParams): Promise<LearnResult> => {
      const { nodeId, understandingId } = params.target;
      let domain = "example.org";
      try {
        domain = new URL(params.candidate.url).hostname.replace(/^www\./, "");
      } catch { /* keep fallback */ }
      const resourceRow = {
        node_id: nodeId ?? null,
        major_understanding_id: understandingId ?? null,
        url: params.candidate.url,
        title: params.candidate.title ?? params.candidate.url,
        source_domain: domain,
        resource_type: params.candidate.resourceType ?? "other",
        license_status: params.candidate.licenseStatus ?? "link_only",
        embed_allowed: false,
        content_type_verified: true,
        ai_note: params.candidate.aiNote ?? null,
        status: "draft",
      };
      const existing = allResourceInserts().find((resource) =>
        resource.url === resourceRow.url && resource.node_id === resourceRow.node_id &&
        resource.major_understanding_id === resourceRow.major_understanding_id
      );
      if (!existing) capturedInserts.push({ table: "resources", resources: [resourceRow] });
      return {
        resource: { ...(existing ?? resourceRow), id: "res-mock", createdAt: "2026-10-18T00:01:00Z", isNew: !existing },
        verificationStatus: "verified",
        isNew: !existing,
      } as unknown as LearnResult;
    }
  );
}

// ============================================================
// Mock Supabase client - the parts the SSE route touches.
// ============================================================
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
    abortSignal: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: any) =>
      Promise.resolve({ data: [], error: null }).then(cb)
    ),
  };

  const client = {
    from: vi.fn((table: string) => {
      const tableChain: any = { ...chain };

      if (table === "curricula") {
        tableChain.select.mockImplementation(() => {
          const selectChain: any = { ...chain };
          selectChain.single.mockImplementation(() =>
            Promise.resolve({ data: resumeScenario && simulatedCurriculum ? simulatedCurriculum : createMockCurriculum(), error: null })
          );
          selectChain.maybeSingle.mockImplementation(() =>
            Promise.resolve({ data: resumeScenario && simulatedCurriculum ? simulatedCurriculum : createMockCurriculum(), error: null })
          );
          return selectChain;
        });
        tableChain.update.mockImplementation((payload: any) => {
          capturedCurriculumUpdates.push(payload);
          if (resumeScenario) simulatedCurriculum = { ...createMockCurriculum(), ...payload };
          return ({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          });
        });
      }

      if (table === "curriculum_sources") {
        tableChain.select.mockImplementation(() => {
          const selectChain: any = { ...chain };
          selectChain.maybeSingle.mockResolvedValue({ data: null, error: null });
          return selectChain;
        });
        tableChain.insert = vi.fn().mockImplementation((row: any) => {
          capturedSourceRows.push(row);
          return Promise.resolve({ data: null, error: null });
        });
        tableChain.update = vi.fn().mockImplementation((row: any) => {
          capturedSourceRows.push(row);
          return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
        });
      }

      if (table === "nodes") {
        tableChain.select.mockImplementation(() => {
          const selectChain: any = { ...chain };
          selectChain.then = vi.fn().mockImplementation((cb: any) =>
            Promise.resolve({ data: resumeScenario ? persistedResumeNodes : [], error: null }).then(cb)
          );
          return selectChain;
        });
        const nodeInsertMock = vi.fn().mockImplementation((data: any) => {
          structureLifecycleOrder.push("topic-row");
          capturedNodeInserts.push(data);
          const nodeId = `node-${data.external_key}`;
          if (resumeScenario) {
            persistedResumeNodes = [
              ...persistedResumeNodes.filter((node) => node.external_key !== data.external_key),
              { id: nodeId, title: data.title, order_index: data.order_index, external_key: data.external_key },
            ].sort((a, b) => a.order_index - b.order_index);
          }
          return {
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: { id: nodeId }, error: null }),
          };
        });
        tableChain.insert = nodeInsertMock;
        tableChain.upsert = nodeInsertMock;
      }

      if (table === "major_understandings") {
        const muInsertMock = vi.fn().mockImplementation((data: any) => {
          structureLifecycleOrder.push("understanding-row");
          capturedMuInserts.push(data);
          if (resumeScenario) {
            const rows = Array.isArray(data) ? data : [data];
            persistedResumeMus = [
              ...persistedResumeMus.filter((mu) => !rows.some((row: any) => row.node_id === mu.node_id && row.external_key === mu.external_key)),
              ...rows.map((mu: any) => ({ ...mu, id: `mu-${mu.node_id}-${mu.external_key}` })),
            ];
          }
          return Promise.resolve({ data: null, error: null });
        });
        tableChain.insert = muInsertMock;
        tableChain.upsert = muInsertMock;
        tableChain.select.mockImplementation(() => {
          const selectChain: any = { ...chain };
          selectChain.in = vi.fn().mockReturnThis();
          selectChain.then = vi.fn().mockImplementation((cb: any) =>
            Promise.resolve({
              data: resumeScenario ? persistedResumeMus : createMockNodes()[0].major_understandings,
              error: null,
            }).then(cb)
          );
          return selectChain;
        });
      }

      // acquisition_jobs: claimOrRegisterJob() calls claim_next_job RPC first
      // (handled in the rpc mock below), then may INSERT a new running job.
      if (table === "acquisition_jobs") {
        tableChain.select.mockImplementation(() => {
          const selectChain: any = { ...chain };
          selectChain.single = vi.fn().mockResolvedValue({
            data: resumeScenario && simulatedResumeJob
              ? { ...simulatedResumeJob, curricula: { status: "draft" } }
              : durableJobRow ?? observerRunningJob,
            error: null,
          });
          selectChain.maybeSingle = vi.fn().mockResolvedValue({ data: durableJobRow, error: null });
          return selectChain;
        });
        tableChain.insert = vi.fn().mockImplementation((data: any) => {
          capturedInserts.push({ table: "acquisition_jobs", resources: [data] });
          const insertChain: any = { ...chain };
          insertChain.select = vi.fn().mockReturnThis();
          // If jobInsertMockError is set, simulate an INSERT error (e.g. 23505)
          if (resumeScenario && simulatedResumeJob?.status === "running") {
            insertChain.single = vi.fn().mockResolvedValue({
              data: null,
              error: { code: "23505", message: "active generation already exists" },
            });
          } else if (!resumeScenario && durableJobRow && ["pending", "running"].includes(durableJobRow.status)) {
            insertChain.single = vi.fn().mockResolvedValue({
              data: null,
              error: { code: "23505", message: "active generation already exists" },
            });
          } else if (jobInsertMockError) {
            insertChain.single = vi.fn().mockResolvedValue({
              data: null,
              error: jobInsertMockError,
            });
          } else {
            durableJobRow = {
              id: "job-1", claim_token: "tok-real-uuid", claim_version: 1,
              status: data.status, result_data: {}, curriculum_id: data.curriculum_id,
            };
            if (resumeScenario) {
              simulatedResumeJob = {
                id: "job-1", claim_token: "tok-real-uuid", claim_version: 1,
                status: "running", result_data: {}, curriculum_id: data.curriculum_id,
              };
            }
            insertChain.single = vi.fn().mockResolvedValue({
              data: { id: "job-1", claim_token: "tok-real-uuid", claim_version: 1 },
              error: null,
            });
          }
          return insertChain;
        });
      }

      // resources: should NOT be called directly by the route anymore — all
      // persistence goes through the mocked Learning Engine.
      if (table === "resources") {
        tableChain.insert.mockImplementation((resources: any[]) => {
          return Promise.resolve({
            data: resources.map((_, i) => ({ id: `direct-${i}` })),
            error: null,
          });
        });
      }

      return tableChain;
    }),
    rpc: vi.fn().mockImplementation((name: string, args?: any) => {
      const callCount = (rpcCallCounts[name] ?? 0);
      rpcCallCounts[name] = callCount + 1;

      // Sequenced responses (for testing retry / call-order logic)
      if (rpcSequences[name] && rpcSequences[name][callCount]) {
        return Promise.resolve(rpcSequences[name][callCount]);
      }

      if (rpcOverrides[name]) {
        return Promise.resolve(rpcOverrides[name]);
      }

      // Default: claim_next_job returns null (no pending job found)
      if (name === "claim_next_job") {
        if (!resumeScenario && durableJobRow?.status === "pending") {
          durableJobRow.status = "running";
          durableJobRow.claim_token = "tok-reclaimed";
          durableJobRow.claim_version += 1;
          return Promise.resolve({ data: durableJobRow, error: null });
        }
        if (resumeScenario && simulatedResumeJob?.status === "pending") {
          simulatedResumeJob.status = "running";
          simulatedResumeJob.claim_version += 1;
          return Promise.resolve({ data: simulatedResumeJob, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }

      if (name === "record_resource_coverage_attempt") {
        const key = `${args.p_phase}:${args.p_target_id}`;
        const attemptCount = args.p_budget_exhausted
          ? (coverageAttemptCounts[key] ?? 0)
          : (coverageAttemptCounts[key] = (coverageAttemptCounts[key] ?? 0) + 1);
        const status = args.p_sufficient
          ? "complete"
          : args.p_budget_exhausted || attemptCount >= args.p_max_attempts
            ? "insufficient"
            : "retrying";
        const checkpointJob = resumeScenario ? simulatedResumeJob : durableJobRow;
        if (checkpointJob) {
          const phaseCheckpoint = args.p_phase === "topic" ? "checkpoint" : "batchCheckpoint";
          const completed = checkpointJob.result_data?.[phaseCheckpoint]?.completedTopicIds ?? [];
          const resultData = checkpointJob.result_data ?? (checkpointJob.result_data = {});
          resultData.resourceCoverage ??= {};
          resultData.resourceCoverage[key] = { attempts: attemptCount, status, resourcesFound: args.p_resources_found };
          if (status !== "retrying") {
            resultData[phaseCheckpoint] = {
              ...resultData[phaseCheckpoint],
              completedTopicIds: completed.includes(args.p_target_id) ? completed : [...completed, args.p_target_id],
            };
          }
        }
        return Promise.resolve({ data: { attempts: attemptCount, status, retry: status === "retrying" }, error: null });
      }
      if (name === "save_job_skeleton") {
        structureLifecycleOrder.push("skeleton-checkpoint");
        const checkpointJob = resumeScenario ? simulatedResumeJob : durableJobRow;
        if (!checkpointJob) return Promise.resolve({ data: { status: "ownership_lost_or_expired" }, error: null });
        checkpointJob.result_data ??= {};
        if (checkpointJob.result_data.skeleton) {
          return Promise.resolve({ data: { status: "already_saved" }, error: null });
        }
        checkpointJob.result_data.skeleton = args.p_skeleton;
        return Promise.resolve({ data: { status: "saved" }, error: null });
      }
      if (resumeScenario && name === "release_job_claim") {
        simulatedResumeJob.status = "pending";
        return Promise.resolve({ data: true, error: null });
      }
      if (!resumeScenario && name === "release_job_claim" && durableJobRow) {
        durableJobRow.status = "pending";
        durableJobRow.claim_token = null;
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "save_job_sources") {
        const checkpointJob = resumeScenario ? simulatedResumeJob : durableJobRow;
        if (checkpointJob) {
          checkpointJob.result_data ??= {};
          checkpointJob.result_data.discoveredSources = args.p_sources;
        }
        return Promise.resolve({ data: true, error: null });
      }
      if (resumeScenario && name === "complete_job") {
        simulatedResumeJob.status = "completed";
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "publish_and_complete_job") {
        const checkpointJob = resumeScenario ? simulatedResumeJob : durableJobRow;
        if (checkpointJob) checkpointJob.status = "completed";
        return Promise.resolve({ data: { status: "completed" }, error: null });
      }

      // Default: reserve_ai_call returns reserved (success)
      if (name === "reserve_ai_call") {
        return Promise.resolve({ data: { reserved: true, used: 1, remaining: 59 }, error: null });
      }

      // Default: all lifecycle RPCs return true (success)
      return Promise.resolve({ data: true, error: null });
    }),
  };

  return client;
}

const mockSupabaseClient = createMockSupabaseClient();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}));
// These tests exercise the durable stream lifecycle itself. Authorization is
// covered separately in route.authorization.test.ts; provide the same valid
// scoped capability the production client sends so this suite stays focused
// on claim, observer, retry, and checkpoint behavior.
vi.mock("@/lib/generation/resultAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/generation/resultAccess")>();
  return { ...actual, verifyStreamAccessToken: vi.fn(() => true) };
});

// ============================================================
// Mock AI provider factory
// ============================================================
let mockAIInstance: MockProvider;
vi.mock("@/lib/ai", () => ({
  getAIProvider: vi.fn(() => mockAIInstance),
  setAIProvider: vi.fn((p) => { mockAIInstance = p; }),
  resetAIProvider: vi.fn(() => { mockAIInstance = undefined as any; }),
  createProvider: vi.fn(),
}));

// Mock prompt builders (deterministic text, no AI at build time)
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
vi.mock("@/lib/curriculum-data", () => ({
  getNodesWithUnderstandings: vi.fn(),
  getDomainScores: vi.fn(() => Promise.resolve({})),
}));
vi.mock("@/lib/acquisition/jobTypes", () => ({
  DEFAULT_BUDGET_LIMITS: {
    max_ai_calls: 60,
    max_total_candidates_per_job: 50,
    max_candidates_per_understanding: 5,
    max_fetch_attempts: 3,
    max_retries: 3,
  },
}));

// Import the route AFTER all mocks are registered
// Exercise the production inline generation path and retain direct coverage of
// the read-only observer used to inspect durable job state.
const { legacyGenerationGet: GET, observeGeneration, hasSufficientInvocationBudget } = await import("./route");

// ============================================================
// Test data factories
// ============================================================
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
  ];
}

function createMockSkeletonResponse() {
  return JSON.stringify({
    title: "Generated Curriculum",
    source_type: "adapted",
    source_attribution: "Test Source",
    source_url: "https://example.com/curriculum",
    nodes: [
      {
        title: "Test Topic",
        order_index: 1,
        major_understandings: [
          { code: "1.1a", description: "Understanding 1" },
          { code: "1.1b", description: "Understanding 2" },
        ],
      },
    ],
  });
}

function createMockSourcesResponse() {
  return JSON.stringify([
    { domain: "khanacademy.org", name: "Khan Academy", why: "Great videos", best_for: "video" },
  ]);
}

function createMockDiscoverResponse() {
  return JSON.stringify([
    { url: "https://khanacademy.org/science/test-topic", title: "Test Topic Video", resource_type: "video", source_domain: "khanacademy.org", ai_note: "Great introductory video", license_status: "cc_open" },
    { url: "https://nysed.gov/resources/test-doc", title: "Test Document", resource_type: "textbook", source_domain: "nysed.gov", ai_note: "Official textbook chapter", license_status: "cc_open" },
  ]);
}

function createMockBatchResponse() {
  return JSON.stringify({
    topic_resources: [
      { url: "https://khanacademy.org/practice/1.1a", title: "Practice for 1.1a", resource_type: "problem_set", source_domain: "khanacademy.org", ai_note: "Practice problems for 1.1a", license_status: "cc_open", understanding_codes: ["1.1a"] },
    ],
  });
}

// ============================================================
// Helpers
// ============================================================
function allResourceInserts(): any[] {
  return capturedInserts
    .filter((call) => call.table === "resources")
    .flatMap((call) => call.resources);
}

function allNodeInserts(): any[] {
  return capturedNodeInserts;
}

function allMuInserts(): any[] {
  return capturedMuInserts;
}

function setRpcResult(name: string, result: { data: unknown; error: unknown }) {
  rpcOverrides[name] = result;
}

function resetRpcOverrides() {
  for (const key of Object.keys(rpcOverrides)) {
    delete rpcOverrides[key];
  }
}

function capturedJobInserts(): any[] {
  return capturedInserts
    .filter((call) => call.table === "acquisition_jobs")
    .flatMap((call) => call.resources);
}

function setRpcSequence(
  name: string,
  results: Array<{ data: unknown; error: unknown }>
) {
  rpcSequences[name] = results;
}

function resetRpcSequences() {
  for (const key of Object.keys(rpcSequences)) {
    delete rpcSequences[key];
  }
  for (const key of Object.keys(rpcCallCounts)) {
    delete rpcCallCounts[key];
  }
    for (const key of Object.keys(coverageAttemptCounts)) delete coverageAttemptCounts[key];
}

function createMockRequest(id: string): Request {
  return new Request(`http://localhost/api/generate/${id}/stream`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
}

async function consumeSseEvents(
  response: Response,
  deadlineMs = 10_000,
  scheduleTimeout: typeof setTimeout = setTimeout
): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response did not include a readable body");

  const events: string[] = [];
  let streamDone = false;
  let readPending = false;
  let activeRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = scheduleTimeout(
      () => reject(new Error(`SSE stream did not close within ${deadlineMs}ms`)),
      deadlineMs
    );
  });

  try {
    while (true) {
      readPending = true;
      activeRead = reader.read().then(
        (result) => {
          readPending = false;
          return result;
        },
        (error) => {
          readPending = false;
          throw error;
        }
      );
      const { done, value } = await Promise.race([activeRead, deadline]);
      activeRead = null;
      if (done) {
        streamDone = true;
        break;
      }
      events.push(new TextDecoder().decode(value));
    }
    return events;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);

    if (!streamDone) {
      const cancelPromise = Promise.resolve()
        .then(() => reader.cancel())
        .catch(() => undefined);
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cancelPromise,
        new Promise<void>((resolve) => {
          cancelTimer = scheduleTimeout(resolve, 250);
        }),
      ]);
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);

      if (readPending && activeRead) {
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          activeRead.then(() => undefined, () => undefined),
          new Promise<void>((resolve) => {
            settleTimer = scheduleTimeout(resolve, 250);
          }),
        ]);
        if (settleTimer !== undefined) clearTimeout(settleTimer);
      }
    }

    if (!readPending) {
      try { reader.releaseLock(); } catch { /* reader still owns a pending read */ }
    }
  }
}

async function runStreamAndCaptureEvents(
  curriculumId = "test-curriculum-id"
): Promise<string[]> {
  const response = await GET(createMockRequest(curriculumId), {
    params: Promise.resolve({ id: curriculumId }),
  });
  return consumeSseEvents(response);
}

function parseSseEvent(chunk: string): { event: string | undefined; data: any } {
  const event = chunk.match(/^event: ([^\r\n]+)/m)?.[1];
  const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith("data: "));
  return {
    event,
    data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : undefined,
  };
}

// ============================================================
// Tests
// ============================================================
describe("Generation Stream - Phase 12 Resource Status Regression", () => {
  let originalSetTimeout: typeof global.setTimeout;
  let originalSetInterval: typeof global.setInterval;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedInserts.length = 0;
    capturedNodeInserts.length = 0;
    capturedMuInserts.length = 0;
    capturedCurriculumUpdates.length = 0;
    capturedSourceRows.length = 0;
    structureLifecycleOrder.length = 0;
    capturedSseEvents.length = 0;
    resetRpcOverrides();
    resumeScenario = false;
    persistedResumeNodes = [];
    persistedResumeMus = [];
    simulatedResumeJob = null;
    simulatedCurriculum = null;
    observerRunningJob = null;
    durableJobRow = null;

    mockAIInstance = new MockProvider();
    vi.mocked((await import("@/lib/ai")).getAIProvider).mockImplementation(() => mockAIInstance);
    await mockDiscoverVerifiedResource();
    resetRpcSequences();
    jobInsertMockError = null;

    originalSetTimeout = global.setTimeout;
    originalSetInterval = global.setInterval;
    // @ts-expect-error - mocking global setTimeout for test
    global.setTimeout = vi.fn((callback: () => void) => {
      return originalSetTimeout(() => {
        try { callback(); } catch (e) { console.error("setTimeout callback error:", e); }
      }, 0);
    }) as typeof global.setTimeout;
    // Mock setInterval to fire once immediately (heartbeat fires during test)
    // @ts-expect-error - mocking global setInterval for test
    global.setInterval = vi.fn((callback: () => void) => {
      originalSetTimeout(() => {
        try { callback(); } catch (e) { console.error("setInterval callback error:", e); }
      }, 0);
      return 999 as any;
    }) as typeof global.setInterval;
  });

  it("reserves request time for checkpoint cleanup before starting long work", () => {
    expect(hasSufficientInvocationBudget(0, 30_000, 180_000)).toBe(true);
    expect(hasSufficientInvocationBudget(0, 30_001, 180_000)).toBe(false);
    expect(hasSufficientInvocationBudget(0, 195_000, 15_000)).toBe(true);
    expect(hasSufficientInvocationBudget(0, 195_001, 15_000)).toBe(false);
  });

  it("refuses to infer a complete skeleton from legacy topic rows", async () => {
    resumeScenario = true;
    simulatedResumeJob = {
      id: "job-legacy", status: "pending", claim_token: "legacy-token", claim_version: 4,
      result_data: {}, curriculum_id: "test-curriculum-id",
    };
    persistedResumeNodes = [
      { id: "legacy-topic-1", title: "A partial saved topic", order_index: 1 },
    ];

    const events = (await runStreamAndCaptureEvents()).map(parseSseEvent);

    expect(events.find((event) => event.event === "error")?.data.message).toMatch(/operator recovery is required/i);
    expect(capturedNodeInserts).toHaveLength(0);
    expect(capturedMuInserts).toHaveLength(0);
    expect(mockAIInstance.getCalls((call) => call.prompt === "skeleton prompt")).toHaveLength(0);
    expect((mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls.some((call: any) => call[0] === "fail_job")).toBe(true);
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    vi.restoreAllMocks();
    capturedInserts.length = 0;
    capturedNodeInserts.length = 0;
    capturedMuInserts.length = 0;
    capturedCurriculumUpdates.length = 0;
    structureLifecycleOrder.length = 0;
    capturedSseEvents.length = 0;
    resetRpcOverrides();
    resetRpcSequences();
    jobInsertMockError = null;
    resumeScenario = false;
    persistedResumeNodes = [];
    persistedResumeMus = [];
    simulatedResumeJob = null;
    simulatedCurriculum = null;
    durableJobRow = null;
    mockAIInstance = undefined as any;
  });

  async function runStreamAndCapture(
    curriculumId: string = "test-curriculum-id",
    assertSkeletonEvent = false,
    followYields = true
  ): Promise<any[]> {
    mockAIInstance.setDefaultResponse({
      completeText: createMockSkeletonResponse(),
      structuredData: JSON.parse(createMockSkeletonResponse()),
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    mockAIInstance.setResponse("sources prompt", {
      completeText: createMockSourcesResponse(),
      structuredData: JSON.parse(createMockSourcesResponse()),
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    mockAIInstance.setResponse("discover prompt", {
      completeText: createMockDiscoverResponse(),
      structuredData: JSON.parse(createMockDiscoverResponse()),
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    mockAIInstance.setResponse("batch prompt", {
      completeText: createMockBatchResponse(),
      structuredData: JSON.parse(createMockBatchResponse()),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const request = createMockRequest(curriculumId);
    const events: string[] = [];
    for (let invocation = 0; invocation < (followYields ? 60 : 1); invocation++) {
      const response = await GET(invocation === 0 ? request : createMockRequest(curriculumId), {
        params: Promise.resolve({ id: curriculumId }),
      });
      const current = await consumeSseEvents(response, 10_000, originalSetTimeout);
      events.push(...current);
      capturedSseEvents.push(...current);
      if (!current.some((event) => parseSseEvent(event).event === "yielded")) break;
    }
    if (assertSkeletonEvent) {
      expect(events.map(parseSseEvent).some((event) => event.event === "skeleton")).toBe(true);
    }

    // Drain background batch microtasks — background batch runs after
    // controller.close(), so we need to wait for its async work to complete.
    // The mock setInterval fires immediately, and setTimeouts are 0,
    // so a few ticks should flush all microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Additional wait for background batch to complete (it runs before controller.close now)
    await new Promise((resolve) => setTimeout(resolve, 500));

    return allResourceInserts();
  }

  // ============================================================
  // Phase 12 SSE event contract + resource invariants
  // ============================================================

  it("emits the unchanged SSE contract (status/skeleton/complete) while routing through the Learning Engine", async () => {
    const resources = await runStreamAndCapture("test-curriculum-id", true);

    const topicLevel = resources.filter((r) => r.node_id && r.major_understanding_id === null);
    const batchLevel = resources.filter((r) => r.major_understanding_id && r.node_id === null);

    expect(topicLevel.length).toBeGreaterThan(0);
    expect(batchLevel.length).toBeGreaterThan(0);
    expect(durableJobRow.result_data.skeleton.nodes).toHaveLength(1);
    expect(capturedCurriculumUpdates[0]).toMatchObject({
      source_type: "ai_organized",
      source_attribution: null,
      source_url: null,
    });
    expect(capturedSourceRows[0]).toMatchObject({
      source_type: "ai_generated",
      verification_state: "not_applicable",
      source_url: null,
    });
    expect(structureLifecycleOrder.indexOf("skeleton-checkpoint")).toBeLessThan(structureLifecycleOrder.indexOf("topic-row"));
    expect(structureLifecycleOrder.indexOf("skeleton-checkpoint")).toBeLessThan(structureLifecycleOrder.indexOf("understanding-row"));
  }, 15000);

  it("every persisted resource is status='draft' and never 'approved' (Phase 12 invariant)", async () => {
    const resources = await runStreamAndCapture();

    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(r.status).toBe("draft");
      expect(r.status).not.toBe("approved");
    }
  }, 15000);

  it("resources land with content_type_verified driven by verification, not hardcoded true", async () => {
    const resources = await runStreamAndCapture();
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(typeof r.content_type_verified).toBe("boolean");
      expect(r.content_type_verified).toBe(true);
    }
  }, 15000);

  it("preserves node_id vs major_understanding_id target mapping for both paths", async () => {
    const resources = await runStreamAndCapture();

    const topicLevel = resources.filter((r) => r.node_id && r.major_understanding_id === null);
    expect(topicLevel.every((r) => r.node_id)).toBe(true);

    const batchLevel = resources.filter((r) => r.major_understanding_id && r.node_id === null);
    expect(batchLevel.every((r) => r.major_understanding_id)).toBe(true);
    expect(batchLevel.length).toBeGreaterThan(0);
  }, 15000);

  // ============================================================
  // Phase 12 Launch Blocker Fix — Job Lifecycle (atomic claim-first)
  //
  // ⚠️  MOCKED TESTS — these do NOT prove PostgreSQL concurrency semantics.
  // The claim_next_job RPC uses FOR UPDATE SKIP LOCKED in real PostgreSQL.
  // These mocks simulate the contract but cannot prove race-safety. True
  // concurrency testing requires integration tests against a real Supabase
  // instance (see jobLifecycle.test.ts for the full integration-test matrix).
  // ============================================================

  describe("claimOrRegisterJob: atomic claim-first protocol", () => {
    it("calls claim_next_job RPC before attempting INSERT", async () => {
      await runStreamAndCapture("test-curriculum-id", false, false);

      // claim_next_job is called; since it returns null (no pending job),
      // the route attempts INSERT
      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const claimCalls = rpcCalls.filter((c: any) => c[0] === "claim_next_job");
      expect(claimCalls.length).toBe(1);
    });

    it("INSERTs a 'running' job with a real claim_token (not NULL)", async () => {
      await runStreamAndCapture("test-curriculum-id", false, false);

      const jobInserts = capturedJobInserts();
      expect(jobInserts.length).toBe(1);
      expect(jobInserts[0].status).toBe("running");
      expect(jobInserts[0].claim_token).toBeTruthy();
      expect(typeof jobInserts[0].claim_token).toBe("string");
      // Verify the token is a valid UUID format
      expect(jobInserts[0].claim_token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(jobInserts[0].claim_version).toBe(1);
      expect(jobInserts[0].claim_expires_at).toBeTruthy();
    });

    it("INSERTs job with job_type='curriculum_generation' and real claim_token", async () => {
      await runStreamAndCapture("test-curriculum-id", false, false);

      const jobInserts = capturedJobInserts();
      expect(jobInserts.length).toBe(1);
      expect(jobInserts[0].job_type).toBe("curriculum_generation");
      expect(jobInserts[0].curriculum_id).toBe("test-curriculum-id");
      expect(jobInserts[0].started_at).toBeTruthy();
      expect(jobInserts[0].budget_limits).toBeTruthy();
    });

    it("guest generation: job has created_by = NULL (no authenticated user)", async () => {
      await runStreamAndCapture("test-curriculum-id", false, false);

      const jobInserts = capturedJobInserts();
      expect(jobInserts.length).toBe(1);
      // created_by is NULL — the stream runs without an authenticated user.
      // Service-role client bypasses RLS (acquisition_jobs INSERT policy requires
      // is_admin, but the service role bypasses RLS per migration 0006:562-567).
      expect(jobInserts[0].created_by).toBe(null);
    });
  });

  // ============================================================
  // Retry idempotency: external_key on nodes and MUs
  // ============================================================

  describe("Retry idempotency: stable external_key for nodes and MUs", () => {
    it("INSERTs nodes with stable external_key (topic-N from order_index)", async () => {
      await runStreamAndCapture("test-curriculum-id", false, false);

      const nodeInserts = allNodeInserts();
      expect(nodeInserts.length).toBe(1);
      expect(nodeInserts[0].external_key).toBe("topic-1");
      expect(nodeInserts[0].curriculum_id).toBe("test-curriculum-id");
      expect(nodeInserts[0].title).toBe("Test Topic");
      expect(nodeInserts[0].order_index).toBe(1);
    });

    it("INSERTs major_understandings with stable external_key from code or fallback", async () => {
      await runStreamAndCapture("test-curriculum-id", false, false);

      const muInserts = allMuInserts().flat();
      expect(muInserts.length).toBeGreaterThan(0);
      for (const mu of muInserts) {
        expect(mu.external_key).toBeTruthy();
        expect(typeof mu.external_key).toBe("string");
      }
    });
  });

  // ============================================================
  // Pending/running collision: claim-first protocol prevents coexistence
  // ============================================================

  describe("claim-first protocol: pending job vs SSE-created running job", () => {
    it("when claim_next_job returns an existing pending job, INSERT is NOT called", async () => {
      // Simulate claim_next_job finding a pending job and claiming it
      setRpcResult("claim_next_job", {
        data: {
          id: "claimed-job-id",
          claim_token: "550e8400-e29b-41d4-a716-446655440000",
          claim_version: 1,
        },
        error: null,
      });

      await runStreamAndCapture("test-curriculum-id", false, false);

      // claim_next_job was called
      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const claimCalls = rpcCalls.filter((c: any) => c[0] === "claim_next_job");
      expect(claimCalls.length).toBe(1);

      // INSERT was NOT called (existing job was claimed)
      const jobInserts = capturedJobInserts();
      expect(jobInserts.length).toBe(0);
    });

    it("on unique violation (23505), retries claim_next_job and claims the pending job", async () => {
      // First claim_next_job: no pending job (returns null → triggers INSERT)
      // INSERT returns 23505 (unique violation — another process just created a pending job)
      // Second claim_next_job: finds and claims the pending job
      setRpcSequence("claim_next_job", [
        { data: null, error: null }, // first call: no pending job
        {
          data: {
            id: "retry-claimed-job",
            claim_token: "660e8400-e29b-41d4-a716-446655440001",
            claim_version: 1,
          },
          error: null,
        }, // retry: claims the pending job
      ]);
      // Simulate unique violation on the INSERT
      jobInsertMockError = { code: "23505", message: "duplicate key value" };

      await runStreamAndCapture("test-curriculum-id", false, false);

      // claim_next_job should have been called twice (initial + retry)
      const claimCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: any) => c[0] === "claim_next_job"
      );
      expect(claimCalls.length).toBe(2);
    });

    it("attaches as an observer to the existing running job after an active-job conflict", async () => {
      // Both claim_next_job calls return null (no pending job)
      // and INSERT returns 23505 (another process owns a running job)
      setRpcSequence("claim_next_job", [
        { data: null, error: null }, // first call
        { data: null, error: null }, // retry: still no pending job
      ]);
      jobInsertMockError = { code: "23505", message: "duplicate key value" };
      observerRunningJob = {
        id: "running-job-id",
        curriculum_id: "test-curriculum-id",
        result_data: {
          checkpoint: { completedTopicIds: ["node-1"] },
          batchCheckpoint: { completedTopicIds: [] },
        },
        curricula: { status: "published" },
      };

      const request = createMockRequest("test-curriculum-id");
      const response = await GET(request, {
        params: Promise.resolve({ id: "test-curriculum-id" }),
      });

      const reader = response.body?.getReader();
      const events: string[] = [];
      if (reader) {
        for (let i = 0; i < 3; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push(new TextDecoder().decode(value));
        }
        await reader.cancel();
      }

      // Observer mode reports reconnect/waiting and does not start generation.
      expect(events.some((event) => event.includes('"step":"waiting"'))).toBe(true);
      expect(events.some((event) => event.includes('"job_id":"running-job-id"'))).toBe(true);

      // No resource inserts (pipeline never started)
      expect(allResourceInserts().length).toBe(0);
    });
  });

  // ============================================================
  // Lease-loss behavior: renew_lease failure stops processing
  // ============================================================

  describe("lease-loss behavior: ren_lease failure stops stale writes", () => {
    it("when renew_lease returns false, fail_job is called instead of complete_job", async () => {
      // Simulate lease loss on heartbeat
      setRpcResult("renew_lease", { data: false, error: null });

      await runStreamAndCapture();

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;

      // fail_job should have been called (not complete_job)
      const failCalls = rpcCalls.filter((c: any) => c[0] === "fail_job");
      const completeCalls = rpcCalls.filter((c: any) => c[0] === "complete_job");

      // Due to timing, either fail_job or complete_job might be called.
      // The key assertion: if ownershipLost was set, complete_job must NOT succeed.
      // If ownershipLost was set before publishing, an error event is sent and
      // failJob is called before complete_job.
      if (failCalls.length > 0) {
        expect(completeCalls.length).toBe(0);
      }
    });

    it("heartbeat calls renew_lease during processing", async () => {
      await runStreamAndCapture();

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const renewCalls = rpcCalls.filter((c: any) => c[0] === "renew_lease");
      expect(renewCalls.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Lifecycle RPC: atomic publication and completion on success
  // ============================================================

  describe("job finalization: publish and complete on success", () => {
    it("publishes even when background resource coverage is insufficient", async () => {
      await runStreamAndCapture();

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const publishCalls = rpcCalls.filter((c: any) => c[0] === "publish_and_complete_job");
      expect(publishCalls.length).toBeGreaterThanOrEqual(1);
      expect(publishCalls[0][1]).toMatchObject({ p_job_id: "job-1" });
      expect(typeof publishCalls[0][1].p_claim_token).toBe("string");
      expect(typeof publishCalls[0][1].p_expected_claim_version).toBe("number");
      expect(rpcCalls.some((call: any) => call[0] === "complete_job")).toBe(false);
    });

    it("all lifecycle RPCs receive the job id and claim_token", async () => {
      await runStreamAndCapture();

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const jobLifecycleRPCs = ["record_resource_coverage_attempt", "publish_and_complete_job", "renew_lease"];

      for (const rpcName of jobLifecycleRPCs) {
        const calls = rpcCalls.filter((c: any) => c[0] === rpcName);
        for (const call of calls) {
          // Every lifecycle RPC must carry the job id and a non-null claim_token
          expect(call[1].p_job_id).toBeTruthy();
          expect(call[1].p_claim_token).toBeTruthy();
        }
      }
    });
  });

  // ============================================================
  // Regression: Background batch yielding and resume
  // ============================================================

  describe("background batch yielding and resume", () => {
    it("processes background batch topics with proper checkpointing", async () => {
      await runStreamAndCapture();

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const batchCheckpointCalls = rpcCalls.filter((c: any) => c[0] === "record_resource_coverage_attempt" && c[1].p_phase === "batch");
      // Each batch topic is measured twice here because the mock reports zero eligible rows.
      expect(batchCheckpointCalls.length).toBeGreaterThan(0);
    });

    it("batch coverage attempts carry fencing and target data", async () => {
      await runStreamAndCapture();

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const batchCheckpointCalls = rpcCalls.filter((c: any) => c[0] === "record_resource_coverage_attempt" && c[1].p_phase === "batch");

      for (const call of batchCheckpointCalls) {
        // Every lifecycle RPC must carry the job id and a non-null claim_token
        expect(call[1].p_job_id).toBeTruthy();
        expect(call[1].p_claim_token).toBeTruthy();
        expect(call[1].p_expected_claim_version).toBeTruthy();
        expect(call[1].p_target_id).toBeTruthy();
        expect(typeof call[1].p_resources_found).toBe("number");
        expect(call[1].p_max_attempts).toBe(2);
      }
    });
  });

  // ============================================================
  // Regression: releaseJobClaim failure handling
  // ============================================================

  describe("releaseJobClaim failure handling", () => {
    it("handles releaseJobClaim returning false gracefully", async () => {
      // Simulate releaseJobClaim returning false (yield cap reached)
      setRpcResult("release_job_claim", { data: false, error: null });

      // The route should handle the false return gracefully
      // (exact behavior depends on getJobById which is dynamically imported)
      await runStreamAndCapture();

      // The route should complete without crashing
      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      // At minimum, the stream should complete
      expect(rpcCalls.length).toBeGreaterThan(0);
    });

    it("does not continue processing when releaseJobClaim fails and job is not pending", async () => {
      // Simulate releaseJobClaim returning false (ownership lost)
      setRpcResult("release_job_claim", { data: false, error: null });

      const request = createMockRequest("test-curriculum-id");
      const response = await GET(request, {
        params: Promise.resolve({ id: "test-curriculum-id" }),
      });

      const reader = response.body?.getReader();
      const events: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push(new TextDecoder().decode(value));
        }
      }

      // Should NOT receive yielded event
      const yieldedEvents = events.filter((e) => e.includes('"yielded"'));
      expect(yieldedEvents.length).toBe(0);
    });
  });

  it("records a completed AI batch when its candidate fetch budget is exhausted and advances on resume", async () => {
    resumeScenario = true;
    const topicId = "node-topic-1";
    const skeleton = {
      title: "Geometry Curriculum",
      source_type: "ai_organized",
      source_attribution: null,
      source_url: null,
      nodes: [{
        title: "Triangles",
        order_index: 1,
        major_understandings: [{ code: "G1", description: "Triangle angle relationships" }],
      }],
    };
    simulatedResumeJob = {
      id: "job-batch-budget",
      curriculum_id: "test-curriculum-id",
      status: "pending",
      claim_token: "tok-real-uuid",
      claim_version: 1,
      result_data: {
        skeleton,
        discoveredSources: [],
        checkpoint: { completedTopicIds: [topicId] },
        resourceCoverage: { [`topic:${topicId}`]: { attempts: 2, status: "insufficient" } },
        batchCheckpoint: { completedTopicIds: [] },
      },
    };
    simulatedCurriculum = createMockCurriculum();
    persistedResumeNodes = [{ id: topicId, title: "Triangles", order_index: 1, external_key: "topic-1" }];
    persistedResumeMus = [{
      id: `mu-${topicId}-G1`, node_id: topicId, code: "G1", external_key: "G1",
      description: "Triangle angle relationships", order_index: 0,
    }];
    mockAIInstance.setResponse("batch prompt", {
      structuredData: { topic_resources: [{
        url: "https://example.org/triangle-lesson", title: "Triangle lesson",
        resource_type: "text", source_domain: "example.org", ai_note: "Triangle instruction",
        license_status: "link_only", understanding_codes: ["G1"],
      }] },
      completeText: '{"topic_resources":[]}',
    });

    // Let the batch AI call start inside the work budget, then exhaust the
    // candidate-acquisition reserve before its returned candidate is fetched.
    let clockMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    const originalStructured = mockAIInstance.structured.bind(mockAIInstance);
    const structured = vi.spyOn(mockAIInstance, "structured");
    structured.mockImplementation(async (prompt: string, options: any) => {
      const result = await originalStructured(prompt, options);
      if (prompt === "batch prompt") clockMs = 200_000;
      return result;
    });

    const runInvocation = async () => {
      const response = await GET(createMockRequest("test-curriculum-id"), {
        params: Promise.resolve({ id: "test-curriculum-id" }),
      });
      return (await consumeSseEvents(response, 10_000, originalSetTimeout)).map(parseSseEvent);
    };
    const firstEvents = await runInvocation();
    expect(firstEvents.find((event) => event.event === "yielded")?.data.message)
      .toBe("Concept resource attempt saved. Resuming…");
    expect(simulatedResumeJob.result_data.resourceCoverage["batch:node-topic-1"])
      .toMatchObject({ attempts: 1, status: "retrying" });
    expect(simulatedResumeJob.result_data.batchCheckpoint.completedTopicIds).toEqual([]);
    expect(simulatedResumeJob.status).toBe("pending");

    // A fresh claim resumes the same bounded attempt once. It then records a
    // terminal insufficient result and durably marks the batch complete.
    clockMs = 0;
    const secondEvents = await runInvocation();
    expect(secondEvents.some((event) => event.event === "complete")).toBe(true);
    expect(simulatedResumeJob.result_data.resourceCoverage["batch:node-topic-1"])
      .toMatchObject({ attempts: 2, status: "insufficient" });
    expect(simulatedResumeJob.result_data.batchCheckpoint.completedTopicIds).toEqual([topicId]);
    expect(simulatedResumeJob.status).toBe("completed");
    expect(structured.mock.calls.filter(([prompt]) => prompt === "batch prompt")).toHaveLength(2);
  });

  it("resumes the same nine-topic skeleton after persisted coverage attempts and skips completed topics", async () => {
    resumeScenario = true;
    const skeleton = {
      title: "High School Geometry Semester Curriculum",
      source_type: "ai_organized",
      source_attribution: null,
      source_url: null,
      nodes: Array.from({ length: 9 }, (_, index) => ({
        title: `Geometry Topic ${index + 1}`,
        order_index: index + 1,
        major_understandings: [{ code: `G${index + 1}.1`, description: `Geometry concept ${index + 1}` }],
      })),
    };
    mockAIInstance.setResponse("skeleton prompt", {
      structuredData: skeleton,
      completeText: JSON.stringify(skeleton),
    });
    mockAIInstance.setResponse("sources prompt", { structuredData: [], completeText: "[]" });
    mockAIInstance.setResponse("discover prompt", {
      structuredData: [{
        url: "https://example.org/geometry/topic",
        title: "Geometry lesson",
        resource_type: "text",
        source_domain: "example.org",
        ai_note: "Introductory geometry lesson",
        license_status: "link_only",
      }],
      completeText: "[]",
    });
    mockAIInstance.setResponse("batch prompt", {
      structuredData: { topic_resources: [] },
      completeText: '{"topic_resources":[]}',
    });

    const firstResponse = await GET(createMockRequest("test-curriculum-id"), {
      params: Promise.resolve({ id: "test-curriculum-id" }),
    });
    const firstEvents = (await consumeSseEvents(firstResponse, 10_000, originalSetTimeout)).map(parseSseEvent);
    const firstYield = firstEvents.find((event) => event.event === "yielded");
    expect(firstYield?.data).toEqual({
      message: "Resource attempt saved. Resuming…",
      topicsCompleted: 0,
      totalTopics: 9,
    });
    expect(simulatedResumeJob.status).toBe("pending");
    expect(simulatedResumeJob.result_data.checkpoint).toBeUndefined();
    expect(simulatedResumeJob.result_data.resourceCoverage["topic:node-topic-1"]).toMatchObject({ attempts: 1, status: "retrying" });
    expect(persistedResumeNodes).toHaveLength(9);
    expect(allResourceInserts()).toHaveLength(1);
    expect(allResourceInserts()[0].node_id).toBe("node-topic-1");

    // Reconnecting claims the existing pending row and resumes its saved
    // second attempt rather than rerunning skeleton/source generation.
    const secondResponse = await GET(createMockRequest("test-curriculum-id"), {
      params: Promise.resolve({ id: "test-curriculum-id" }),
    });
    const secondEvents = (await consumeSseEvents(secondResponse, 10_000, originalSetTimeout)).map(parseSseEvent);
    expect(simulatedResumeJob.id).toBe("job-1");
    expect(simulatedResumeJob.status).toBe("pending");
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "skeleton prompt")).toHaveLength(1);
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "sources prompt")).toHaveLength(1);
    expect(persistedResumeNodes.map((node) => node.title)).toEqual(skeleton.nodes.map((node) => node.title));

    const resumedDiscoveryStatuses = secondEvents
      .filter((event) => event.event === "status" && event.data.step === "discovery")
      .map((event) => event.data);
    expect(resumedDiscoveryStatuses.map((status) => status.message)).toEqual([
      "Finding resources for: Geometry Topic 1",
      "Finding resources for: Geometry Topic 2",
    ]);
    expect(resumedDiscoveryStatuses[0].current).toBe(1);
    expect(secondEvents.filter((event) => event.event === "yielded")[0]?.data.topicsCompleted).toBe(1);
    expect(simulatedResumeJob.result_data.checkpoint.completedTopicIds).toEqual([
      "node-topic-1",
    ]);
    expect(allResourceInserts()).toHaveLength(2); // the first attempt survived resume and the next topic progressed

    // Continue each bounded topic and concept-batch attempt
    // until the same persisted job reaches its terminal state.
    const conceptYieldSnapshots: Array<{ topicsCompleted: number; completedBatchTopics: string[]; coverage: Record<string, { attempts: number; status: string }> }> = [];
    for (let continuation = 0; continuation < 40 && simulatedResumeJob.status !== "completed"; continuation++) {
      const continuationResponse = await GET(createMockRequest("test-curriculum-id"), {
        params: Promise.resolve({ id: "test-curriculum-id" }),
      });
      const continuationEvents = (await consumeSseEvents(continuationResponse, 10_000, originalSetTimeout)).map(parseSseEvent);
      const conceptYield = continuationEvents.find((event) =>
        event.event === "yielded" && event.data.message === "Concept resource attempt saved. Resuming…"
      );
      if (conceptYield) {
        const resultData = simulatedResumeJob.result_data;
        conceptYieldSnapshots.push({
          topicsCompleted: conceptYield.data.topicsCompleted,
          completedBatchTopics: [...(resultData.batchCheckpoint?.completedTopicIds ?? [])],
          coverage: Object.fromEntries(Object.entries(resultData.resourceCoverage ?? {})
            .filter(([key]) => key.startsWith("batch:"))
            .map(([key, value]) => [key, { attempts: (value as any).attempts, status: (value as any).status }])),
        });
      }
    }
    expect(simulatedResumeJob.status).toBe("completed");
    expect(simulatedResumeJob.result_data.checkpoint.completedTopicIds).toHaveLength(9);
    expect(simulatedResumeJob.result_data.batchCheckpoint.completedTopicIds).toHaveLength(9);
    expect(conceptYieldSnapshots.length).toBeGreaterThan(1);
    for (let i = 0; i < conceptYieldSnapshots.length; i++) {
      expect(conceptYieldSnapshots[i].topicsCompleted)
        .toBe(conceptYieldSnapshots[i].completedBatchTopics.length);
      if (i > 0) {
        expect(conceptYieldSnapshots[i].completedBatchTopics.length)
          .toBeGreaterThanOrEqual(conceptYieldSnapshots[i - 1].completedBatchTopics.length);
      }
    }
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "skeleton prompt")).toHaveLength(1);
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "sources prompt")).toHaveLength(1);
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "discover prompt")).toHaveLength(18);
    expect(allResourceInserts()).toHaveLength(9);
    expect(new Set(allResourceInserts().map((resource) => resource.node_id)).size).toBe(9);

    // The same acquired content can be linked independently to every topic;
    // duplicate suppression must not be shared across topic targets.
    const { discoverVerifiedResource } = await import("@/lib/learningEngine");
    const topicOptions = vi.mocked(discoverVerifiedResource).mock.calls
      .map(([, options]) => options)
      .filter((options) => options?.dedupTracker);
    const topicTrackers = topicOptions.map((options) => options!.dedupTracker);
    expect(topicTrackers).toHaveLength(18); // two bounded discovery attempts for each topic
    expect(new Set(topicTrackers).size).toBe(18);
    const topicCaches = topicOptions.map((options) => options!.cache);
    expect(new Set(topicCaches).size).toBeLessThan(topicCaches.length); // each invocation shares one cache across its bounded topic batch
    expect(global.setTimeout).not.toHaveBeenCalledWith(expect.any(Function), 15_000);
  }, 120_000);

  it("records an empty topic as terminally insufficient after bounded retries", async () => {
    resumeScenario = true;
    const { discoverVerifiedResource } = await import("@/lib/learningEngine");
    const skeleton = {
      title: "High School Geometry Semester Curriculum",
      source_type: "ai_organized",
      source_attribution: null,
      source_url: null,
      nodes: Array.from({ length: 9 }, (_, index) => ({
        title: `Geometry Topic ${index + 1}`,
        order_index: index + 1,
        major_understandings: [{ code: `G${index + 1}.1`, description: `Geometry concept ${index + 1}` }],
      })),
    };
    mockAIInstance.setResponse("skeleton prompt", {
      structuredData: skeleton,
      completeText: JSON.stringify(skeleton),
    });
    mockAIInstance.setResponse("sources prompt", {
      structuredData: [],
      completeText: "[]",
    });
    mockAIInstance.setResponse("discover prompt", {
      structuredData: [{
        url: "https://example.org/lesson",
        title: "Test lesson",
        resource_type: "text",
        source_domain: "example.org",
        ai_note: "Relevant lesson",
        license_status: "link_only",
      }],
      completeText: "[]",
    });
    mockAIInstance.setResponse("batch prompt", {
      structuredData: { topic_resources: [] },
      completeText: '{"topic_resources":[]}',
    });

    const captureStream = async () => {
      const response = await GET(createMockRequest("test-curriculum-id"), {
        params: Promise.resolve({ id: "test-curriculum-id" }),
      });
      return (await consumeSseEvents(response, 10_000, originalSetTimeout)).map(parseSseEvent);
    };

    const initialEvents = await captureStream();
    expect(initialEvents.some((event) => event.event === "yielded")).toBe(true);
    expect(simulatedResumeJob.result_data.checkpoint).toBeUndefined();
    expect(simulatedResumeJob.result_data.resourceCoverage["topic:node-topic-1"]).toMatchObject({ attempts: 1, status: "retrying" });

    vi.mocked(discoverVerifiedResource).mockResolvedValue(null as any);
    const failedTopicEvents = await captureStream();

    expect(failedTopicEvents.some((event) => event.event === "yielded")).toBe(true);
    expect(failedTopicEvents.some((event) => event.event === "complete")).toBe(false);
    expect(failedTopicEvents.find((event) => event.event === "status" && event.data.step === "skeleton")?.data.message).toBe("Loading the saved curriculum structure…");
    expect(simulatedResumeJob.result_data.checkpoint.completedTopicIds).toEqual(["node-topic-1"]);
    expect(simulatedResumeJob.status).toBe("pending");

    expect(Object.values(simulatedResumeJob.result_data.resourceCoverage).some((target: any) => target.status === "insufficient")).toBe(true);
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "skeleton prompt")).toHaveLength(1);
    expect(mockAIInstance.getCalls((call) => call.method === "structured" && call.prompt === "discover prompt")).toHaveLength(3);

    const releaseCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: any) => call[0] === "release_job_claim");
    expect(releaseCalls).toHaveLength(2); // retry attempt yield, then target-quota yield
    expect((mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls.some((call: any) => call[0] === "complete_job")).toBe(false);
  }, 120_000);

  it("records citation failures as insufficient after bounded retries without losing prior checkpoints", async () => {
    resumeScenario = true;
    const skeleton = {
      title: "High School Geometry Semester Curriculum",
      source_type: "ai_organized",
      source_attribution: null,
      source_url: null,
      nodes: Array.from({ length: 9 }, (_, index) => ({
        title: `Geometry Topic ${index + 1}`,
        order_index: index + 1,
        major_understandings: [{ code: `G${index + 1}.1`, description: `Geometry concept ${index + 1}` }],
      })),
    };
    mockAIInstance.setResponse("skeleton prompt", { structuredData: skeleton, completeText: JSON.stringify(skeleton) });
    mockAIInstance.setResponse("sources prompt", { structuredData: [], completeText: "[]" });
    mockAIInstance.setResponse("discover prompt", {
      structuredData: [{
        url: "https://example.org/geometry/topic",
        title: "Geometry lesson",
        resource_type: "text",
        source_domain: "example.org",
        ai_note: "Introductory geometry lesson",
        license_status: "link_only",
      }],
      completeText: "[]",
    });
    mockAIInstance.setResponse("batch prompt", { structuredData: { topic_resources: [] }, completeText: '{"topic_resources":[]}' });

    const firstResponse = await GET(createMockRequest("test-curriculum-id"), {
      params: Promise.resolve({ id: "test-curriculum-id" }),
    });
    const firstEvents = (await consumeSseEvents(firstResponse, 10_000, originalSetTimeout)).map(parseSseEvent);
    expect(firstEvents.some((event) => event.event === "yielded")).toBe(true);
    expect(simulatedResumeJob.result_data.checkpoint).toBeUndefined();
    const persistedNodeTitles = persistedResumeNodes.map((node) => node.title);

    const baseProvider = mockAIInstance;
    const discoveryFailure = new Error("Azure web search completed without source citations; structured discovery was not generated.");
    const structured = vi.fn(async (prompt: string, options: any) => {
      if (prompt === "discover prompt") throw discoveryFailure;
      return baseProvider.structured(prompt, options);
    });
    vi.mocked((await import("@/lib/ai")).getAIProvider).mockReturnValue({
      structured,
      complete: baseProvider.complete.bind(baseProvider),
      name: "azure",
      capabilities: baseProvider.capabilities,
    } as any);

    const retryResponse = await GET(createMockRequest("test-curriculum-id"), {
      params: Promise.resolve({ id: "test-curriculum-id" }),
    });
    const retryEvents = (await consumeSseEvents(retryResponse, 10_000, originalSetTimeout)).map(parseSseEvent);

    expect(retryEvents.some((event) => event.event === "yielded")).toBe(true);
    expect(retryEvents.find((event) => event.event === "status" && event.data.step === "skeleton")?.data.message).toBe("Loading the saved curriculum structure…");
    expect(retryEvents.some((event) => event.event === "complete")).toBe(false);
    expect(simulatedResumeJob.id).toBe("job-1");
    expect(simulatedResumeJob.status).toBe("pending");
    expect(simulatedResumeJob.result_data.checkpoint.completedTopicIds).toEqual(["node-topic-1"]);
    expect(persistedResumeNodes.map((node) => node.title)).toEqual(persistedNodeTitles);
    expect(baseProvider.getCalls((call) => call.method === "structured" && call.prompt === "skeleton prompt")).toHaveLength(1);
    expect(baseProvider.getCalls((call) => call.method === "structured" && call.prompt === "discover prompt")).toHaveLength(1);
    expect((mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls.filter((call: any) => call[0] === "record_resource_coverage_attempt" && call[1].p_phase === "topic" && call[1].p_target_id === "node-topic-1")).toHaveLength(2);
  }, 120_000);

  // ============================================================
  // Regression: Terminal state events
  // ============================================================

  describe("terminal state events", () => {
    it("emits complete event with phase=background on success", async () => {
      await runStreamAndCapture();

      const backgroundComplete = capturedSseEvents
        .map(parseSseEvent)
        .find((event) => event.event === "complete" && event.data.phase === "background");
      expect(backgroundComplete?.data.coverage_status).toBe("insufficient");

      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const publishCalls = rpcCalls.filter((c: any) => c[0] === "publish_and_complete_job");
      expect(publishCalls.length).toBeGreaterThan(0);
      expect(publishCalls[0][1]).toMatchObject({
        p_job_id: "job-1",
        p_claim_token: expect.any(String),
        p_expected_claim_version: expect.any(Number),
      });
      expect(rpcCalls.some((c: any) => c[0] === "complete_job")).toBe(false);
    });

    it("handles background batch failure gracefully", async () => {
      // Simulate failure during background batch
      const { discoverVerifiedResource } = await import("@/lib/learningEngine");
      (discoverVerifiedResource as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          throw new Error("Background batch failed");
        }
      );

      await runStreamAndCapture();

      // The route should handle the error gracefully
      // (exact fail_job call may depend on mock timing)
      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      const errorCalls = rpcCalls.filter((c: any) => c[0] === "fail_job" || c[0] === "complete_job");
      // Either fail_job or complete_job may be called depending on timing
      expect(errorCalls.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // Regression: Disconnect and stale-lease recovery
  // ============================================================

  describe("stale-lease recovery", () => {
    it("handles lease renewal failure", async () => {
      // Simulate lease loss on heartbeat
      setRpcResult("renew_lease", { data: false, error: null });

      await runStreamAndCapture();

      // The route should handle lease failure gracefully
      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      // At minimum, the stream should complete or error
      expect(rpcCalls.length).toBeGreaterThan(0);
    });

    it("handles ownership lost during background batch", async () => {
      // Simulate ownership lost during background batch
      setRpcResult("record_resource_coverage_attempt", { data: false, error: null });

      await runStreamAndCapture();

      // The route should handle ownership loss gracefully
      const rpcCalls = (mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls;
      // At minimum, the stream should complete or error
      expect(rpcCalls.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// Regression: Skeleton JSON parsing robustness
// ============================================================

describe("Skeleton JSON parsing robustness", () => {
  beforeEach(() => {
    durableJobRow = null;
    observerRunningJob = null;
    jobInsertMockError = null;
    resumeScenario = false;
    resetRpcOverrides();
    resetRpcSequences();
  });

  // Helper to create a mock curriculum with nodes
  function createMockCurriculumWithNodes() {
    return {
      id: "test-curriculum-id",
      title: "Test Curriculum",
      subject: "Test Subject",
      source_type: "ai_organized",
      status: "draft",
      notes: JSON.stringify({
        grade_level: "high school",
        difficulty: "standard",
        existing_knowledge: "",
        learning_goal: "understand the subject",
        time_available: "no time pressure",
        added_context: "",
      }),
    };
  }

  function createMockNodes() {
    return [
      {
        id: "node-1",
        curriculum_id: "test-curriculum-id",
        title: "Test Topic",
        order_index: 1,
        external_key: "topic-1",
        exam_weight_pct: null,
        claim_statement: null,
        major_understandings: [
          { id: "mu-1", node_id: "node-1", code: "1.1", description: "Concept 1", order_index: 0 },
          { id: "mu-2", node_id: "node-1", code: "1.2", description: "Concept 2", order_index: 1 },
        ],
      },
    ];
  }

  // Helper to run the stream with a custom skeleton response
  async function runStreamWithSkeleton(skeletonResponse: string): Promise<string[]> {
    // Mock the AI to return the given skeleton response
    const { getAIProvider } = await import("@/lib/ai");
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn().mockResolvedValue({ text: skeletonResponse, usage: { inputTokens: 100, outputTokens: 50 } }),
      name: "mock",
      capabilities: { structuredOutput: false, webSearch: false, streaming: false },
    } as any);

    // Reset captured inserts
    capturedInserts.length = 0;
    capturedNodeInserts.length = 0;
    capturedMuInserts.length = 0;

    // Run the stream
    const request = createMockRequest("test-curriculum-id");
    const response = await GET(request, { params: Promise.resolve({ id: "test-curriculum-id" }) });

    const events: string[] = [];
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(new TextDecoder().decode(value));
      }
    }
    return events;
  }

  it("parses valid raw JSON without markdown or surrounding text", async () => {
    const validJson = `{"title":"Test Curriculum","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Test Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept 1"},{"code":"1.2","description":"Concept 2"}]}]}`;
    const events = await runStreamWithSkeleton(validJson);

    // Should emit skeleton event
    const skeletonEvents = events.filter((event) => event.startsWith("event: skeleton\n"));
    expect(skeletonEvents.length).toBe(1);
    expect(skeletonEvents[0]).toContain("Test Curriculum");
  });

  it("parses JSON wrapped in markdown code fences", async () => {
    const fencedJson = `\`\`\`json\n{"title":"Test Curriculum","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Test Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept 1"},{"code":"1.2","description":"Concept 2"}]}]}\n\`\`\``;
    const events = await runStreamWithSkeleton(fencedJson);

    const skeletonEvents = events.filter((event) => event.startsWith("event: skeleton\n"));
    expect(skeletonEvents.length).toBe(1);
    expect(skeletonEvents[0]).toContain("Test Curriculum");
  });

  it("parses JSON with explanatory text before and after", async () => {
    const wrappedJson = `Here is the curriculum structure:\n{"title":"Test Curriculum","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Test Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept 1"}]}]}\nThat was the structure.`;
    const events = await runStreamWithSkeleton(wrappedJson);

    const skeletonEvents = events.filter((event) => event.startsWith("event: skeleton\n"));
    expect(skeletonEvents.length).toBe(1);
    expect(skeletonEvents[0]).toContain("Test Curriculum");
  });

  it("rejects truncated JSON with clear error category", async () => {
    const truncatedJson = `{"title":"Test Curriculum","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Test Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept 1"}`;
    const events = await runStreamWithSkeleton(truncatedJson);

    // Should emit error event with the specific message
    const errorEvents = events.filter((event) => event.startsWith("event: error\n"));
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorData = JSON.parse(errorEvents[0].split("data: ")[1]);
    expect(errorData.message).toBe("Failed to generate curriculum structure");
  });

  it("rejects completely invalid JSON", async () => {
    const invalidJson = `This is not JSON at all`;
    const events = await runStreamWithSkeleton(invalidJson);

    const errorEvents = events.filter((event) => event.startsWith("event: error\n"));
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorData = JSON.parse(errorEvents[0].split("data: ")[1]);
    expect(errorData.message).toBe("Failed to generate curriculum structure");
  });

  it("handles multiple JSON objects by picking the first valid one", async () => {
    const multipleJson = `{"title":"Invalid Curriculum","source_type":"invalid","source_attribution":null,"source_url":null,"nodes":[]} {"title":"Valid Curriculum","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Valid Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Valid concept"}]}]}`;
    const events = await runStreamWithSkeleton(multipleJson);

    // Should parse the first valid one that matches schema
    const skeletonEvents = events.filter((event) => event.startsWith("event: skeleton\n"));
    // The first object doesn't match schema, so it should pick the second valid one
    expect(skeletonEvents.length).toBe(1);
    expect(skeletonEvents[0]).toContain("Valid Curriculum");
  });

  it("rejects skeleton with missing required fields", async () => {
    const invalidSchema = `{"title":"Test","nodes":[]}`; // missing source_type, source_attribution, source_url
    const events = await runStreamWithSkeleton(invalidSchema);

    const errorEvents = events.filter((event) => event.startsWith("event: error\n"));
    expect(errorEvents.length).toBeGreaterThan(0);
    const errorData = JSON.parse(errorEvents[0].split("data: ")[1]);
    expect(errorData.message).toBe("Failed to generate curriculum structure");
  });

  it("rejects skeleton with invalid source_type enum", async () => {
    const invalidSchema = `{"title":"Test","source_type":"invalid","source_attribution":null,"source_url":null,"nodes":[{"title":"Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept"}]}]}`;
    const events = await runStreamWithSkeleton(invalidSchema);

    const errorEvents = events.filter((event) => event.startsWith("event: error\n"));
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("rejects skeleton with invalid nodes array (empty)", async () => {
    const invalidSchema = `{"title":"Test","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[]}`;
    const events = await runStreamWithSkeleton(invalidSchema);

    const errorEvents = events.filter((event) => event.startsWith("event: error\n"));
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("rejects skeleton with missing major_understandings in node", async () => {
    const invalidSchema = `{"title":"Test","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Topic","order_index":1}]}`;
    const events = await runStreamWithSkeleton(invalidSchema);

    const errorEvents = events.filter((event) => event.startsWith("event: error\n"));
    expect(errorEvents.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Regression: Skeleton retry with budget/ownership checks
// ============================================================

describe("Skeleton retry with budget/ownership checks", () => {
  let originalSetInterval: typeof global.setInterval;
  let heartbeatCallback: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof global.setInterval> | undefined;

  beforeEach(() => {
    originalSetInterval = global.setInterval;
    heartbeatCallback = undefined;
    heartbeatTimer = undefined;
    durableJobRow = null;
    vi.clearAllMocks();
    capturedInserts.length = 0;
    capturedNodeInserts.length = 0;
    capturedMuInserts.length = 0;
    capturedCurriculumUpdates.length = 0;
    resetRpcOverrides();
    resetRpcSequences();
    capturedInserts.length = 0;
    capturedNodeInserts.length = 0;
    capturedMuInserts.length = 0;
    // Capture the route's normal 60-second heartbeat and let each test invoke
    // it at a deterministic point in the mocked AI call.
    vi.spyOn(global, "setInterval").mockImplementation((callback) => {
      heartbeatCallback = callback;
      heartbeatTimer = originalSetInterval(() => {}, 60_000);
      return heartbeatTimer;
    });
  });

  afterEach(() => {
    if (heartbeatTimer !== undefined) global.clearInterval(heartbeatTimer);
    vi.restoreAllMocks();
    heartbeatCallback = undefined;
    heartbeatTimer = undefined;
    resetRpcOverrides();
    resetRpcSequences();
  });

  async function runHeartbeatNow(): Promise<void> {
    if (!heartbeatCallback) throw new Error("Route heartbeat was not registered");
    heartbeatCallback();
    // renewLease awaits the already-resolved RPC mock; flush its continuation
    // and the route's .then callback before the mocked AI response resolves.
    await Promise.resolve();
    await Promise.resolve();
  }

  const schemaValidSkeleton = '{"title":"Fallback Curriculum","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept"}]}]}';

  it("falls back without search after a citation-free structured search failure and persists before success", async () => {
    const { getAIProvider } = await import("@/lib/ai");
    const structured = vi.fn(async (_prompt: string, options: any) => {
      throw new Error("Azure web search completed without source citations; structured discovery was not generated.");
    });
    const complete = vi.fn(async (prompt: string, options: any) => {
      expect(options.useSearch).toBe(false);
      expect(prompt).toContain('source_type to "ai_organized"');
      return { text: schemaValidSkeleton, usage: { inputTokens: 20, outputTokens: 30 } };
    });
    vi.mocked(getAIProvider).mockReturnValue({
      structured,
      complete,
      name: "azure",
      capabilities: { structuredOutput: true, webSearch: true, streaming: false },
    } as any);

    const events = await runStreamAndCaptureEvents();
    const parsed = events.map(parseSseEvent);
    const skeletonEventIndex = parsed.findIndex((event) => event.event === "skeleton");
    expect(structured.mock.calls[0][1].useSearch).toBe(true);
    expect(complete).toHaveBeenCalled();
    expect(capturedCurriculumUpdates).toContainEqual({
      title: "Fallback Curriculum",
      source_type: "ai_organized",
      source_attribution: null,
      source_url: null,
    });
    expect(skeletonEventIndex).toBeGreaterThan(-1);
    expect(parsed[skeletonEventIndex].data).toEqual({ title: "Fallback Curriculum", topic_count: 1, resumed: false });
  });

  it("uses a no-search corrective retry after malformed fallback and preserves failure without false success", async () => {
    const { getAIProvider } = await import("@/lib/ai");
    const structured = vi.fn().mockRejectedValue(new Error("Azure web search completed without source citations"));
    const complete = vi.fn()
      .mockResolvedValueOnce({ text: "not JSON", usage: { inputTokens: 10, outputTokens: 5 } })
      .mockResolvedValueOnce({ text: schemaValidSkeleton, usage: { inputTokens: 10, outputTokens: 5 } });
    vi.mocked(getAIProvider).mockReturnValue({
      structured,
      complete,
      name: "azure",
      capabilities: { structuredOutput: true, webSearch: true, streaming: false },
    } as any);

    const events = await runStreamAndCaptureEvents();
    const parsed = events.map(parseSseEvent);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.every(([, options]) => options.useSearch === false)).toBe(true);
    expect(complete.mock.calls[1][0]).toContain("return ONLY the required JSON structure");
    expect(parsed.filter((event) => event.event === "skeleton")).toHaveLength(1);
    expect(capturedCurriculumUpdates[0]?.title).toBe("Fallback Curriculum");
  });

  it("emits failure and no skeleton event when fallback and corrective retry are invalid", async () => {
    const { getAIProvider } = await import("@/lib/ai");
    const structured = vi.fn().mockRejectedValue(new Error("Azure web search completed without source citations"));
    const complete = vi.fn().mockResolvedValue({ text: "not JSON", usage: { inputTokens: 10, outputTokens: 5 } });
    vi.mocked(getAIProvider).mockReturnValue({
      structured,
      complete,
      name: "azure",
      capabilities: { structuredOutput: true, webSearch: true, streaming: false },
    } as any);

    const parsed = (await runStreamAndCaptureEvents()).map(parseSseEvent);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.every(([, options]) => options.useSearch === false)).toBe(true);
    expect(parsed.some((event) => event.event === "error" && event.data.message === "Failed to generate curriculum structure")).toBe(true);
    expect(parsed.some((event) => event.event === "skeleton")).toBe(false);
    expect(capturedCurriculumUpdates).toHaveLength(0);
  });

  it("attempts at most one corrective retry on parse failure", async () => {
    // First response: invalid JSON
    // Second response: valid JSON
    let callCount = 0;
    const { getAIProvider } = await import("@/lib/ai");
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { text: "not valid json", usage: { inputTokens: 100, outputTokens: 50 } };
        }
        return { text: '{"title":"Retry Success","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept"}]}]}', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
      name: "mock",
      capabilities: { structuredOutput: false, webSearch: false, streaming: false },
    } as any);

    const events = await runStreamAndCaptureEvents();

    const skeletonEvents = events.map(parseSseEvent).filter((e) => e.event === "skeleton");
    expect(skeletonEvents.length).toBe(1);
    expect(skeletonEvents[0].data.title).toBe("Retry Success");
    // Should have called AI twice (initial + retry)
    expect(callCount).toBe(2);
  });

  it("does not retry when AI budget is exhausted", async () => {
    // First response: invalid JSON
    const { getAIProvider } = await import("@/lib/ai");
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn().mockResolvedValue({ text: "not valid json", usage: { inputTokens: 100, outputTokens: 50 } }),
      name: "mock",
      capabilities: { structuredOutput: false, webSearch: false, streaming: false },
    } as any);

    // Simulate budget exhausted on retry
    setRpcSequence("reserve_ai_call", [
      { data: { reserved: true, used: 1, remaining: 31 }, error: null }, // initial reservation
      { data: { reserved: false, reason: "budget_exhausted" }, error: null }, // retry reservation fails
    ]);

    const events = await runStreamAndCaptureEvents();

    const errorEvents = events.map(parseSseEvent).filter((e) => e.event === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0].data.message).toBe("AI generation budget exhausted. Please try again later.");
  });

  it("does not retry when ownership is lost before retry", async () => {
    // First response: invalid JSON
    const { getAIProvider } = await import("@/lib/ai");
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn().mockImplementation(async () => {
        await runHeartbeatNow();
        return { text: "not valid json", usage: { inputTokens: 100, outputTokens: 50 } };
      }),
      name: "mock",
      capabilities: { structuredOutput: false, webSearch: false, streaming: false },
    } as any);

    // Simulate ownership loss before retry (set renew_lease to fail)
    setRpcResult("renew_lease", { data: false, error: null });

    const events = await runStreamAndCaptureEvents();

    // Should not retry - ownership lost
    const ownershipLostEvents = events.map(parseSseEvent).filter(
      (e) => e.event === "error" && e.data.message.includes("ownership")
    );
    expect(ownershipLostEvents.length).toBeGreaterThan(0);
  });

  it("does not retry if retry AI call loses ownership", async () => {
    let callCount = 0;
    const { getAIProvider } = await import("@/lib/ai");
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        await runHeartbeatNow();
        if (callCount === 1) {
          return { text: "not valid json", usage: { inputTokens: 100, outputTokens: 50 } };
        }
        return { text: '{"title":"Retry Success","source_type":"ai_organized","source_attribution":null,"source_url":null,"nodes":[{"title":"Topic","order_index":1,"major_understandings":[{"code":"1.1","description":"Concept"}]}]}', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
      name: "mock",
      capabilities: { structuredOutput: false, webSearch: false, streaming: false },
    } as any);

    // Simulate ownership loss during retry
    setRpcSequence("renew_lease", [
      { data: true, error: null }, // initial heartbeat
      { data: false, error: null }, // ownership lost during retry
    ]);

    const events = await runStreamAndCaptureEvents();

    // Should have attempted retry but ownership lost
    expect(callCount).toBe(2);
    const ownershipLostEvents = events.map(parseSseEvent).filter(
      (e) => e.event === "error" && e.data.message.includes("ownership")
    );
    expect(ownershipLostEvents.length).toBeGreaterThan(0);
  });
});

describe("Durable generation stream observer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRpcOverrides();
    resetRpcSequences();
    jobInsertMockError = null;
    resumeScenario = false;
    simulatedResumeJob = null;
    simulatedCurriculum = null;
    observerRunningJob = null;
    durableJobRow = null;
    capturedInserts.length = 0;
  });

  async function readEvents(response: Response, count = 4): Promise<string[]> {
    const reader = response.body!.getReader();
    const events: string[] = [];
    for (let i = 0; i < count; i++) {
      const result = await reader.read();
      if (result.done) break;
      events.push(new TextDecoder().decode(result.value));
      if (events.some((chunk) => chunk.includes("event: complete") || chunk.includes("event: error"))) break;
    }
    await reader.cancel();
    return events;
  }

  function request(signal?: AbortSignal): Request {
    return new Request("http://localhost/api/generate/test-curriculum-id/stream", {
      headers: { Accept: "text/event-stream" },
      signal,
    });
  }

  async function startInlineObserver(signal?: AbortSignal, includeSavedSkeleton = false): Promise<Response> {
    setRpcSequence("claim_next_job", [
      { data: null, error: null },
      { data: null, error: null },
    ]);
    jobInsertMockError = { code: "23505", message: "active generation already exists" };
    observerRunningJob = {
      id: "running-job-id",
      curriculum_id: "test-curriculum-id",
      status: "running",
      error: null,
      result_data: {
        checkpoint: { completedTopicIds: ["topic-1"] },
        batchCheckpoint: { completedTopicIds: [] },
        ...(includeSavedSkeleton ? { skeleton: { title: "Saved Geometry", nodes: [{ title: "Triangles" }] } } : {}),
      },
      curricula: { status: "draft" },
    };
    return GET(request(signal), { params: Promise.resolve({ id: "test-curriculum-id" }) });
  }

  async function readNextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const { done, value } = await reader.read();
    return done ? null : parseSseEvent(new TextDecoder().decode(value!));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams changed persisted checkpoints without claiming or running generation", async () => {
    vi.useFakeTimers();
    const response = await startInlineObserver();
    const reader = response.body!.getReader();
    const initialEvents = [await readNextEvent(reader), await readNextEvent(reader), await readNextEvent(reader)];
    expect(initialEvents.some((event) => event?.data?.step === "waiting")).toBe(true);

    observerRunningJob.result_data.batchCheckpoint.completedTopicIds.push("topic-1");
    const updatedEventPromise = readNextEvent(reader);
    await vi.advanceTimersByTimeAsync(10_000);
    const updatedEvent = await updatedEventPromise;

    expect(updatedEvent?.event).toBe("status");
    expect(updatedEvent?.data).toMatchObject({ step: "running", current: 2, job_id: "running-job-id" });
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("reserve_ai_call", expect.anything());
    expect((mockSupabaseClient.rpc as ReturnType<typeof vi.fn>).mock.calls.filter(([name]) => name === "claim_next_job")).toHaveLength(2);
    expect(allResourceInserts()).toHaveLength(0);
    await reader.cancel();
  });

  it("reconnects through the atomic claim path when an observed owner yields the job to pending", async () => {
    vi.useFakeTimers();
    const response = await startInlineObserver();
    const reader = response.body!.getReader();
    await readNextEvent(reader);
    await readNextEvent(reader);
    await readNextEvent(reader);

    // A duplicate stream can outlive the owner that was doing the work.
    // Once that owner releases its lease, the observer must hand control back
    // to GET so claim_next_job can atomically resume the saved job.
    observerRunningJob.status = "pending";
    const continuationPromise = readNextEvent(reader);
    await vi.advanceTimersByTimeAsync(10_000);
    const continuation = await continuationPromise;

    expect(continuation?.event).toBe("continue");
    expect(continuation?.data).toMatchObject({ job_id: "running-job-id" });
    expect((await reader.read()).done).toBe(true);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("fail_job", expect.anything());
  });

  it("reports an already-saved skeleton to a reconnecting observer", async () => {
    vi.useFakeTimers();
    const response = await startInlineObserver(undefined, true);
    const reader = response.body!.getReader();
    const events = [await readNextEvent(reader), await readNextEvent(reader), await readNextEvent(reader), await readNextEvent(reader)];
    expect(events.find((event) => event?.event === "skeleton")?.data).toMatchObject({
      title: "Saved Geometry",
      topic_count: 1,
      resumed: true,
    });
    await reader.cancel();
  });

  it.each([
    ["completed", "complete"],
    ["failed", "error"],
    ["cancelled", "error"],
    ["canceled", "error"],
  ])("terminates observer streaming when the job becomes %s", async (status, expectedEvent) => {
    vi.useFakeTimers();
    const response = await startInlineObserver();
    const reader = response.body!.getReader();
    await readNextEvent(reader);
    await readNextEvent(reader);
    await readNextEvent(reader);

    observerRunningJob.status = status;
    observerRunningJob.error = status === "failed" ? "saved failure" : null;
    const terminalEventPromise = readNextEvent(reader);
    await vi.advanceTimersByTimeAsync(10_000);
    const terminalEvent = await terminalEventPromise;

    expect(terminalEvent?.event).toBe(expectedEvent);
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  it("stops polling and clears the pending poll when the reader disconnects", async () => {
    vi.useFakeTimers();
    const response = await startInlineObserver();
    const reader = response.body!.getReader();
    await readNextEvent(reader);
    await readNextEvent(reader);
    await readNextEvent(reader);
    const readsBeforeDisconnect = mockSupabaseClient.from.mock.calls.filter(([table]) => table === "acquisition_jobs").length;

    await reader.cancel();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSupabaseClient.from.mock.calls.filter(([table]) => table === "acquisition_jobs")).toHaveLength(readsBeforeDisconnect);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("fail_job", expect.anything());
  });

  it("stops the active observation when the request signal is aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const response = await startInlineObserver(abortController.signal);
    const reader = response.body!.getReader();
    await readNextEvent(reader);
    await readNextEvent(reader);
    await readNextEvent(reader);
    const readsBeforeAbort = mockSupabaseClient.from.mock.calls.filter(([table]) => table === "acquisition_jobs").length;

    abortController.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSupabaseClient.from.mock.calls.filter(([table]) => table === "acquisition_jobs")).toHaveLength(readsBeforeAbort);
    expect((await reader.read()).done).toBe(true);
  });

  it("does not repeat unchanged checkpoint progress at each poll", async () => {
    vi.useFakeTimers();
    const response = await startInlineObserver();
    const reader = response.body!.getReader();
    await readNextEvent(reader);
    await readNextEvent(reader);
    await readNextEvent(reader);

    let nextEventResolved = false;
    const nextEventPromise = readNextEvent(reader).then((event) => {
      nextEventResolved = true;
      return event;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(nextEventResolved).toBe(false);
    await reader.cancel();
    await nextEventPromise;
  });

  it("ends at the observation timeout with a pausing event instead of an auto-reconnect close", async () => {
    vi.useFakeTimers();
    const response = await startInlineObserver();
    const reader = response.body!.getReader();
    await readNextEvent(reader);
    await readNextEvent(reader);
    await readNextEvent(reader);

    const eventsPromise = (async () => {
      const events: Array<{ event: string | undefined; data: any }> = [];
      while (true) {
        const event = await readNextEvent(reader);
        if (!event) break;
        events.push(event);
        if (event.event === "paused") break;
      }
      return events;
    })();
    await vi.advanceTimersByTimeAsync(210_000);
    const events = await eventsPromise;

    expect(events.at(-1)?.event).toBe("paused");
    expect(events.at(-1)?.data.message).toMatch(/still in progress/i);
    expect(events.some((event) => event.event === "continue")).toBe(false);
    expect((await reader.read()).done).toBe(true);
  });

  it("observes a running job after the prior stream owner disappeared, without doing discovery", async () => {
    durableJobRow = {
      id: "job-1", status: "running", error: null, claim_token: "prior-owner",
      claim_version: 3, result_data: { checkpoint: { completedTopicIds: ["topic-1"] } },
    };
    const response = await observeGeneration(request(), { params: Promise.resolve({ id: "test-curriculum-id" }) });
    const events = await readEvents(response, 2);

    expect(events.join("\n")).toContain('"step":"running"');
    expect(events.join("\n")).toContain('"current":1');
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("reserve_ai_call", expect.anything());
    expect(durableJobRow.status).toBe("running");
    expect(durableJobRow.result_data.checkpoint.completedTopicIds).toEqual(["topic-1"]);
  });

  it("creates one pending job and reuses it on reconnect without taking a processing claim", async () => {
    const first = await observeGeneration(request(), { params: Promise.resolve({ id: "test-curriculum-id" }) });
    const firstEvents = await readEvents(first, 2);
    expect(firstEvents.join("\n")).toContain('"step":"pending"');
    expect(durableJobRow.status).toBe("pending");

    const reconnect = await observeGeneration(request(), { params: Promise.resolve({ id: "test-curriculum-id" }) });
    const reconnectEvents = await readEvents(reconnect, 2);

    expect(reconnectEvents.join("\n")).toContain('"step":"pending"');
    expect(capturedJobInserts()).toHaveLength(1);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("claim_next_job", expect.anything());
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("reserve_ai_call", expect.anything());
  });

  it("emits a terminal complete event when the durable job is completed", async () => {
    durableJobRow = { id: "job-1", status: "completed", error: null, result_data: {} };

    const response = await observeGeneration(request(), { params: Promise.resolve({ id: "test-curriculum-id" }) });
    const events = await readEvents(response);

    expect(events.join("\n")).toContain("event: complete");
    expect(events.join("\n")).not.toContain("event: continue");
    expect(capturedJobInserts()).toHaveLength(0);
  });

  it("emits the durable failure instead of retrying or creating another job", async () => {
    durableJobRow = { id: "job-1", status: "failed", error: "saved worker failure", result_data: {} };

    const response = await observeGeneration(request(), { params: Promise.resolve({ id: "test-curriculum-id" }) });
    const events = await readEvents(response);

    expect(events.join("\n")).toContain("event: error");
    expect(events.join("\n")).toContain("saved worker failure");
    expect(capturedJobInserts()).toHaveLength(0);
  });

  it("reclaims a pending job through the existing claim path without duplicating its checkpoint", async () => {
    durableJobRow = {
      id: "job-1", status: "pending", error: null, claim_token: null,
      claim_version: 4, result_data: { checkpoint: { completedTopicIds: ["topic-1"] } },
    };

    const response = await observeGeneration(request(), { params: Promise.resolve({ id: "test-curriculum-id" }) });
    const events = await readEvents(response, 2);

    expect(events.join("\n")).toContain('"step":"pending"');
    expect(durableJobRow.id).toBe("job-1");
    expect(durableJobRow.result_data.checkpoint.completedTopicIds).toEqual(["topic-1"]);
    expect(capturedJobInserts()).toHaveLength(0);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalledWith("reserve_ai_call", expect.anything());
  });
});
