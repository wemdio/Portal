/** Requesty backpressure is shared by model inside one VE2 worker process.
 * Queue run_after persists each affected job's wait across worker restarts. */
export interface VeLlmRateLimit {
  retryAt: number;
  /** No HTTP request was made: waiting must not spend a failure/quality attempt. */
  deferred: boolean;
}

export class VeLlmRateLimitError extends Error implements VeLlmRateLimit {
  constructor(readonly retryAt: number, readonly deferred: boolean) {
    super('Requesty 429: сервис ИИ временно ограничил запросы; результаты сохранены.');
    this.name = 'VeLlmRateLimitError';
  }
}

export function veRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const until = /^\d+(?:\.\d+)?$/.test(text) ? now + Math.ceil(Number(text) * 1000) : Date.parse(text);
  return Number.isFinite(until) && until <= 8.64e15 && until >= now ? until - now : undefined;
}

export function createVeLlmRateLimit() {
  const models = new Map<string, { until: number; nextProbe: number; failures: number }>();
  const state = (model: string, now: number) => {
    const saved = models.get(model);
    if (saved && now >= saved.until + 60_000) { models.delete(model); return undefined; }
    return saved;
  };
  return {
    beforeRequest(model: string, now = Date.now()): number {
      const saved = state(model, now);
      if (!saved) return 0;
      const retryAt = Math.max(saved.until, saved.nextProbe);
      if (retryAt > now) throw new VeLlmRateLimitError(retryAt, true);
      // Spread recovery probes; otherwise all parallel bases hit the provider
      // together when the same Retry-After expires. Normal traffic is unchanged.
      saved.nextProbe = now + 1000;
      return saved.failures;
    },
    limited(model: string, generation: number, retryAfter: string | null | undefined, now = Date.now()): VeLlmRateLimitError {
      const previous = state(model, now);
      // Concurrent responses from the same wave count as one overload, not 16.
      const failures = Math.min(5, Math.max(previous?.failures ?? 0, generation + 1));
      const delay = Math.max(1000, veRetryAfterMs(retryAfter, now) ?? Math.min(30_000 * 2 ** (failures - 1), 300_000));
      const until = Math.max(previous?.until ?? 0, now + delay);
      models.set(model, { until, nextProbe: until, failures });
      return new VeLlmRateLimitError(until, false);
    },
  };
}

export const veLlmRateLimit = createVeLlmRateLimit();

/** Stable jitter disperses jobs without shortening the provider's requested wait. */
export function veRateLimitDelay(limit: VeLlmRateLimit, scope: string, now = Date.now()): number {
  let hash = 0;
  for (const char of scope) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return Math.max(1000, limit.retryAt - now) + hash % 5000;
}
