/** One bounded request at a time; stopped/expired requests cannot publish late data. */
export function startConstructorPolling<T>(options: {
  fetch: (signal: AbortSignal) => Promise<T>;
  onValue: (value: T) => boolean;
  onError: (error: unknown) => void;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  let stopped = false;
  let inFlight = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  async function refresh() {
    if (stopped || inFlight) return;
    clearTimeout(next);
    inFlight = true;
    controller = new AbortController();
    try {
      // The timeout also bounds auth/session retrieval, not just window.fetch.
      const value = await Promise.race([
        options.fetch(controller.signal),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            controller?.abort();
            reject(new Error('Не удалось обновить статус вовремя.'));
          }, options.timeoutMs ?? 20_000);
        }),
      ]);
      if (!stopped && !options.onValue(value)) stopped = true;
    } catch (error) {
      if (!stopped) options.onError(error);
    } finally {
      clearTimeout(deadline);
      inFlight = false;
      if (!stopped) next = setTimeout(() => { void refresh(); }, options.intervalMs ?? 3000);
    }
  }

  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(next);
      controller?.abort();
      // Keep the deadline until finally: a non-abortable auth promise must
      // still settle this loop without ever publishing into another job.
    },
  };
}
