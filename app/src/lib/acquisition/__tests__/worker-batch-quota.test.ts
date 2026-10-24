import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordResourceCoverageAttempt: vi.fn(),
  releaseJobClaim: vi.fn(),
  reserveAICall: vi.fn(),
  getJobById: vi.fn(),
  createClient: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@/lib/acquisition/jobService', () => ({
  claimNextJob: vi.fn(),
  renewLease: vi.fn(),
  reserveAICall: mocks.reserveAICall,
  persistWithFence: vi.fn(),
  advanceCheckpoint: vi.fn(),
  recordResourceCoverageAttempt: mocks.recordResourceCoverageAttempt,
  completeJob: vi.fn(),
  failJob: vi.fn(),
  recoverStaleJobs: vi.fn(),
  releaseJobClaim: mocks.releaseJobClaim,
  saveJobSources: vi.fn(),
  getJobById: mocks.getJobById,
  DEFAULT_BUDGET_LIMITS: { max_ai_calls: 32 },
  LEASE_RENEWAL_INTERVAL_MS: 60_000,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/ai', () => ({
  getAIProvider: () => ({ complete: mocks.complete }),
}));

vi.mock('@/lib/acquisition/engine', () => ({
  acquireCandidate: vi.fn(),
  DEFAULT_ACQUISITION_OPTIONS: {},
}));

import { processBatchDiscovery } from '@/lib/acquisition/worker';

function queryResult(data: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order']) {
    query[method] = () => query;
  }
  query.single = async () => ({ data, error: null });
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

describe('durable worker batch quota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const completed = new Set<string>();
    mocks.getJobById.mockImplementation(async () => ({
      result_data: { batchCheckpoint: { completedTopicIds: [...completed] } },
    }));
    const attempts = new Map<string, number>();
    mocks.recordResourceCoverageAttempt.mockImplementation(async (input: { targetId: string }) => {
      const count = (attempts.get(input.targetId) ?? 0) + 1;
      attempts.set(input.targetId, count);
      const status = count === 2 ? 'insufficient' : 'retrying';
      if (status === 'insufficient') completed.add(input.targetId);
      return { status, retry: status === 'retrying' };
    });
    mocks.releaseJobClaim.mockResolvedValue(true);
    mocks.reserveAICall.mockResolvedValue({ reserved: true });
    mocks.complete.mockResolvedValue({ text: '{"topic_resources":[]}' });
  });

  it('does not spend quota on two empty topics and progresses through all remaining topics across invocations', async () => {
    const topics = Array.from({ length: 9 }, (_, index) => ({
      nodeId: `topic-${index + 1}`,
      node: { title: `Topic ${index + 1}`, order_index: index + 1, major_understandings: [] },
    }));
    const job = {
      id: 'same-job',
      curriculum_id: 'same-curriculum',
      claim_token: 'fenced-token',
      claim_version: 7,
      budget_limits: { max_ai_calls: 32 },
    } as never;

    // The first two persisted topics have no understandings. They are skipped,
    // while actionable topics 3 and 4 consume this invocation's quota.
    let currentNodeId = '';
    mocks.createClient.mockReturnValue({
      from: (table: string) => {
        if (table === 'curricula') return queryResult({ title: 'Geometry' });
        if (table === 'major_understandings') {
          return {
            select() { return this; },
            eq(_column: string, nodeId: string) {
              currentNodeId = nodeId;
              return this;
            },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              const hasRows = currentNodeId !== 'topic-1' && currentNodeId !== 'topic-2';
              return Promise.resolve({
                data: hasRows ? [{ id: `mu-${currentNodeId}`, code: 'G.1', description: 'Understanding', external_key: 'G.1' }] : [],
                error: null,
              }).then(resolve, reject);
            },
          };
        }
        return queryResult(null);
      },
    });

    const firstDone = await processBatchDiscovery(job, 'Geometry', topics);
    expect(firstDone).toBe(false);
    expect(mocks.recordResourceCoverageAttempt.mock.calls.map(([call]) => call.targetId)).toEqual(['topic-3', 'topic-3', 'topic-4', 'topic-4']);
    expect(mocks.releaseJobClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseJobClaim).toHaveBeenLastCalledWith('same-job', 'fenced-token', 7);

    const secondDone = await processBatchDiscovery(job, 'Geometry', topics);
    expect(secondDone).toBe(false);
    expect(mocks.recordResourceCoverageAttempt.mock.calls.map(([call]) => call.targetId)).toEqual([
      'topic-3', 'topic-3', 'topic-4', 'topic-4', 'topic-5', 'topic-5', 'topic-6', 'topic-6',
    ]);
    expect(mocks.releaseJobClaim).toHaveBeenCalledTimes(2);
    expect(mocks.releaseJobClaim).toHaveBeenLastCalledWith('same-job', 'fenced-token', 7);

    const thirdDone = await processBatchDiscovery(job, 'Geometry', topics);
    expect(thirdDone).toBe(false);
    expect(mocks.recordResourceCoverageAttempt.mock.calls.map(([call]) => call.targetId)).toEqual([
      'topic-3', 'topic-3', 'topic-4', 'topic-4', 'topic-5', 'topic-5', 'topic-6', 'topic-6', 'topic-7', 'topic-7', 'topic-8', 'topic-8',
    ]);
    expect(mocks.recordResourceCoverageAttempt.mock.calls.every(([call]) => call.jobId === 'same-job' && call.claimToken === 'fenced-token' && call.claimVersion === 7)).toBe(true);
    expect(mocks.releaseJobClaim).toHaveBeenCalledTimes(3);

    const fourthDone = await processBatchDiscovery(job, 'Geometry', topics);
    expect(fourthDone).toBe(true);
    expect(mocks.recordResourceCoverageAttempt.mock.calls.map(([call]) => call.targetId)).toEqual([
      'topic-3', 'topic-3', 'topic-4', 'topic-4', 'topic-5', 'topic-5', 'topic-6', 'topic-6', 'topic-7', 'topic-7', 'topic-8', 'topic-8', 'topic-9', 'topic-9',
    ]);
    expect(mocks.releaseJobClaim).toHaveBeenCalledTimes(3);
    expect(mocks.getJobById).toHaveBeenCalledTimes(4);
    expect(mocks.getJobById).toHaveBeenCalledWith('same-job');
  });
});
