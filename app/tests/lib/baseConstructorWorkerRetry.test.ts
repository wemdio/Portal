/**
 * @jest-environment node
 *
 * Контракты updateJobWithRetry — три попытки с exponential backoff (1s/2s/4s),
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

const updateCalls: Array<{ patch: Record<string, unknown> }> = [];
const updateResponses: Array<{ error?: { message: string } | null } | Error> = [];

jest.mock('@/lib/supabaseAdmin', () => {
  const makeChain = (response: { error?: { message: string } | null } | Error) => {
    // .update(patch).eq(...) → awaitable; awaiting должно вернуть response
    // (или сразу throw, если задали Error).
    const chain = {
      eq: () => {
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve(response);
      },
    };
    return chain;
  };

  return {
    supabaseAdmin: {
      from: () => ({
        update: (patch: Record<string, unknown>) => {
          updateCalls.push({ patch });
          const next = updateResponses.shift() ?? { error: null };
          return makeChain(next);
        },
      }),
    },
  };
});

import { updateJobWithRetry } from '@/lib/tools/baseConstructorWorker';

// Паузы между попытками (1s, 2s) прокручиваются виртуальными часами, а не
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
  await jest.advanceTimersByTimeAsync(10_000);
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
  });

  it('retries once after a transient error, then succeeds → 2 attempts', async () => {
    updateResponses.push({ error: { message: 'Empty or invalid json' } });
    updateResponses.push({ error: null });
    const result = await runSkippingBackoff(updateJobWithRetry('job-2', { data: [['y']] }, 'test'));
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(2);
    expect(updateCalls).toHaveLength(2);
  });

  it('returns last error after all 3 attempts fail (no throw)', async () => {
    updateResponses.push({ error: { message: 'first' } });
    updateResponses.push({ error: { message: 'second' } });
    updateResponses.push({ error: { message: 'third' } });
    const result = await runSkippingBackoff(updateJobWithRetry('job-3', { data: [['z']] }, 'test'));
    expect(result.attempts).toBe(3);
    expect(updateCalls).toHaveLength(3);
    expect(result.error?.message).toBe('third');
  });

  it('catches thrown network exceptions and treats them as retriable', async () => {
    // supabase-js обычно возвращает { error }, но network-сбой (fetch reject,
    // DNS failure) может вылететь exception'ом. Не должен утечь наружу.
    updateResponses.push(new Error('ECONNRESET'));
    updateResponses.push({ error: null });
    const result = await runSkippingBackoff(updateJobWithRetry('job-4', { data: [['q']] }, 'test'));
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(2);
  });

  it('returns thrown exception as error message when all attempts throw', async () => {
    updateResponses.push(new Error('boom-1'));
    updateResponses.push(new Error('boom-2'));
    updateResponses.push(new Error('boom-3'));
    const result = await runSkippingBackoff(updateJobWithRetry('job-5', { data: [['w']] }, 'test'));
    expect(result.attempts).toBe(3);
    expect(result.error?.message).toBe('boom-3');
  });
});
