/**
 * @jest-environment node
 *
 * Контракты updateJobWithRetry — ограниченные повторы сохранения,
 * без которой одиночный network-блип PostgREST убивал 8-часовой ta_scoring
 * job полностью (жалоба специалиста: «8к база, конструктор вечером выдает
 * Final update failed»).
 *
 * Сценарии:
 *   - первая попытка успех → 1 attempt
 *   - первая ошибка, вторая успех → 2 attempts
 *   - все три падают → возвращается last error (НЕ throws, caller сам решает)
 *   - сетевое исключение (throw) ловится так же как { error } из supabase
 */

type Response = { error?: { message: string; code?: string } | null; status?: number };
type UpdateResponse = Response | Error | ((signal: AbortSignal) => Promise<Response>);
const updateCalls: Array<{
  patch: Record<string, unknown>;
  filters: unknown[][];
  signal?: AbortSignal;
}> = [];
const updateResponses: UpdateResponse[] = [];

jest.mock('@/lib/supabaseAdmin', () => {
  const makeChain = (response: UpdateResponse, call: typeof updateCalls[number]) => {
    const chain = {
      eq: (...args: unknown[]) => { call.filters.push(['eq', ...args]); return chain; },
      neq: (...args: unknown[]) => { call.filters.push(['neq', ...args]); return chain; },
      abortSignal: (signal: AbortSignal) => { call.signal = signal; return chain; },
      then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(() => {
          if (response instanceof Error) throw response;
          return typeof response === 'function' ? response(call.signal!) : response;
        }).then(resolve, reject),
    };
    return chain;
  };

  return {
    supabaseAdmin: {
      from: () => ({
        update: (patch: Record<string, unknown>) => {
          const call = { patch, filters: [] };
          updateCalls.push(call);
          const next = updateResponses.shift() ?? { error: null };
          return makeChain(next, call);
        },
      }),
    },
  };
});

import { updateJobWithRetry } from '@/lib/tools/baseConstructorWorker';

// Паузы между попытками и recovery deadline прокручиваются виртуальными часами, а не
// проживаются: раньше файл честно спал ~8 секунд и был вторым по стоимости
// логическим тестом во всём наборе. Проверяем мы порядок и число попыток, а
// не способность Node действительно подождать секунду.
beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

// Прокручивает все запланированные паузы (в том числе те, что появятся уже во
// время прокрутки — backoff планирует их одну за другой) и отдаёт результат.
async function runSkippingBackoff<T>(pending: Promise<T>): Promise<T> {
  await jest.advanceTimersByTimeAsync(120_000);
  return pending;
}

beforeEach(() => {
  updateCalls.length = 0;
  updateResponses.length = 0;
});

describe('updateJobWithRetry', () => {
  it('succeeds on the first attempt → 1 attempt, no error', async () => {
    updateResponses.push({ error: null });
    const result = await runSkippingBackoff(updateJobWithRetry('job-1', { data: [['x']] }, 'test'));
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toEqual({ data: [['x']] });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries once after a transient error, then succeeds → 2 attempts', async () => {
    updateResponses.push({ error: { message: 'Empty or invalid json' } });
    updateResponses.push({ error: null });
    const result = await runSkippingBackoff(updateJobWithRetry('job-2', { data: [['y']] }, 'test'));
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(2);
    expect(updateCalls).toHaveLength(2);

    // Same recovery interval as the incident: 35 seconds is longer than the
    // old three attempts. Reuse the exact payload and fences on every retry.
    for (const outage of [
      { error: { message: 'An invalid response was received from the upstream server' }, status: 502 },
      { error: { message: 'Could not query the database for the schema cache', code: 'PGRST002' } },
      { error: { message: 'database system is in recovery mode', code: '57P03' } },
      { error: { message: 'Service Unavailable' }, status: 503 },
    ]) {
      updateCalls.length = 0;
      const started = Date.now();
      updateResponses.push(...Array.from({ length: 10 }, () => async () =>
        Date.now() - started < 35_000 ? outage : { error: null }));
      const patch = { data: [['saved validation state']], status: 'completed' };
      const recovered = await runSkippingBackoff(updateJobWithRetry('job-recovery', patch, 'final', {
        runToken: 'owner-1', neqStatus: 'cancelled',
      }));
      expect(recovered.error).toBeNull();
      expect(recovered.attempts).toBeGreaterThan(3);
      expect(recovered.ms).toBeGreaterThanOrEqual(35_000);
      expect(recovered.ms).toBeLessThanOrEqual(120_000);
      for (const call of updateCalls) {
        expect(call.patch).toBe(patch);
        expect(call.filters).toEqual([
          ['eq', 'id', 'job-recovery'], ['neq', 'status', 'cancelled'], ['eq', 'run_token', 'owner-1'],
        ]);
        expect(call.signal?.aborted).toBe(false);
      }
      expect(jest.getTimerCount()).toBe(0);
      updateResponses.length = 0;
    }
  });

  it('returns last error after all 3 attempts fail (no throw)', async () => {
    updateResponses.push({ error: { message: 'first' } });
    updateResponses.push({ error: { message: 'second' } });
    updateResponses.push({ error: { message: 'third' } });
    const result = await runSkippingBackoff(updateJobWithRetry('job-3', { data: [['z']] }, 'test'));
    expect(result.attempts).toBe(3);
    expect(updateCalls).toHaveLength(3);
    expect(result.error?.message).toBe('third');
    // A malformed payload must not be treated as an availability incident.
    updateCalls.length = 0;
    updateResponses.push(...Array.from({ length: 10 }, () => ({
      error: { message: 'Empty or invalid json', code: 'PGRST102' }, status: 400,
    })));
    const invalid = await runSkippingBackoff(updateJobWithRetry('bad-payload', {}, 'test'));
    expect(invalid.attempts).toBe(3);
    expect(invalid.error?.message).toBe('Empty or invalid json');
  });

  it('catches thrown network exceptions and treats them as retriable', async () => {
    // supabase-js обычно возвращает { error }, но network-сбой (fetch reject,
    // DNS failure) может вылететь exception'ом. Не должен утечь наружу.
    updateResponses.push(new Error('ECONNRESET'));
    updateResponses.push({ error: null });
    const result = await runSkippingBackoff(updateJobWithRetry('job-4', { data: [['q']] }, 'test'));
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(2);
    updateCalls.length = 0;
    updateResponses.push(...Array.from({ length: 10 }, () => new Error('fetch failed: ECONNRESET')));
    const unavailable = await runSkippingBackoff(updateJobWithRetry('job-outage', {}, 'test'));
    expect(unavailable.error?.message).toContain('ECONNRESET');
    expect(unavailable.attempts).toBeGreaterThan(3);
    expect(unavailable.attempts).toBeLessThanOrEqual(10);
    expect(unavailable.ms).toBeLessThanOrEqual(120_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns thrown exception as error message when all attempts throw', async () => {
    updateResponses.push(new Error('boom-1'));
    updateResponses.push(new Error('boom-2'));
    updateResponses.push(new Error('boom-3'));
    const result = await runSkippingBackoff(updateJobWithRetry('job-5', { data: [['w']] }, 'test'));
    expect(result.attempts).toBe(3);
    expect(result.error?.message).toBe('boom-3');
    updateCalls.length = 0;
    updateResponses.push((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    const stalled = await runSkippingBackoff(updateJobWithRetry('job-stalled', {}, 'test'));
    expect(stalled.error).not.toBeNull();
    expect(stalled.attempts).toBe(1);
    expect(stalled.ms).toBe(120_000);
    expect(updateCalls[0].signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
