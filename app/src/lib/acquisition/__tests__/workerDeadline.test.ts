import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerDeadline,
  DEFAULT_PROCESSOR_WORK_BUDGET_MS,
  MAX_PROCESSOR_WORK_BUDGET_MS,
  PROCESSOR_CLEANUP_BUDGET_MS,
  PROCESSOR_RESPONSE_MARGIN_MS,
  processorWorkBudgetMs,
  WorkerYieldRequested,
} from '@/lib/acquisition/workerDeadline';

describe('worker invocation deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('uses a documented conservative default and caps configuration below maxDuration', () => {
    expect(processorWorkBudgetMs(undefined)).toBe(DEFAULT_PROCESSOR_WORK_BUDGET_MS);
    expect(processorWorkBudgetMs(String(MAX_PROCESSOR_WORK_BUDGET_MS + 1))).toBe(MAX_PROCESSOR_WORK_BUDGET_MS);
    expect(processorWorkBudgetMs('invalid')).toBe(DEFAULT_PROCESSOR_WORK_BUDGET_MS);
  });

  it('throws before work starts when the deadline has expired', () => {
    const deadline = createWorkerDeadline(1_000);
    deadline.dispose();
    expect(() => deadline.check()).not.toThrow();
    vi.useFakeTimers();
    const expiring = createWorkerDeadline(1_000);
    vi.advanceTimersByTime(1_000);
    expect(expiring.signal.aborted).toBe(true);
    expect(() => expiring.check()).toThrow(WorkerYieldRequested);
    expiring.dispose();
  });

  it('aborts in-flight signal-aware operations at the deadline', () => {
    vi.useFakeTimers();
    const deadline = createWorkerDeadline(1_000);
    const observed = new Promise<void>((resolve) => deadline.signal.addEventListener('abort', () => resolve(), { once: true }));
    vi.advanceTimersByTime(1_000);
    expect(deadline.signal.aborted).toBe(true);
    return observed.finally(() => deadline.dispose());
  });

  it('bounds cleanup work separately and leaves response margin below the cron limit', async () => {
    vi.useFakeTimers();
    const deadline = createWorkerDeadline(1_000);
    let cleanupSignal: AbortSignal | undefined;
    const cleanup = deadline.runCleanup((signal) => {
      cleanupSignal = signal;
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    vi.advanceTimersByTime(PROCESSOR_CLEANUP_BUDGET_MS);
    await cleanup;
    expect(cleanupSignal?.aborted).toBe(true);
    expect(MAX_PROCESSOR_WORK_BUDGET_MS + PROCESSOR_CLEANUP_BUDGET_MS + PROCESSOR_RESPONSE_MARGIN_MS).toBeLessThan(30_000);
    deadline.dispose();
  });

  it('stops starting expensive operations with the cleanup and response margin reserved', () => {
    vi.useFakeTimers();
    const deadline = createWorkerDeadline(18_000);
    vi.advanceTimersByTime(8_000);
    expect(() => deadline.checkBeforeExpensiveOperation()).toThrow(WorkerYieldRequested);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
