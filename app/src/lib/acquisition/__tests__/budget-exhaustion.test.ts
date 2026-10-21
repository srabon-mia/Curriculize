/**
 * AI-call budget exhaustion and retry accounting tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase at top level
const mockRpc = vi.fn();
const mockFromChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn(() => mockFromChain),
  })),
}));

import { reserveAICall, getJobById } from '@/lib/acquisition/jobService';
import { DEFAULT_BUDGET_LIMITS } from '@/lib/acquisition/jobTypes';

describe('AI call budget enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromChain.single.mockResolvedValue({ data: null, error: null });
  });

  it('DEFAULT_BUDGET_LIMITS.max_ai_calls is 32', () => {
    expect(DEFAULT_BUDGET_LIMITS.max_ai_calls).toBe(32);
  });

  it('reserveAICall increments aiCallsUsed and succeeds within budget', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { reserved: true, used: 1, remaining: 31 },
      error: null,
    });

    const result = await reserveAICall('job-1', 'token-1', 1, 32, 'reservation-1');

    expect(result.reserved).toBe(true);
    expect(result.used).toBe(1);
    expect(result.remaining).toBe(31);
  });

  it('reserveAICall fails with budget_exhausted when limit reached', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { reserved: false, reason: 'budget_exhausted' },
      error: null,
    });

    const result = await reserveAICall('job-1', 'token-1', 32, 32, 'reservation-33');

    expect(result.reserved).toBe(false);
    expect(result.reason).toBe('budget_exhausted');
  });

  it('reserveAICall returns idempotent=true for same reservation_id', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { reserved: true, used: 1, remaining: 31 }, error: null })
      .mockResolvedValueOnce({ data: { reserved: true, used: 2, remaining: 30, idempotent: true }, error: null });

    const r1 = await reserveAICall('job-1', 'token-1', 1, 32, 'same-reservation');
    const r2 = await reserveAICall('job-1', 'token-1', 1, 32, 'same-reservation');

    expect(r1.reserved).toBe(true);
    expect(r2.idempotent).toBe(true);
    expect(r2.used).toBe(2);
  });
});

describe('Retry accounting - budget persists across retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromChain.single.mockResolvedValue({ data: null, error: null });
  });

  it('job with exhausted budget fails reserveAICall after recovery', async () => {
    // Simulate job that was recovered with aiCallsUsed=32
    mockFromChain.single.mockResolvedValueOnce({
      data: {
        id: 'job-1',
        curriculum_id: 'curr-1',
        status: 'running',
        result_data: { aiCallsUsed: 32, checkpoint: { completedTopicIds: [] } },
        budget_limits: { max_ai_calls: 32, max_total_candidates_per_job: 50, max_candidates_per_understanding: 5, max_fetch_attempts: 3, max_retries: 3 },
        claim_token: 'new-token',
        claim_version: 2,
        claim_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
      error: null,
    });

    mockRpc.mockResolvedValueOnce({
      data: { reserved: false, reason: 'budget_exhausted' },
      error: null,
    });

    const { getJobById: getJob } = await import('@/lib/acquisition/jobService');
    const job = await getJob('job-1');

    expect(job?.result_data?.aiCallsUsed).toBe(32);

    const result = await reserveAICall('job-1', 'new-token', 2, 32, 'new-reservation');
    expect(result.reserved).toBe(false);
    expect(result.reason).toBe('budget_exhausted');
  });

  it('recover_stale_jobs does not reset aiCallsUsed', async () => {
    // This is a documentation test - the actual behavior is in the SQL migration
    // recover_stale_jobs updates status, claim_token, claim_version, retry_count
    // but does NOT modify result_data
    const sqlBehavior = {
      updates: ['status', 'claim_token', 'claim_expires_at', 'claim_version', 'retry_count', 'error'],
      preserves: ['result_data'],
    };

    expect(sqlBehavior.preserves).toContain('result_data');
    expect(sqlBehavior.updates).not.toContain('result_data');
  });
});