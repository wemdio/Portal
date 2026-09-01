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
 *
 * Второй сюжет здесь — смещение очереди по аккаунтам (01.09.2026). Все
 * аккаунты читали очередь с одной головы, поэтому пробка из нерезолвящихся
 * ников выкашивала весь пул: каждый дошедший до неё аккаунт вставал на сутки.
 */

import { loadPendingByBase, queueOffsetForAccount } from '@/lib/tgOutreach/firstTouch/db';

interface SpyCall {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  head: boolean;
  range?: [number, number];
}

/** Записывает аргументы запроса вместо того, чтобы притворяться базой. */
function spyDb(rows: Array<Record<string, unknown>> = [], pendingCount = 0) {
  const calls: SpyCall[] = [];

  const db = {
    from(table: string) {
      const call: SpyCall = { table, columns: '', filters: {}, head: false };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (columns: string, opts?: { head?: boolean; count?: string }) => {
          call.columns = columns;
          call.head = Boolean(opts?.head);
          // Запрос-счётчик терминальный: у него нет ни order, ни range.
          return opts?.head
            ? Promise.resolve({ count: pendingCount, error: null })
            : chain;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return chain;
        },
        order: () => chain,
        range: async (from: number, to: number) => {
          call.range = [from, to];
          return { data: rows, error: null };
        },
      };
      // `eq` вызывается и на счётчике — там chain уже отдан промисом, поэтому
      // цепочку счётчика собираем отдельно.
      const counting: Record<string, unknown> = {
        eq: () => counting,
        then: (resolve: (v: unknown) => void) => resolve({ count: pendingCount, error: null }),
      };
      chain.select = (columns: string, opts?: { head?: boolean }) => {
        call.columns = columns;
        call.head = Boolean(opts?.head);
        return opts?.head ? counting : chain;
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
    expect(calls[0]!.range).toEqual([0, 9]);
  });

  it('доносит attempts из базы до контакта, а не обнуляет по дороге', async () => {
    const { db } = spyDb([
      { id: 'c-1', base_id: 'base-1', username: 'ivanov', message: 'привет', attempts: 2 },
    ]);

    const out = await loadPendingByBase(db, ['base-1'], 50);

    expect(out[0]!.contacts[0]!.attempts).toBe(2);
  });

  it('без аккаунта читает с головы очереди и не считает её длину', async () => {
    const { db, calls } = spyDb([], 500);

    await loadPendingByBase(db, ['base-1'], 3);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.head).toBe(false);
    expect(calls[0]!.range).toEqual([0, 2]);
  });

  it('с аккаунтом сначала меряет очередь, потом берёт свой участок', async () => {
    const { db, calls } = spyDb([], 500);

    await loadPendingByBase(db, ['base-1'], 3, 'account-a');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.head).toBe(true);
    const [from, to] = calls[1]!.range!;
    expect(to - from).toBe(2);
    expect(from).toBeGreaterThan(0);
  });
});

describe('смещение очереди по аккаунтам', () => {
  it('разные аккаунты начинают с разных мест — иначе пробка валит весь пул', () => {
    const offsets = new Set(
      ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5'].map((id) => queueOffsetForAccount(id, 500, 3)),
    );
    expect(offsets.size).toBeGreaterThan(1);
  });

  it('один и тот же аккаунт не прыгает по очереди между кругами', () => {
    expect(queueOffsetForAccount('acc-1', 500, 3)).toBe(queueOffsetForAccount('acc-1', 500, 3));
  });

  it('не уводит выборку за конец очереди', () => {
    for (const pending of [0, 1, 2, 3, 4, 10, 97]) {
      const offset = queueOffsetForAccount('acc-1', pending, 3);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset + 3).toBeLessThanOrEqual(Math.max(pending, 3));
    }
  });

  it('на короткой очереди читает с начала: делить нечего', () => {
    expect(queueOffsetForAccount('acc-1', 3, 3)).toBe(0);
    expect(queueOffsetForAccount('acc-1', 0, 3)).toBe(0);
  });
});
