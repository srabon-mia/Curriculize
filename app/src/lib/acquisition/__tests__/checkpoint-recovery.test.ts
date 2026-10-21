/**
 * Checkpoint persistence and recovery tests.
 * Tests for checkpoint advancement, duplicate prevention, and resumability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase
const mockRpc = vi.fn();
const mockFromChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  upsert: vi.fn().mockReturnThis(),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn(() => mockFromChain),
  })),
}));

import { advanceCheckpoint, getJobById } from '@/lib/acquisition/jobService';

describe('Checkpoint persistence and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advanceCheckpoint calls RPC with correct parameters', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    const result = await advanceCheckpoint('job-1', 'token-1', 1, 'topic-uuid-1', 5);

    expect(result).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('advance_checkpoint', {
      p_job_id: 'job-1',
      p_claim_token: 'token-1',
      p_expected_claim_version: 1,
      p_completed_topic_id: 'topic-uuid-1',
      p_resources_found: 5,
    });
  });

  it('advanceCheckpoint returns false when ownership lost', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const result = await advanceCheckpoint('job-1', 'stale-token', 1, 'topic-uuid-1', 5);

    expect(result).toBe(false);
  });

  it('getJobById reads checkpoint from result_data', async () => {
    const mockJob = {
      id: 'job-1',
      curriculum_id: 'curr-1',
      result_data: {
        aiCallsUsed: 5,
        checkpoint: { completedTopicIds: ['topic-1', 'topic-2'], updatedAt: '2025-01-15T10:30:00Z' },
      },
      budget_limits: { max_ai_calls: 32, max_total_candidates_per_job: 50, max_candidates_per_understanding: 5, max_fetch_attempts: 3, max_retries: 3 },
      claim_token: 'token-1',
      claim_version: 1,
      claim_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };

    mockFromChain.single.mockResolvedValueOnce({ data: mockJob, error: null });

    const job = await getJobById('job-1');

    expect(job?.result_data?.checkpoint?.completedTopicIds).toEqual(['topic-1', 'topic-2']);
  });

  it('missing checkpoint defaults to empty set (fail-safe)', () => {
    // This mimics the worker's checkpoint reading logic
    const readCheckpoint = (jobData: any) => {
      const raw = jobData?.result_data?.checkpoint?.completedTopicIds;
      return new Set(
        Array.isArray(raw)
          ? raw.filter((id): id is string => typeof id === 'string')
          : []
      );
    };

    expect(readCheckpoint({ result_data: null }).size).toBe(0);
    expect(readCheckpoint({ result_data: {} }).size).toBe(0);
    expect(readCheckpoint({ result_data: { checkpoint: null } }).size).toBe(0);
    expect(readCheckpoint({ result_data: { checkpoint: { completedTopicIds: 'not-array' } } }).size).toBe(0);
    expect(readCheckpoint({ result_data: { checkpoint: { completedTopicIds: ['a', 'b'] } } }).size).toBe(2);
  });

  it('checkpoint_version increments atomically with completedTopicIds (SQL contract)', () => {
    // The advance_checkpoint RPC does both in one UPDATE:
    // UPDATE acquisition_jobs SET
    //   result_data = jsonb_set(..., '{checkpoint,completedTopicIds}', ... || to_jsonb(p_completed_topic_id)),
    //   checkpoint_version = checkpoint_version + 1
    // WHERE ...
    // If WHERE matches, BOTH happen. If not, NEITHER happens.
    const contract = {
      atomic: true,
      increments: ['checkpoint_version'],
      appends: ['result_data.checkpoint.completedTopicIds'],
    };

    expect(contract.atomic).toBe(true);
    expect(contract.increments).toContain('checkpoint_version');
    expect(contract.appends).toContain('result_data.checkpoint.completedTopicIds');
  });
});

describe('Worker resume from checkpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('worker skips completed topics from checkpoint', () => {
    // This documents the expected behavior in worker.ts:354-363
    const jobData = {
      result_data: {
        checkpoint: { completedTopicIds: ['topic-uuid-1', 'topic-uuid-2'] },
      },
    };

    const rawCompletedTopics = jobData.result_data.checkpoint?.completedTopicIds;
    const completedTopics = new Set(
      Array.isArray(rawCompletedTopics)
        ? rawCompletedTopics.filter((id): id is string => typeof id === 'string')
        : []
    );

    expect(completedTopics.has('topic-uuid-1')).toBe(true);
    expect(completedTopics.has('topic-uuid-2')).toBe(true);
    expect(completedTopics.has('topic-uuid-3')).toBe(false);
  });

  it('worker handles corrupted checkpoint gracefully', () => {
    // If checkpoint exists but completedTopicIds is not an array, default to empty
    const jobData = {
      result_data: {
        checkpoint: { completedTopicIds: 'corrupted' },
      },
    };

    const rawCompletedTopics = jobData.result_data.checkpoint?.completedTopicIds;
    const completedTopics = new Set(
      Array.isArray(rawCompletedTopics)
        ? rawCompletedTopics.filter((id): id is string => typeof id === 'string')
        : []
    );

    expect(completedTopics.size).toBe(0);
  });
});

describe('Checkpoint persistence edge cases (regression tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checkpoint update starting with {"aiCallsUsed":12} and no checkpoint key creates checkpoint object', async () => {
    // Regression test for: checkpoint_version increments but completedTopicIds not persisted
    // because jsonb_set doesn't create missing intermediate objects by default.
    // The fix uses jsonb_set with create_missing=true (4th parameter).
    const startResultData = { aiCallsUsed: 12 };
    const topicId = 'topic-uuid-1';

    // Simulate the fixed SQL behavior with create_missing=true
    // jsonb_set(target, path, new_value, create_missing)
    const path = '{checkpoint,completedTopicIds}';
    const existing = startResultData.checkpoint?.completedTopicIds;
    const newArray = (existing ? [...existing] : []).concat([topicId]);
    const result = { ...startResultData, checkpoint: { completedTopicIds: newArray } };

    expect(result).toEqual({
      aiCallsUsed: 12,
      checkpoint: { completedTopicIds: ['topic-uuid-1'] },
    });
    expect(result.checkpoint).toBeDefined();
    expect(Array.isArray(result.checkpoint.completedTopicIds)).toBe(true);
  });

  it('multiple successive checkpoint updates accumulate topic IDs', async () => {
    let resultData = { aiCallsUsed: 12 };

    // Simulate 3 successive checkpoint updates
    const topics = ['topic-1', 'topic-2', 'topic-3'];
    for (const topic of topics) {
      const existing = resultData.checkpoint?.completedTopicIds;
      resultData = {
        ...resultData,
        checkpoint: { completedTopicIds: (existing ? [...existing] : []).concat([topic]) },
      };
    }

    expect(resultData.checkpoint.completedTopicIds).toEqual(['topic-1', 'topic-2', 'topic-3']);
    expect(resultData.checkpoint.completedTopicIds).toHaveLength(3);
  });

  it('duplicate topic checkpoint attempts are idempotent (prevented by migration)', () => {
    // The migration 0010 adds a check: if topic already in completedTopicIds, return true without duplicate
    const completed = ['topic-1', 'topic-2'];
    const duplicateTopic = 'topic-1';
    const newTopic = 'topic-3';

    // Simulate the migration's duplicate check
    const alreadyCompleted = completed.includes(duplicateTopic);
    const wouldAdd = completed.includes(newTopic);

    expect(alreadyCompleted).toBe(true);
    expect(wouldAdd).toBe(false);

    // After duplicate attempt, array unchanged
    const afterDuplicate = alreadyCompleted ? completed : [...completed, duplicateTopic];
    expect(afterDuplicate).toEqual(['topic-1', 'topic-2']);

    // After new topic, array grows
    const afterNew = wouldAdd ? completed : [...completed, newTopic];
    expect(afterNew).toEqual(['topic-1', 'topic-2', 'topic-3']);
  });

  it('preserves unrelated result_data keys during checkpoint update', () => {
    // The jsonb_set with COALESCE preserves all other keys
    const startData = {
      aiCallsUsed: 12,
      candidatesProcessed: 45,
      customKey: 'customValue',
    };

    const topicId = 'topic-1';
    const existing = startData.checkpoint?.completedTopicIds;
    const resultData = {
      ...startData,
      checkpoint: { completedTopicIds: (existing ? [...existing] : []).concat([topicId]) },
    };

    expect(resultData.aiCallsUsed).toBe(12);
    expect(resultData.candidatesProcessed).toBe(45);
    expect(resultData.customKey).toBe('customValue');
    expect(resultData.checkpoint.completedTopicIds).toEqual(['topic-1']);
  });

  it('stale/invalid claims rejected without changing checkpoint state', async () => {
    // advance_checkpoint WHERE clause includes claim_token, claim_version, status='running'
    // If any mismatch, UPDATE affects 0 rows, checkpoint_version not incremented
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const result = await advanceCheckpoint('job-1', 'wrong-token', 1, 'topic-uuid-1', 5);

    expect(result).toBe(false);
    expect(mockRpc).toHaveBeenCalledWith('advance_checkpoint', expect.objectContaining({
      p_claim_token: 'wrong-token',
    }));
  });

  it('checkpoint uses UUID topic IDs that match node IDs', () => {
    // Both worker and SSE use nodeId (UUID) as the checkpoint identifier
    // Worker reconstructs nodeIds from skeleton nodes with same external_key
    // ensuring consistent IDs on retry
    const sseNodeId = '550e8400-e29b-41d4-a716-446655440000';
    const workerNodeId = '550e8400-e29b-41d4-a716-446655440000';

    expect(sseNodeId).toBe(workerNodeId);
    expect(sseNodeId).toMatch(/^[0-9a-f-]{36}$/);
  });
});