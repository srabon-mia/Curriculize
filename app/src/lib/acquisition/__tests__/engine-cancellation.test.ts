import { describe, expect, it, vi } from 'vitest';

vi.mock('../http', () => ({
  acquireUrl: vi.fn((_url: string, options: { signal?: AbortSignal }) => new Promise((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })),
}));

import { acquireCandidate } from '../engine';

describe('candidate acquisition cancellation', () => {
  it('propagates invocation cancellation during an in-flight fetch instead of counting it as a candidate failure', async () => {
    const controller = new AbortController();
    const pending = acquireCandidate({
      url: 'https://example.org/lesson', title: 'Lesson', sourceDomain: 'example.org', resourceType: 'text', aiNote: '',
    }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
