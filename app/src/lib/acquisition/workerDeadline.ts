/** Invocation-local deadline sized for cron-job.org's 30-second hard timeout. */
export const DEFAULT_PROCESSOR_WORK_BUDGET_MS = 18_000;
export const MAX_PROCESSOR_WORK_BUDGET_MS = 18_000;
export const PROCESSOR_CLEANUP_BUDGET_MS = 4_000;
export const PROCESSOR_RESPONSE_MARGIN_MS = 6_000;
export const PROCESSOR_OPERATION_RESERVE_MS =
  PROCESSOR_CLEANUP_BUDGET_MS + PROCESSOR_RESPONSE_MARGIN_MS;

export class WorkerYieldRequested extends Error {
  constructor() {
    super("Processor work budget reached");
    this.name = "WorkerYieldRequested";
  }
}

export interface WorkerDeadline {
  signal: AbortSignal;
  check(): void;
  checkBeforeExpensiveOperation(): void;
  cleanupSignal(): AbortSignal;
  runCleanup<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  dispose(): void;
}

export function processorWorkBudgetMs(raw = process.env.CURRICULIZE_PROCESSOR_WORK_BUDGET_MS): number {
  const parsed = raw ? Number(raw) : DEFAULT_PROCESSOR_WORK_BUDGET_MS;
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) return DEFAULT_PROCESSOR_WORK_BUDGET_MS;
  return Math.min(parsed, MAX_PROCESSOR_WORK_BUDGET_MS);
}

export function createWorkerDeadline(budgetMs = processorWorkBudgetMs()): WorkerDeadline {
  const controller = new AbortController();
  const deadlineAt = Date.now() + Math.min(Math.max(budgetMs, 1_000), MAX_PROCESSOR_WORK_BUDGET_MS);
  const timeout = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  const cleanupTimers = new Set<ReturnType<typeof setTimeout>>();
  const cleanupControllers = new Set<AbortController>();
  const createCleanupSignal = (): AbortSignal => {
    const cleanupController = new AbortController();
    cleanupControllers.add(cleanupController);
    const cleanupTimeout = setTimeout(() => cleanupController.abort(), PROCESSOR_CLEANUP_BUDGET_MS);
    cleanupTimers.add(cleanupTimeout);
    cleanupController.signal.addEventListener('abort', () => {
      cleanupTimers.delete(cleanupTimeout);
      cleanupControllers.delete(cleanupController);
    }, { once: true });
    return cleanupController.signal;
  };
  return {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        if (!controller.signal.aborted) controller.abort();
        throw new WorkerYieldRequested();
      }
    },
    checkBeforeExpensiveOperation() {
      this.check();
      if (deadlineAt - Date.now() <= PROCESSOR_OPERATION_RESERVE_MS) {
        controller.abort();
        throw new WorkerYieldRequested();
      }
    },
    cleanupSignal() {
      return createCleanupSignal();
    },
    async runCleanup<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const signal = createCleanupSignal();
      try {
        return await operation(signal);
      } finally {
        for (const controller of cleanupControllers) {
          if (controller.signal === signal) {
            controller.abort();
            break;
          }
        }
      }
    },
    dispose() {
      clearTimeout(timeout);
      for (const cleanupTimeout of cleanupTimers) clearTimeout(cleanupTimeout);
      cleanupTimers.clear();
      for (const controller of cleanupControllers) controller.abort();
      cleanupControllers.clear();
    },
  };
}
