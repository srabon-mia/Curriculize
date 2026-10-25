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

import {
  callAIDiscover,
  createTopicDiscoveryMetrics,
  getResumableTopicDiscovery,
  logTopicDiscoveryMetrics,
  processCandidatesFromCheckpoint,
  readDiscoveryCache,
  serializeDiscoveryCache,
  processBatchDiscovery,
} from '@/lib/acquisition/worker';

describe('topic discovery diagnostics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes safe curriculum, job, topic, and operation context to Azure diagnostics', async () => {
    mocks.complete.mockResolvedValue({ text: '[]' });

    await callAIDiscover('prompt is not logged', {
      curriculumId: 'curriculum-1',
      jobId: 'job-1',
      topicId: 'topic-1',
    });

    expect(mocks.complete).toHaveBeenCalledWith('prompt is not logged', {
      useSearch: true,
      maxTokens: 2000,
      diagnostics: {
        curriculumId: 'curriculum-1',
        jobId: 'job-1',
        topicId: 'topic-1',
        operation: 'worker_topic_discovery',
      },
    });
  });

  it('logs aggregate topic-stage counts without candidate URLs or output text', () => {
    const metrics = createTopicDiscoveryMetrics();
    Object.assign(metrics, {
      responseTextChars: 120,
      parsedCandidates: 4,
      rejectedUrlOrTitle: 1,
      fetchFailures: 1,
      contentExtractionFailures: 0,
      interstitialPageFailures: 0,
      verificationRejections: 1,
      persistenceSuccesses: 1,
      persistenceFailures: 0,
      eligibleAssociations: 1,
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    logTopicDiscoveryMetrics('topic-1', metrics);

    expect(log).toHaveBeenCalledWith('[worker] Topic candidate processing summary', {
      topic_id: 'topic-1',
      response_text_chars: 120,
      parsed_candidates: 4,
      rejected_url_or_title: 1,
      fetch_failures: 1,
      content_extraction_failures: 0,
      interstitial_page_failures: 0,
      verification_rejections: 1,
      persistence_successes: 1,
      persistence_failures: 0,
      final_eligible_associations: 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('http');
    log.mockRestore();
  });

  it('persists parsed topic candidates before a budget yield and resumes the cursor without another search', async () => {
    const sources = [{ domain: 'openstax.org', name: 'OpenStax', why: 'textbook', best_for: 'lessons' }];
    const responseText = '[{"url":"https://openstax.org/a","title":"A"},{"url":"https://openstax.org/b","title":"B"}]';
    let savedCache: unknown;
    let searchCalls = 0;
    const discoverOrResume = (checkpoint: ReturnType<typeof readDiscoveryCache>['topicCheckpoint']) => {
      const resumable = getResumableTopicDiscovery(checkpoint, 'topic-1', 0, 'a'.repeat(64));
      if (resumable) return resumable.responseText;
      searchCalls++;
      return responseText;
    };
    const firstResponse = discoverOrResume(null);
    savedCache = serializeDiscoveryCache(sources, {
      topicId: 'topic-1', attemptIndex: 0, promptHash: 'a'.repeat(64), responseText: firstResponse, nextCandidateIndex: 0,
    });
    const firstCache = readDiscoveryCache(savedCache);
    expect(firstCache.sources).toEqual(sources);
    expect(firstCache.topicCheckpoint?.responseText).toBe(responseText);

    const processed: string[] = [];
    let candidateChecks = 0;
    await expect(processCandidatesFromCheckpoint({
      candidates: JSON.parse(firstCache.topicCheckpoint!.responseText) as Array<{ title: string }>,
      startAt: firstCache.topicCheckpoint!.nextCandidateIndex,
      checkBeforeCandidate: () => {
        candidateChecks++;
        if (candidateChecks > 1) throw new Error('Processor work budget reached');
      },
      processCandidate: async (candidate) => { processed.push(candidate.title); },
      saveNextCandidateIndex: async (nextCandidateIndex) => {
        savedCache = serializeDiscoveryCache(sources, { ...firstCache.topicCheckpoint!, nextCandidateIndex });
      },
    })).rejects.toThrow('Processor work budget reached');
    expect(processed).toEqual(['A']);
    expect(readDiscoveryCache(savedCache).topicCheckpoint?.nextCandidateIndex).toBe(1);

    // A source discovery that returns no usable sources must still preserve
    // the candidate response checkpoint in the shared cache.
    savedCache = serializeDiscoveryCache([], readDiscoveryCache(savedCache).topicCheckpoint);

    // The subsequent invocation resumes the saved response; it does not call
    // Azure again and advances a durable cursor after each candidate.
    const resumedCache = readDiscoveryCache(savedCache);
    const resumed = getResumableTopicDiscovery(resumedCache.topicCheckpoint, 'topic-1', 0, 'a'.repeat(64))!;
    expect(discoverOrResume(resumedCache.topicCheckpoint)).toBe(responseText);
    const resumedCandidates = JSON.parse(resumed.responseText) as Array<{ title: string }>;
    await processCandidatesFromCheckpoint({
      candidates: resumedCandidates,
      startAt: resumed.nextCandidateIndex,
      checkBeforeCandidate: () => undefined,
      processCandidate: async (candidate) => { processed.push(candidate.title); },
      saveNextCandidateIndex: async (nextCandidateIndex) => {
        savedCache = serializeDiscoveryCache(sources, { ...resumed, nextCandidateIndex });
      },
    });
    expect(searchCalls).toBe(1);
    expect(processed).toEqual(['A', 'B']);
    expect(readDiscoveryCache(savedCache).topicCheckpoint?.nextCandidateIndex).toBe(2);
    expect(getResumableTopicDiscovery(resumedCache.topicCheckpoint, 'other-topic', 0, 'a'.repeat(64))).toBeNull();
    expect(getResumableTopicDiscovery(resumedCache.topicCheckpoint, 'topic-1', 1, 'a'.repeat(64))).toBeNull();
    expect(getResumableTopicDiscovery(resumedCache.topicCheckpoint, 'topic-1', 0, 'b'.repeat(64))).toBeNull();
    expect(readDiscoveryCache(serializeDiscoveryCache(sources, {
      ...resumed,
      nextCandidateIndex: 99,
    })).topicCheckpoint).toBeNull();
    expect(readDiscoveryCache(serializeDiscoveryCache(sources, {
      ...resumed,
      responseText: 'not valid JSON',
      nextCandidateIndex: 0,
    })).topicCheckpoint).toBeNull();
  });

  it('preserves a valid candidate checkpoint when updating an empty source cache', () => {
    const checkpoint = {
      topicId: 'topic-1', attemptIndex: 0, promptHash: 'a'.repeat(64),
      responseText: '[]', nextCandidateIndex: 0,
    };
    const existingCache = serializeDiscoveryCache([], checkpoint);

    const updatedCache = serializeDiscoveryCache([], readDiscoveryCache(existingCache).topicCheckpoint);

    expect(readDiscoveryCache(updatedCache).topicCheckpoint).toEqual(checkpoint);
  });

  it('updates source entries while retaining a valid candidate checkpoint', () => {
    const checkpoint = {
      topicId: 'topic-1', attemptIndex: 0, promptHash: 'a'.repeat(64),
      responseText: '[]', nextCandidateIndex: 0,
    };
    const existingCache = serializeDiscoveryCache([
      { domain: 'old.example', name: 'Old', why: 'old', best_for: 'old' },
    ], checkpoint);
    const updatedSources = [
      { domain: 'new.example', name: 'New', why: 'new', best_for: 'new' },
    ];

    const updatedCache = serializeDiscoveryCache(updatedSources, readDiscoveryCache(existingCache).topicCheckpoint);
    const decoded = readDiscoveryCache(updatedCache);

    expect(decoded.sources).toEqual(updatedSources);
    expect(decoded.topicCheckpoint).toEqual(checkpoint);
  });

  it('drops invalid checkpoints and rejects stale checkpoint keys after a source update', () => {
    const valid = {
      topicId: 'topic-1', attemptIndex: 0, promptHash: 'a'.repeat(64),
      responseText: '[]', nextCandidateIndex: 0,
    };
    const invalidCache = serializeDiscoveryCache([], { ...valid, nextCandidateIndex: 1 });

    const updatedInvalidCache = serializeDiscoveryCache([], readDiscoveryCache(invalidCache).topicCheckpoint);
    const invalidRead = readDiscoveryCache(updatedInvalidCache);
    expect(invalidRead.topicCheckpoint).toBeNull();
    expect(getResumableTopicDiscovery(invalidRead.topicCheckpoint, 'topic-1', 0, 'a'.repeat(64))).toBeNull();

    const updatedValidCache = serializeDiscoveryCache([], valid);
    const staleRead = readDiscoveryCache(updatedValidCache);
    expect(getResumableTopicDiscovery(staleRead.topicCheckpoint, 'other-topic', 0, 'a'.repeat(64))).toBeNull();
    expect(getResumableTopicDiscovery(staleRead.topicCheckpoint, 'topic-1', 1, 'a'.repeat(64))).toBeNull();
    expect(getResumableTopicDiscovery(staleRead.topicCheckpoint, 'topic-1', 0, 'b'.repeat(64))).toBeNull();
  });

  it('does not advance the candidate cursor after a persistence failure', async () => {
    const saveCursor = vi.fn(async (_nextCandidateIndex: number) => undefined);
    const processCandidate = vi.fn(async (_candidate: string) => {
      throw new Error('transient persistence failure');
    });
    await expect(processCandidatesFromCheckpoint({
      candidates: ['candidate-1', 'candidate-2'],
      startAt: 0,
      checkBeforeCandidate: () => undefined,
      processCandidate,
      saveNextCandidateIndex: saveCursor,
    })).rejects.toThrow('transient persistence failure');
    expect(processCandidate).toHaveBeenCalledTimes(1);
    expect(saveCursor).not.toHaveBeenCalled();
  });
});

function queryResult(data: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'abortSignal']) {
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
    mocks.releaseJobClaim.mockResolvedValue(true);
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

  it('persists verified candidates onto the named concepts across multiple topics', async () => {
    const { acquireCandidate } = await import('@/lib/acquisition/engine');
    const { persistWithFence } = await import('@/lib/acquisition/jobService');
    const topicCandidates = (prefix: string) => [1, 2].map((index) => ({
      url: `https://ocw.mit.edu/${prefix}-${index}`,
      title: `${prefix} differential equations lesson ${index}`,
      resource_type: 'text',
      source_domain: 'ocw.mit.edu',
      ai_note: `Relevant instruction for ${prefix}.${index}`,
      license_status: 'link_only',
      understanding_codes: [`${prefix}.${index}`],
    }));
    mocks.complete
      .mockResolvedValueOnce({ text: JSON.stringify({ topic_resources: topicCandidates('A') }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ topic_resources: topicCandidates('B') }) });

    vi.mocked(acquireCandidate).mockResolvedValue({
      success: true,
      acquiredPage: {
        finalUrl: 'https://ocw.mit.edu/course/lesson',
        canonicalUrl: { url: 'https://ocw.mit.edu/course/lesson' },
        contentHash: 'content-hash',
        statusCode: 200,
        contentType: 'text/html',
        acquiredAt: '2026-10-25T00:00:00.000Z',
      },
      structuredContent: {
        metadata: { title: 'Differential Equations Lesson', description: '', author: '', datePublished: '', language: 'en' },
        source: { cleanedHash: 'cleaned-hash', contentHash: 'content-hash' },
        statistics: { wordCount: 140, headingCount: 1, paragraphCount: 2 },
        blocks: [{ text: 'A differential equation is defined as a relation involving derivatives.', tagName: 'p' }],
      },
    } as never);
    vi.mocked(persistWithFence).mockImplementation(async (_jobId, _claimToken, input) => ({
      resource_id: `resource-${input.target.understandingId}`,
      vr_id: `verification-${input.target.understandingId}`,
      mapping_id: null,
      is_exact_retry: false,
    }));
    mocks.recordResourceCoverageAttempt.mockResolvedValue({ status: 'complete', retry: false });

    const targetMus: Record<string, Array<{ id: string; code: string; description: string; external_key: string }>> = {
      'topic-a': [1, 2].map((i) => ({ id: `mu-a-${i}`, code: `A.${i}`, description: `Differential equations concept ${i}`, external_key: `A.${i}` })),
      'topic-b': [1, 2].map((i) => ({ id: `mu-b-${i}`, code: `B.${i}`, description: `Differential equations concept ${i}`, external_key: `B.${i}` })),
    };
    let selectedNodeId = '';
    const eligibleRows = Object.values(targetMus).flatMap((rows) => rows.flatMap((mu) => [
      { major_understanding_id: mu.id }, { major_understanding_id: mu.id },
    ]));
    mocks.createClient.mockReturnValue({
      from(table: string) {
        if (table === 'curricula') return queryResult({ title: 'Differential Equations' });
        if (table === 'major_understandings') {
          return {
            select() { return this; },
            eq(_column: string, nodeId: string) { selectedNodeId = nodeId; return this; },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve({ data: targetMus[selectedNodeId] ?? [], error: null }).then(resolve, reject);
            },
          };
        }
        if (table === 'resources') {
          let targetIds: string[] = [];
          return {
            select() { return this; },
            in(_column: string, ids: string[]) { targetIds = ids; return this; },
            eq() { return this; },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve({ data: eligibleRows.filter((row) => targetIds.includes(row.major_understanding_id)), error: null }).then(resolve, reject);
            },
          };
        }
        return queryResult(null);
      },
    } as never);

    vi.useFakeTimers();
    try {
      const work = processBatchDiscovery({
        id: 'same-job', curriculum_id: 'same-curriculum', claim_token: 'fenced-token', claim_version: 7,
        budget_limits: { max_ai_calls: 32 },
      } as never, 'Differential Equations', [
        { nodeId: 'topic-a', node: { title: 'Topic A', order_index: 1, major_understandings: [] } },
        { nodeId: 'topic-b', node: { title: 'Topic B', order_index: 2, major_understandings: [] } },
      ]);
      await vi.runAllTimersAsync();
      await expect(work).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const persistedInputs = vi.mocked(persistWithFence).mock.calls.map(([, , input]) => input);
    expect(persistedInputs).toHaveLength(4);
    expect(persistedInputs.map((input) => input.target.understandingId).sort()).toEqual([
      'mu-a-1', 'mu-a-2', 'mu-b-1', 'mu-b-2',
    ]);
    expect(mocks.recordResourceCoverageAttempt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(acquireCandidate)).toHaveBeenCalledTimes(4);
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
    expect(firstDone).toBe('yielded');
    expect(mocks.recordResourceCoverageAttempt.mock.calls.map(([call]) => call.targetId)).toEqual(['topic-3', 'topic-3', 'topic-4', 'topic-4']);
    expect(mocks.releaseJobClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseJobClaim).toHaveBeenLastCalledWith('same-job', 'fenced-token', 7);

    const secondDone = await processBatchDiscovery(job, 'Geometry', topics);
    expect(secondDone).toBe('yielded');
    expect(mocks.recordResourceCoverageAttempt.mock.calls.map(([call]) => call.targetId)).toEqual([
      'topic-3', 'topic-3', 'topic-4', 'topic-4', 'topic-5', 'topic-5', 'topic-6', 'topic-6',
    ]);
    expect(mocks.releaseJobClaim).toHaveBeenCalledTimes(2);
    expect(mocks.releaseJobClaim).toHaveBeenLastCalledWith('same-job', 'fenced-token', 7);

    const thirdDone = await processBatchDiscovery(job, 'Geometry', topics);
    expect(thirdDone).toBe('yielded');
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
    expect(mocks.getJobById).toHaveBeenCalledWith('same-job', undefined);
    expect(mocks.complete.mock.calls.every(([, options]) => options.maxTokens === 4000)).toBe(true);
  });
});
