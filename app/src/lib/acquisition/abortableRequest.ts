/** Apply Supabase/PostgREST's native AbortSignal support; no Promise.race. */
export function withAbortSignal<T>(request: T, signal?: AbortSignal): T {
  if (!signal) return request;
  const abortable = request as T & { abortSignal?: (signal: AbortSignal) => T };
  if (typeof abortable.abortSignal !== 'function') {
    throw new Error('Database request builder does not support AbortSignal');
  }
  return abortable.abortSignal(signal);
}

export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
