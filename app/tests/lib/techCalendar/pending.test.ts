/** @jest-environment node */

/**
 * Жёлтый статус ставится в двух местах: при открытии экрана и в прогоне
 * напоминаний. Обе точки зовут одну функцию, поэтому статус не зависит от
 * того, кто пришёл раньше — человек или робот. Тест держит идемпотентность:
 * второй прогон не должен трогать ничего.
 */

import { createMockSupabase } from '../../helpers/mockSupabase';
import { refreshPendingReview } from '@/lib/techCalendar/pending';

const TODAY = '2026-08-13';

function row(over: Record<string, unknown>) {
  return { id: 'x', status: 'active', next_billing_date: '2026-09-01', ...over };
}

describe('refreshPendingReview', () => {
  it('желтит сервисы, до которых семь дней или меньше', async () => {
    const db = createMockSupabase({
      tables: {
        tech_subscriptions: [
          row({ id: 'a', next_billing_date: '2026-08-20' }),
          row({ id: 'b', next_billing_date: '2026-08-21' }),
        ],
      },
    });

    const changed = await refreshPendingReview(db as never, TODAY);

    expect(changed).toBe(1);
    const rows = db.getRows('tech_subscriptions');
    expect(rows.find((r) => r.id === 'a')?.status).toBe('pending_review');
    expect(rows.find((r) => r.id === 'b')?.status).toBe('active');
  });

  it('желтит просроченные', async () => {
    const db = createMockSupabase({
      tables: { tech_subscriptions: [row({ id: 'a', next_billing_date: '2026-08-01' })] },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(1);
    expect(db.getRows('tech_subscriptions')[0].status).toBe('pending_review');
  });

  it('не трогает решённые и отменённые', async () => {
    const db = createMockSupabase({
      tables: {
        tech_subscriptions: [
          row({ id: 'a', status: 'keep', next_billing_date: '2026-08-14' }),
          row({ id: 'b', status: 'cancel', next_billing_date: '2026-08-14' }),
          row({ id: 'c', status: 'pending_review', next_billing_date: '2026-08-14' }),
        ],
      },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(0);
  });

  it('идемпотентна: второй прогон ничего не меняет', async () => {
    const db = createMockSupabase({
      tables: { tech_subscriptions: [row({ id: 'a', next_billing_date: '2026-08-15' })] },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(1);
    expect(await refreshPendingReview(db as never, TODAY)).toBe(0);
  });

  it('без третьего аргумента продолжает работать (обратная совместимость)', async () => {
    const db = createMockSupabase({
      tables: { tech_subscriptions: [row({ id: 'a', next_billing_date: '2026-08-15' })] },
    });

    expect(await refreshPendingReview(db as never, TODAY)).toBe(1);
  });

  it('логирует ошибку select и не падает, а не тихо возвращает 0', async () => {
    const db = createMockSupabase({
      errorTables: { tech_subscriptions: 'db down' },
    });
    const log = jest.fn();

    const changed = await refreshPendingReview(db as never, TODAY, log);

    expect(changed).toBe(0);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('db down'));
  });

  it('логирует ошибку update по конкретной строке и продолжает по остальным', async () => {
    const log = jest.fn();
    // Мок createMockSupabase не умеет ронять отдельный update — раскладываем
    // руками минимальный клиент: select отдаёт две строки-кандидата, update
    // одной из них падает, другой — проходит.
    const fakeDb = {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          lte: () => builder,
          update: () => ({
            eq: (_col: string, id: string) =>
              id === 'bad'
                ? Promise.resolve({ data: null, error: { message: 'update boom' } })
                : Promise.resolve({ data: [{ id }], error: null }),
          }),
          then: (resolve: (v: { data: Array<{ id: string }>; error: null }) => unknown) =>
            resolve({ data: [{ id: 'bad' }, { id: 'ok' }], error: null }),
        };
        return builder;
      },
    };

    const changed = await refreshPendingReview(fakeDb as never, TODAY, log);

    expect(changed).toBe(1);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('update boom'));
  });
});
