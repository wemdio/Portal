/** @jest-environment node */

/**
 * Корень инцидента 18.08.2026: `loadPendingByBase` выбирал
 * `id, base_id, username, message` — без `attempts`. Дальше send.ts читает
 * счётчик именно с контакта, чтобы понять, какая это попытка; без колонки там
 * всегда 0, `recordContactFailure` вечно пишет 1, статус `failed` не наступает,
 * и недоступный контакт возвращается в очередь бесконечно. В проде это дало
 * 548 попыток на 18 человек (@panamax_ae — 168), а `failed` не встретился в
 * таблице НИ РАЗУ за всю её историю: ветка была мёртвой.
 *
 * Тест смотрит именно на список колонок, а не на поведение: подставные
 * Supabase в остальных тестах аргумент `.select()` игнорируют и отдают
 * заготовленные строки, поэтому откат фикса они не замечают — все 549 тестов
 * оставались зелёными.
 */

import { loadPendingByBase } from '@/lib/tgOutreach/firstTouch/db';

/** Записывает аргументы запроса вместо того, чтобы притворяться базой. */
function spyDb(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ table: string; columns: string; filters: Record<string, unknown>; limit?: number }> = [];

  const db = {
    from(table: string) {
      const call = { table, columns: '', filters: {} as Record<string, unknown>, limit: undefined as number | undefined };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (columns: string) => {
          call.columns = columns;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return chain;
        },
        order: () => chain,
        limit: async (n: number) => {
          call.limit = n;
          return { data: rows, error: null };
        },
      };
      return chain;
    },
  };

  return { db: db as never, calls };
}

describe('loadPendingByBase — выборка колонок', () => {
  it('тянет attempts: без него лимит трёх попыток не наступает никогда', async () => {
    const { db, calls } = spyDb();

    await loadPendingByBase(db, ['base-1'], 50);

    expect(calls).toHaveLength(1);
    const columns = calls[0]!.columns.split(',').map((c) => c.trim());
    expect(columns).toContain('attempts');
  });

  it('тянет остальные поля, без которых отправка не соберётся', async () => {
    const { db, calls } = spyDb();

    await loadPendingByBase(db, ['base-1'], 50);

    const columns = calls[0]!.columns.split(',').map((c) => c.trim());
    expect(columns).toEqual(expect.arrayContaining(['id', 'base_id', 'username', 'message']));
  });

  it('берёт только pending и только свою базу, по одному запросу на базу', async () => {
    const { db, calls } = spyDb();

    await loadPendingByBase(db, ['base-1', 'base-2'], 10);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.filters).toEqual({ base_id: 'base-1', status: 'pending' });
    expect(calls[1]!.filters).toEqual({ base_id: 'base-2', status: 'pending' });
    expect(calls[0]!.limit).toBe(10);
  });

  it('доносит attempts из базы до контакта, а не обнуляет по дороге', async () => {
    const { db } = spyDb([
      { id: 'c-1', base_id: 'base-1', username: 'ivanov', message: 'привет', attempts: 2 },
    ]);

    const out = await loadPendingByBase(db, ['base-1'], 50);

    expect(out[0]!.contacts[0]!.attempts).toBe(2);
  });
});
