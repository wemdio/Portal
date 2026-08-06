/** @jest-environment node */

/**
 * Проверяем решения, а не Telegram: кого пропустили и почему, кому отправили,
 * что записали. Клиент и БД — подставные.
 */

import { sendFirstTouchBatch } from '@/lib/tgOutreach/firstTouch/send';

type Row = Record<string, unknown>;

/** Минимальный поддельный Supabase: помнит апдейты и отдаёт заготовленные выборки. */
function fakeDb(pending: Row[], processed: number[] = []) {
  const updates: Array<{ table: string; patch: Row; id: unknown }> = [];
  const inserts: Array<{ table: string; row: Row }> = [];

  const api = {
    updates,
    inserts,
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        in: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: null }),
        limit: async () => ({
          data:
            table === 'tg_outreach_base_contacts'
              ? pending
              : table === 'tg_outreach_campaign_bases'
                ? [{ base_id: 'base-1' }]
                : [],
        }),
        update: (patch: Row) => ({
          eq: async (_col: string, id: unknown) => {
            updates.push({ table, patch, id });
            return { error: null };
          },
        }),
        upsert: async (row: Row) => {
          inserts.push({ table, row });
          return { error: null };
        },
        insert: async (row: Row) => {
          inserts.push({ table, row });
          return { error: null };
        },
      };
      if (table === 'tg_outreach_processed') {
        chain.maybeSingle = async () => ({
          data: processed.length ? { tg_user_id: processed[0] } : null,
        });
      }
      return chain;
    },
  };
  return api as unknown as Parameters<typeof sendFirstTouchBatch>[0]['db'] & typeof api;
}

const contact = (over: Partial<Row> = {}): Row => ({
  id: 'c-1',
  base_id: 'base-1',
  username: 'ivanov',
  message: 'Иван, добрый день! Вопрос по outreach.',
  attempts: 0,
  ...over,
});

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    getEntity: jest.fn(async () => ({ id: 777, username: 'ivanov' })),
    sendMessage: jest.fn(async () => ({ id: 1 })),
    ...over,
  } as never;
}

const baseArgs = {
  campaignId: 'camp-1',
  account: { id: 'acc-1', session_name: 'Makepao', campaign_id: 'camp-1' },
  perDay: 5,
  log: () => {},
};

describe('sendFirstTouchBatch', () => {
  it('отправляет и помечает контакт отправленным', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient();

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(1);
    expect((client as unknown as { sendMessage: jest.Mock }).sendMessage).toHaveBeenCalledTimes(1);
    const sentUpdate = db.updates.find((u) => u.patch.status === 'sent');
    expect(sentUpdate).toBeDefined();
    expect(sentUpdate?.patch).toMatchObject({ account_id: 'acc-1', tg_user_id: 777 });
  });

  it('битый текст не отправляется, контакт откладывается', async () => {
    const db = fakeDb([contact({ message: 'я'.repeat(500) })]);
    const client = fakeClient();

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(0);
    expect((client as unknown as { sendMessage: jest.Mock }).sendMessage).not.toHaveBeenCalled();
    expect(db.updates.some((u) => u.patch.attempts === 1)).toBe(true);
  });

  it('юзернейм не найден — пропуск с причиной, без повторов', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      getEntity: jest.fn(async () => {
        throw new Error('No user has "ivanov" as username');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(0);
    const skipped = db.updates.find((u) => u.patch.status === 'skipped');
    expect(skipped).toBeDefined();
    expect(String(skipped?.patch.skip_reason)).toContain('не найден');
  });

  it('дневная норма ноль — в Telegram не ходим вообще', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient();

    const res = await sendFirstTouchBatch({ ...baseArgs, perDay: 0, db, client } as never);

    expect(res.sent).toBe(0);
    expect((client as unknown as { getEntity: jest.Mock }).getEntity).not.toHaveBeenCalled();
  });
});
