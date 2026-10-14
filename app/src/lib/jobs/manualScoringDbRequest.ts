/** Bound both headers AND response-body parsing without changing other workers. */
export async function manualDbRequest<T>(request: PromiseLike<T>, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const abortable = request as PromiseLike<T> & { abortSignal?: (signal: AbortSignal) => PromiseLike<T> };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Manual scoring database request timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(abortable.abortSignal ? abortable.abortSignal(controller.signal) : request), deadline,
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
