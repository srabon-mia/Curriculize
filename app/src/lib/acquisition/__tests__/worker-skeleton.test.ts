import { describe, expect, it, vi } from 'vitest';
import { classifySkeletonCheckpoint, getUncheckpointedTopicIds, materializeSkeletonRows, reconstructCheckpointedLegacySkeleton, releaseDeadlineYield, runBoundedStructureCall, saveSkeletonBeforeMaterialization, saveSkeletonCheckpointWithCleanup, stableAttemptUuid } from '@/lib/acquisition/worker';
import { createWorkerDeadline } from '@/lib/acquisition/workerDeadline';
import type { JobClaimResult } from '@/lib/acquisition/jobTypes';

const skeleton = {
  title: 'Algebra', source_type: 'adapted', source_attribution: 'Guide', source_url: null,
  nodes: [
    { title: 'Expressions', order_index: 0, major_understandings: [{ code: 'A.1', description: 'Evaluate expressions' }] },
    { title: 'Equations', order_index: 1, major_understandings: [{ code: 'A.2', description: 'Solve equations' }] },
  ],
};

function inMemorySupabase(failAtWrite?: number) {
  const nodes = new Map<string, Record<string, unknown>>();
  const understandings = new Map<string, Record<string, unknown>>();
  let write = 0;
  let upsertCalls = 0;
  const makeSelect = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let inFilter: [string, unknown[]] | null = null;
    const result = () => {
      const rows = [...(table === 'nodes' ? nodes.values() : understandings.values())];
      const filtered = rows.filter((row) => filters.every(([key, expected]) => row[key] === expected) &&
        (!inFilter || (inFilter[1] as unknown[]).includes(row[inFilter[0]])));
      return { data: filtered, error: null };
    };
    const query = {
      eq(key: string, expected: unknown) { filters.push([key, expected]); return query; },
      in(key: string, expected: unknown[]) { inFilter = [key, expected]; return query; },
      then(resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) {
        return Promise.resolve(result()).then(resolve, reject);
      },
    };
    return query;
  };
  const client = {
    from(table: string) {
      return {
        update: () => ({ eq: async () => {
          write++;
          return write === failAtWrite ? { error: { message: 'injected interruption' } } : { error: null };
        } }),
        upsert(value: unknown) {
          const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : [value as Record<string, unknown>];
          const query = {
            select() { return query; },
            then(resolve: (result: unknown) => unknown, reject: (reason?: unknown) => unknown) {
              write++;
              upsertCalls++;
              if (write === failAtWrite) return Promise.resolve({ data: null, error: { message: 'injected interruption' } }).then(resolve, reject);
              const savedRows: Array<Record<string, unknown>> = rows.map((row) => {
                if (table === 'nodes') {
                  const key = `${row.curriculum_id}:${row.external_key}`;
                  const saved = { ...(nodes.get(key) ?? {}), ...row, id: nodes.get(key)?.id ?? `node-${row.external_key}` };
                  nodes.set(key, saved);
                  return saved;
                }
                const key = `${row.node_id}:${row.external_key}`;
                const saved = { ...(understandings.get(key) ?? {}), ...row, id: understandings.get(key)?.id ?? `mu-${row.external_key}` };
                understandings.set(key, saved);
                return saved;
              });
              return Promise.resolve({ data: table === 'nodes' ? savedRows.map((row) => ({ id: row.id, external_key: row.external_key })) : null, error: null }).then(resolve, reject);
            },
          };
          return query;
        },
        select: () => makeSelect(table),
      };
    },
    counts: () => ({ nodes: nodes.size, understandings: understandings.size, upsertCalls }),
  };
  return client;
}

describe('durable skeleton materialization', () => {
  it('allows structure generation to finish beyond 18s but enforces its own hard timeout', async () => {
    vi.useFakeTimers();
    try {
      let callSignal: AbortSignal | undefined;
      const pending = runBoundedStructureCall((signal) => {
        callSignal = signal;
        return new Promise<string>((resolve) => setTimeout(() => resolve('structure'), 20_000));
      }, 120_000);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toBe('structure');
      expect(callSignal?.aborted).toBe(false);

      let checkpointWritten = false;
      const timeoutCall = runBoundedStructureCall((signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }), 120_000);
      const timeoutResult = timeoutCall.then((value) => { checkpointWritten = true; return value; });
      const timeoutAssertion = expect(timeoutResult).rejects.toThrow('bounded 120 second limit');
      await vi.advanceTimersByTimeAsync(120_000);
      await timeoutAssertion;
      expect(checkpointWritten).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates stable per-job reservation UUIDs for interrupted-call replay', () => {
    const first = stableAttemptUuid('job-1', 'topic', 'topic-1', '0');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableAttemptUuid('job-1', 'topic', 'topic-1', '0')).toBe(first);
    expect(stableAttemptUuid('job-1', 'topic', 'topic-1', '1')).not.toBe(first);
  });

  it('persists the immutable checkpoint before the first materialization write', async () => {
    const order: string[] = [];
    const result = await saveSkeletonBeforeMaterialization(
      async () => { order.push('checkpoint'); return 'saved'; },
      async () => { order.push('insert'); return ['topic']; }
    );
    expect(order).toEqual(['checkpoint', 'insert']);
    expect(result).toEqual({ status: 'materialized', result: ['topic'] });
  });

  it('uses the fenced cleanup signal when the worker deadline has elapsed during structure generation', async () => {
    const expiredWork = new AbortController();
    expiredWork.abort();
    const cleanup = new AbortController();
    const deadline = { cleanupSignal: vi.fn(() => cleanup.signal) } as unknown as ReturnType<typeof import('@/lib/acquisition/worker').createWorkerDeadline>;
    const save = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(cleanup.signal);
      expect(signal.aborted).toBe(false);
      expect(expiredWork.signal.aborted).toBe(true);
      return 'saved' as const;
    });

    await expect(saveSkeletonCheckpointWithCleanup(save, deadline)).resolves.toBe('saved');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('checkpoints a successful structure response across a worker yield and skips AI on resume', async () => {
    vi.useFakeTimers();
    const deadline = createWorkerDeadline(18_000);
    try {
      let checkpoint: typeof skeleton | null = null;
      let structureCalls = 0;
      const response = runBoundedStructureCall(async () => {
        structureCalls++;
        return new Promise<typeof skeleton>((resolve) => setTimeout(() => resolve(skeleton), 20_000));
      }, 120_000);
      await vi.advanceTimersByTimeAsync(20_000);
      const generated = await response;
      expect(deadline.signal.aborted).toBe(true);

      await expect(saveSkeletonBeforeMaterialization(
        async () => saveSkeletonCheckpointWithCleanup(async (signal) => {
          expect(signal.aborted).toBe(false);
          checkpoint = generated;
          return 'saved';
        }, deadline),
        async () => { deadline.check(); return undefined; },
      )).rejects.toThrow('Processor work budget reached');
      expect(checkpoint).toEqual(skeleton);

      // This is the next invocation's production branch condition: a valid
      // stored checkpoint bypasses the initial structure-generation branch.
      if (classifySkeletonCheckpoint(checkpoint, 0).status !== 'persisted') structureCalls++;
      expect(structureCalls).toBe(1);
    } finally {
      deadline.dispose();
      vi.useRealTimers();
    }
  });

  it('does not insert when the fenced checkpoint RPC reports ownership loss', async () => {
    const materialize = vi.fn();
    await expect(saveSkeletonBeforeMaterialization(async () => 'ownership_lost', materialize))
      .resolves.toEqual({ status: 'ownership_lost' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('distinguishes a fresh job, a resumable checkpoint, and ambiguous legacy rows', () => {
    expect(classifySkeletonCheckpoint(undefined, 0)).toEqual({ status: 'not_generated' });
    expect(classifySkeletonCheckpoint(skeleton, 0).status).toBe('persisted');
    expect(classifySkeletonCheckpoint(undefined, 2)).toEqual({ status: 'legacy_ambiguous' });
    expect(classifySkeletonCheckpoint({ nodes: [] }, 0)).toEqual({ status: 'invalid_checkpoint' });
  });

  it('reconstructs a legacy skeleton only when saved topics and checkpoints match exactly', () => {
    const legacy = {
      curriculum: { title: 'Algebra', source_type: 'adapted', source_attribution: 'Guide', source_url: null },
      topics: [
        { id: 'topic-1', title: 'Expressions', order_index: 1, external_key: 'topic-1' },
        { id: 'topic-2', title: 'Equations', order_index: 2, external_key: 'topic-2' },
      ],
      understandings: [
        { node_id: 'topic-1', code: 'A.1', description: 'Evaluate expressions', external_key: 'A.1', order_index: 0 },
        { node_id: 'topic-2', code: 'A.2', description: 'Solve equations', external_key: 'A.2', order_index: 0 },
      ],
      completedTopicIds: ['topic-1', 'topic-2'],
    };

    const recovered = {
      ...skeleton,
      nodes: skeleton.nodes.map((node, index) => ({ ...node, order_index: index + 1 })),
    };
    expect(reconstructCheckpointedLegacySkeleton(legacy)).toEqual(recovered);
    expect(reconstructCheckpointedLegacySkeleton({ ...legacy, completedTopicIds: ['topic-1'] })).toEqual(recovered);
    expect(getUncheckpointedTopicIds(['topic-1', 'topic-2'], legacy.completedTopicIds)).toEqual([]);
    expect(getUncheckpointedTopicIds(['topic-1', 'topic-2'], ['topic-1'])).toEqual(['topic-2']);
    expect(reconstructCheckpointedLegacySkeleton({ ...legacy, completedTopicIds: [] })).toBeNull();
    expect(reconstructCheckpointedLegacySkeleton({ ...legacy, completedTopicIds: ['topic-1', 'topic-1'] })).toBeNull();
    expect(reconstructCheckpointedLegacySkeleton({ ...legacy, completedTopicIds: ['unknown-topic'] })).toBeNull();
    expect(reconstructCheckpointedLegacySkeleton({ ...legacy, completedTopicIds: [1] })).toBeNull();
    expect(reconstructCheckpointedLegacySkeleton({
      ...legacy,
      topics: legacy.topics.map((topic) => ({ ...topic, order_index: 0, external_key: 'topic-0' })),
    })).toBeNull();
    expect(reconstructCheckpointedLegacySkeleton({
      ...legacy,
      understandings: legacy.understandings.map((row) => ({ ...row, external_key: 'mismatched-key' })),
    })).toBeNull();
    expect(reconstructCheckpointedLegacySkeleton({
      ...legacy,
      understandings: [...legacy.understandings, { ...legacy.understandings[0], code: 'A.1' }],
    })).toBeNull();
  });

  it.each([1, 2, 3])('repairs after interruption at metadata/node/understanding write %i', async (writeBoundary) => {
    const client = inMemorySupabase(writeBoundary);
    await expect(materializeSkeletonRows(client as never, 'curriculum-1', skeleton)).rejects.toThrow('injected interruption');
    await materializeSkeletonRows(client as never, 'curriculum-1', skeleton);
    expect(client.counts()).toMatchObject({ nodes: 2, understandings: 2 });
    const completed = await materializeSkeletonRows(client as never, 'curriculum-1', skeleton);
    expect(completed.map((item) => item.nodeId)).toEqual(['node-topic-0', 'node-topic-1']);
    expect(client.counts()).toMatchObject({ nodes: 2, understandings: 2 });
    expect(client.counts().upsertCalls).toBe(4 + writeBoundary - 1);
  });

  it('re-materializes a saved skeleton with two bounded upsert requests per resume', async () => {
    const client = inMemorySupabase();
    await materializeSkeletonRows(client as never, 'curriculum-1', skeleton);
    const beforeResume = client.counts().upsertCalls;
    await materializeSkeletonRows(client as never, 'curriculum-1', skeleton);
    expect(client.counts().upsertCalls - beforeResume).toBe(2);
    expect(client.counts()).toMatchObject({ nodes: 2, understandings: 2 });
  });

  it('checks deadline between durable insert operations', async () => {
    let checks = 0;
    const client = inMemorySupabase();
    await expect(materializeSkeletonRows(client as never, 'curriculum-1', skeleton, () => {
      checks++;
      if (checks === 3) throw new Error('yield');
    })).rejects.toThrow('yield');
    expect(client.counts().nodes).toBe(2);
    expect(client.counts().understandings).toBe(0);
    await materializeSkeletonRows(client as never, 'curriculum-1', skeleton);
    expect(client.counts()).toMatchObject({ nodes: 2, understandings: 2 });
  });
});

describe('deadline claim release', () => {
  const job = { id: 'job-1', claim_token: 'claim-1', claim_version: 7 } as JobClaimResult;

  it('releases through the existing fenced token/version and reports a resumable yield', async () => {
    const release = vi.fn().mockResolvedValue(true);
    await expect(releaseDeadlineYield(job, release)).resolves.toBe('yielded');
    expect(release).toHaveBeenCalledWith('job-1', 'claim-1', 7, undefined);
  });

  it('does not claim a yield succeeded if fencing rejects release', async () => {
    const release = vi.fn().mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(releaseDeadlineYield(job, release)).resolves.toBe('ownership_lost');
    warn.mockRestore();
  });

  it('does not claim a yield succeeded if release fails', async () => {
    const release = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(releaseDeadlineYield(job, release)).resolves.toBe('ownership_lost');
    warn.mockRestore();
  });
});
