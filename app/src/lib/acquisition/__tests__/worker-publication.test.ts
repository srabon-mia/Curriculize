import { describe, expect, it, vi } from 'vitest';
import { finalizeJobForCoverage, finalizeJobPublication } from '@/lib/acquisition/worker';
import type { JobClaimResult } from '@/lib/acquisition/jobTypes';

const job = { id: 'job-1', claim_token: 'token-1', claim_version: 4 } as JobClaimResult;

describe('atomic job publication finalization', () => {
  it('returns completed only after the atomic publication RPC confirms success', async () => {
    const finalize = vi.fn().mockResolvedValue('completed');
    await expect(finalizeJobPublication(job, finalize)).resolves.toBe('completed');
    expect(finalize).toHaveBeenCalledWith({ jobId: 'job-1', claimToken: 'token-1', claimVersion: 4 });
  });

  it('preserves ownership loss without reporting completion', async () => {
    await expect(finalizeJobPublication(job, vi.fn().mockResolvedValue('ownership_lost')))
      .resolves.toBe('ownership_lost');
  });

  it('propagates publication errors instead of reporting completion', async () => {
    await expect(finalizeJobPublication(job, vi.fn().mockRejectedValue(new Error('publication failed'))))
      .rejects.toThrow('publication failed');
  });

  it('publishes a curriculum even when resource coverage is insufficient', async () => {
    const publish = vi.fn().mockResolvedValue('completed');

    await expect(finalizeJobForCoverage(job, 'insufficient', publish)).resolves.toBe('completed');
    expect(publish).toHaveBeenCalledWith({ jobId: 'job-1', claimToken: 'token-1', claimVersion: 4 });
  });

  it('uses atomic publication after successful processing regardless of coverage state', async () => {
    const publish = vi.fn().mockResolvedValue('completed');

    await expect(finalizeJobForCoverage(job, 'complete', publish)).resolves.toBe('completed');
    expect(publish).toHaveBeenCalledWith({ jobId: 'job-1', claimToken: 'token-1', claimVersion: 4 });
  });

  it('does not turn a publication failure into successful job completion', async () => {
    await expect(finalizeJobForCoverage(job, 'insufficient', vi.fn().mockResolvedValue('ownership_lost')))
      .resolves.toBe('ownership_lost');
  });
});
