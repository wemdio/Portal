/** A retryable operation deadline, distinct from a user's cancellation. */
export class VeOperationTimeoutError extends Error {
  constructor(public readonly label: string, public readonly timeoutMs: number) {
    super(`VE operation timeout after ${timeoutMs}ms: ${label}`);
    this.name = 'VeOperationTimeoutError';
  }
}

/**
 * Bound one transport/read operation, not an entire stage with database writes.
 * Abort the underlying transport and reject even if an adapter ignores abort.
 * Work must pass the signal to transport and check it after unabortable awaits
 * (notably DNS), before starting subsequent work. Late results are discarded.
 */
export async function withVeDeadline<T>(
  label: string,
  timeoutMs: number,
  parent: AbortSignal | null | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('VE operation timeout must be finite and positive');
  }
  const controller = new AbortController();
  const { signal } = controller;
  const onParentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new VeOperationTimeoutError(label, timeoutMs)), timeoutMs);
  try {
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    });
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
    signal.removeEventListener('abort', onAbort);
  }
}
