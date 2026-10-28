/** One FIFO for all jobs (including catalog discovery) in this worker process. */
export class YandexMapsParseQueue {
  private active = 0;
  private limit = 2;
  private waiting: Array<{ start: () => void; signal?: AbortSignal; abort: () => void }> = [];

  setCapacity(value: unknown): void {
    const capacity = Number(value);
    // Unknown/older service: keep the production-safe two-slot fallback.
    this.limit = Number.isInteger(capacity) && capacity > 0 ? Math.min(capacity, 8) : 2;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift()!;
      next.signal?.removeEventListener('abort', next.abort);
      this.active++;
      next.start();
    }
  }

  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry = {
        start: resolve,
        signal,
        abort: () => {
          this.waiting = this.waiting.filter((item) => item !== entry);
          reject(signal?.reason ?? new Error('YandexMaps request cancelled'));
        },
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.drain();
    });
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      this.active--;
      this.drain();
    }
  }
}

export const yandexMapsParseQueue = new YandexMapsParseQueue();
