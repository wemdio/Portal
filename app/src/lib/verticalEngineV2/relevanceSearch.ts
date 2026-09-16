import 'server-only';
import { beginProviderUsage, getProviderUsageScope, type ProviderUsageDetails } from '@/lib/providerUsage';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { VeOperationTimeoutError, withVeDeadline } from './operationDeadline';

export const VE_RELEVANCE_SEARCH_TIMEOUT_MS = 30_000;
// The evidence reader also bounds injected search adapters and metering around
// the transport. It must leave time for the same request's usage journal.
export const VE_RELEVANCE_SEARCH_OPERATION_TIMEOUT_MS = 90_000;

export interface VeSearchProviderFailure {
  kind: 'billing' | 'configuration' | 'transient';
  message: string;
}

const FAILURE_MESSAGES: Record<VeSearchProviderFailure['kind'], string> = {
  billing: 'Serper billing: insufficient search credits.',
  configuration: 'Serper configuration: search API key or request is invalid.',
  transient: 'Serper transient: search service unavailable.',
};

/** Only stable messages cross the provider boundary; response bodies and keys never do. */
export class VeSearchProviderError extends Error {
  constructor(public readonly kind: VeSearchProviderFailure['kind'], detail?: 'timeout' | 'transport' | 'rate_limit' | 'cooldown') {
    super(kind === 'transient' && detail ? `Serper transient: ${detail}.` : FAILURE_MESSAGES[kind]);
    this.name = 'VeSearchProviderError';
  }
}

export function veSearchProviderFailure(error: unknown): VeSearchProviderFailure {
  if (error instanceof VeOperationTimeoutError) return { kind: 'transient', message: 'Serper transient: timeout.' };
  const kind = error instanceof VeSearchProviderError ? error.kind : 'transient';
  return { kind, message: error instanceof VeSearchProviderError ? error.message : FAILURE_MESSAGES[kind] };
}

/** One process-wide search budget across parallel bases. Waiting is abortable
 * and happens before metering/HTTP; an outage rejects the queue without buying
 * more searches. The stage's durable retry policy owns the later retry. */
export function createVeSearchCapacity(limit = 8, failureLimit = 4, cooldownMs = 60_000) {
  if (![limit, failureLimit, cooldownMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('Search capacity, failure limit and cooldown must be positive integers');
  }
  let active = 0, failures = 0, blockedUntil = 0;
  type Waiter = { signal?: AbortSignal; resolve: () => void; reject: (error: unknown) => void; onAbort: () => void };
  const queue: Waiter[] = [];
  const blocked = () => Date.now() < blockedUntil;
  const drain = () => {
    while (queue.length && (blocked() || active < limit)) {
      const waiter = queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) waiter.reject(waiter.signal.reason);
      else if (blocked()) waiter.reject(new VeSearchProviderError('transient', 'cooldown'));
      else { active += 1; waiter.resolve(); }
    }
  };
  return async <T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    if (blocked()) throw new VeSearchProviderError('transient', 'cooldown');
    if (active < limit) active += 1;
    else await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, onAbort: () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener('abort', waiter.onAbort);
        reject(signal?.reason);
      } };
      queue.push(waiter);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
    });
    try {
      signal?.throwIfAborted();
      if (blocked()) throw new VeSearchProviderError('transient', 'cooldown');
      const result = await work();
      failures = 0;
      return result;
    } catch (error) {
      if (!signal?.aborted && error instanceof VeSearchProviderError && error.kind === 'transient'
        && !error.message.includes('cooldown') && ++failures >= failureLimit) {
        blockedUntil = Date.now() + cooldownMs;
        failures = 0;
      }
      throw error;
    } finally {
      active -= 1;
      drain();
    }
  };
}

const withSearchCapacity = createVeSearchCapacity();

/** Исчерпанный баланс Serper приходит тем же кодом 429, что и «слишком часто»:
 * различает их только текст ответа. Пока 429 читался как временный сбой,
 * «кончились кредиты» показывалось пользователю как «сервис временно
 * недоступен» — и человек искал поломку вместо того, чтобы пополнить счёт.
 *
 * Список формулировок намеренно узкий. Ошибиться в эту сторону дороже:
 * приняв обычное ограничение частоты за нехватку денег, движок перестанет
 * повторять запросы и пошлёт оператора платить без повода. */
const CREDITS_EXHAUSTED =
  /not enough credits|insufficient[\s_-]+(?:funds|balance|credits|search credits)|payment[\s_-]+required|credit balance (?:is )?too low|out of credits/i;

function responseFailure(status: number, body: string): VeSearchProviderError {
  if (status === 402 || (status >= 400 && status < 500 && CREDITS_EXHAUSTED.test(body))) {
    return new VeSearchProviderError('billing');
  }
  if (status === 429) return new VeSearchProviderError('transient', 'rate_limit');
  return new VeSearchProviderError(
    status >= 400 && status < 500 && ![408, 425].includes(status) ? 'configuration' : 'transient');
}

/** Strict VE2 search: an empty successful search is data, a provider failure is not. */
export async function searchVeRelevanceWebsites(query: string, signal?: AbortSignal): Promise<SerperOrganicItem[]> {
  signal?.throwIfAborted();
  const apiKey = (process.env.SERPER_API_KEY ?? '').trim();
  if (!apiKey) throw new VeSearchProviderError('configuration');
  return withSearchCapacity(signal, async () => {
    const metered = getProviderUsageScope() !== undefined;
    const metering = await beginProviderUsage('serper');
    const usage: ProviderUsageDetails = { status: 'ambiguous' };
    try {
      return await withVeDeadline('Serper relevance search', VE_RELEVANCE_SEARCH_TIMEOUT_MS, signal, async (requestSignal) => {
        const response = await fetch('https://google.serper.dev/search', {
          method: 'POST', signal: requestSignal, redirect: 'error',
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, num: 6, gl: 'ru', hl: 'ru' }),
        });
        usage.httpStatus = response.status;
        usage.providerRequestId = response.headers?.get('x-request-id') ?? undefined;
        if (!response.ok) usage.status = 'http_error';
        requestSignal.throwIfAborted();
        if (!response.ok) {
          // Metered failures may include returned credits. The response body
          // itself is never retained — оно нужно только чтобы отличить отказ
          // по деньгам от отказа по частоте. 400, 402 и 429 читаются всегда:
          // именно в их теле лежит эта разница (см. CREDITS_EXHAUSTED).
          const readBody = response.status === 400 || response.status === 402 || response.status === 429 || metered;
          const body = readBody ? await response.text() : '';
          if (!readBody) await response.body?.cancel().catch(() => undefined);
          if (metered && body) {
            try { usage.serperCredits = reportedCredits(JSON.parse(body)); } catch { /* Non-JSON error body. */ }
          }
          requestSignal.throwIfAborted();
          throw responseFailure(response.status, body);
        }
        const data: unknown = await response.json();
        usage.serperCredits = reportedCredits(data);
        requestSignal.throwIfAborted();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new VeSearchProviderError('transient');
        const record = data as Record<string, unknown>;
        usage.status = 'success';
        if (record.error || (typeof record.statusCode === 'number' && record.statusCode >= 400)) {
          usage.status = 'http_error';
          // Serper умеет ответить 200 с ошибкой внутри тела: причина лежит
          // то в message, то в error — читаем оба, иначе теряем «нет кредитов».
          throw responseFailure(typeof record.statusCode === 'number' ? record.statusCode : 500,
            [record.message, record.error].filter((part): part is string => typeof part === 'string').join(' '));
        }
        if (record.organic !== undefined && !Array.isArray(record.organic)) throw new VeSearchProviderError('transient');
        return ((record.organic ?? []) as unknown[]).filter((item): item is SerperOrganicItem =>
          item != null && typeof item === 'object' && typeof (item as SerperOrganicItem).link === 'string');
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error instanceof VeSearchProviderError ? error : new VeSearchProviderError('transient',
        error instanceof VeOperationTimeoutError ? 'timeout' : 'transport');
    } finally {
      await metering.finish(usage);
    }
  });
}

function reportedCredits(data: unknown): number | undefined {
  const credits = data && typeof data === 'object' ? (data as { credits?: unknown }).credits : undefined;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}
