/** @jest-environment node */

/**
 * Возврат в очередь переписок, прерванных перезапуском воркера.
 *
 * 06.08.2026 воркер перезапускался восемь раз за смену. Переписка, шедшая в
 * момент перезапуска, оставалась в статусе «идёт» до истечения
 * CONVERSATION_STALE_MINUTES — 45 минут простоя на каждый рестарт. Процесс,
 * который их вёл, к этому моменту уже мёртв, ждать нечего.
 */

import { requeueStuckConversations } from '@/lib/tgOutreach/warmup/db';

interface Call {
  table: string;
  patch: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

function fakeDb(returned: Array<{ id: number }>) {
  const calls: Call[] = [];
  const db = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const call: Call = { table, patch, filters: [] };
        calls.push(call);
        const chain = {
          eq: (column: string, value: unknown) => {
            call.filters.push([column, value]);
            return chain;
          },
          select: () => Promise.resolve({ data: returned, error: null }),
        };
        return chain;
      },
    }),
  };
  return { db: db as never, calls };
}

describe('requeueStuckConversations', () => {
  it('переводит зависшие «идёт» обратно в очередь и обнуляет старт', async () => {
    const { db, calls } = fakeDb([{ id: 41 }, { id: 42 }]);

    const n = await requeueStuckConversations(db, 'run-1');

    expect(n).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('tg_outreach_warmup_conversations');
    expect(calls[0].patch).toEqual({ status: 'pending', started_at: null });
    // Трогаем только текущий прогон и только записи «идёт»: завершённые и
    // запланированные переписки не наше дело.
    expect(calls[0].filters).toEqual([
      ['run_id', 'run-1'],
      ['status', 'running'],
    ]);
  });

  it('нечего возвращать — ноль, а не ошибка', async () => {
    const { db } = fakeDb([]);
    await expect(requeueStuckConversations(db, 'run-1')).resolves.toBe(0);
  });
});
