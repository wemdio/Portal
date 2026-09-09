export type InstantlyEmailReadDeferredReason = 'budget' | 'cooldown' | 'storage_unavailable';

export interface InstantlyEmailReadDeferral {
  reason: InstantlyEmailReadDeferredReason;
  retryAfterMs: number;
}

/** Pure recognition shared by retry scheduling and callers that preserve only
 * a wrapped Error.message. A local admission denial is not a provider 429. */
export function readInstantlyEmailReadDeferral(error: unknown): InstantlyEmailReadDeferral | null {
  let current = error;
  // Bounded traversal also handles an accidentally cyclic Error.cause chain.
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const value = typeof current === 'object'
      ? current as { name?: unknown; reason?: unknown; retryAfterMs?: unknown; message?: unknown; cause?: unknown }
      : null;
    if (value?.name === 'InstantlyEmailReadDeferredError' &&
        (value.reason === 'budget' || value.reason === 'cooldown' || value.reason === 'storage_unavailable') &&
        typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs > 0) {
      return { reason: value.reason, retryAfterMs: Math.ceil(value.retryAfterMs) };
    }
    const message = typeof current === 'string' ? current : typeof value?.message === 'string' ? value.message : '';
    const match = message.match(/Instantly email read deferred:\s*(budget|cooldown|storage_unavailable);\s*retry after (\d+(?:\.\d+)?) ms\b/i);
    if (match) {
      const retryAfterMs = Number(match[2]);
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return { reason: match[1].toLowerCase() as InstantlyEmailReadDeferredReason, retryAfterMs: Math.ceil(retryAfterMs) };
      }
    }
    current = value?.cause;
  }
  return null;
}
