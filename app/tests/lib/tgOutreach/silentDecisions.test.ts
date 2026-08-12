/** @jest-environment node */

/**
 * Решения воркера, о которых он раньше молчал.
 *
 * Оба случая пойманы на живых логах 12.08.2026. В сводке круга стояло
 * «отложено 1», а причины не было нигде: ветка резолва писала её в skip_reason
 * контакта и не логировала, а показать skip_reason на экране негде. И вторая:
 * аккаунт не подключился, автосвап прокси не сделан — потому что до порога в
 * три ошибки подряд ещё далеко, — и после строки об ошибке в логе тишина,
 * читающаяся как «дальше разберётся само».
 *
 * Тишина в обоих местах стоила часов на выяснение того, что код знал сразу.
 */

import { sendFirstTouchBatch } from '@/lib/tgOutreach/firstTouch/send';
import { handleProxyError } from '@/lib/tgOutreach/proxyHealth';
import { CONSECUTIVE_ERROR_THRESHOLD } from '@/lib/tgOutreach/proxyHealth';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';

type Row = Record<string, unknown>;

/** Минимальный поддельный Supabase для порции первых касаний. */
function fakeDb(pending: Row[]) {
  const updates: Array<{ table: string; patch: Row }> = [];
  const api = {
    updates,
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
          eq: async () => {
            updates.push({ table, patch });
            return { error: null };
          },
        }),
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
      };
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

const baseArgs = {
  campaignId: 'camp-1',
  account: { id: 'acc-1', session_name: 'Makepao', campaign_id: 'camp-1' },
  perDay: 5,
};

function clientFailingResolve(message: string) {
  return {
    getEntity: jest.fn(async () => { throw new Error(message); }),
    sendMessage: jest.fn(async () => ({ id: 1 })),
  } as never;
}

describe('первое касание: причина отложенного контакта попадает в лог', () => {
  it('сбой резолва не «username not found» больше не молчит', async () => {
    const log = jest.fn();
    const db = fakeDb([contact()]);

    const res = await sendFirstTouchBatch({
      ...baseArgs, db, client: clientFailingResolve('TIMEOUT'), log,
    } as never);

    expect(res.postponed).toBe(1);
    const warnings = log.mock.calls.filter((c) => c[0] === 'warning').map((c) => String(c[1]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('@ivanov');
    expect(warnings[0]).toContain('не смог найти собеседника');
    expect(warnings[0]).toContain('TIMEOUT');
  });

  it('в логе видно, какая это попытка', async () => {
    const log = jest.fn();
    const db = fakeDb([contact({ attempts: 0 })]);

    await sendFirstTouchBatch({ ...baseArgs, db, client: clientFailingResolve('TIMEOUT'), log } as never);

    expect(String(log.mock.calls.find((c) => c[0] === 'warning')?.[1])).toContain('попытка 1 из 3');
  });

  /**
   * Третья неудача — не «отложен до следующего круга», а конец: контакт уходит
   * в failed и из очереди пропадает. Лог обязан называть это своим именем.
   */
  it('на последней попытке лог говорит, что контакт больше не берут', async () => {
    const log = jest.fn();
    const db = fakeDb([contact({ attempts: 2 })]);

    await sendFirstTouchBatch({ ...baseArgs, db, client: clientFailingResolve('TIMEOUT'), log } as never);

    const warning = String(log.mock.calls.find((c) => c[0] === 'warning')?.[1]);
    expect(warning).toContain('попытка 3 из 3');
    expect(warning).toContain('больше пробовать не буду');
    expect(db.updates.some((u) => u.patch.status === 'failed')).toBe(true);
  });

  it('слишком длинный текст тоже отчитывается попыткой', async () => {
    const log = jest.fn();
    const db = fakeDb([contact({ message: 'я'.repeat(700) })]);

    await sendFirstTouchBatch({
      ...baseArgs, maxChars: 400, db, client: clientFailingResolve('unused'), log,
    } as never);

    const warning = String(log.mock.calls.find((c) => c[0] === 'warning')?.[1]);
    expect(warning).toContain('текст длиннее 400 знаков');
    expect(warning).toContain('попытка 1 из 3');
  });
});

describe('прокси: отказ от свапа до порога больше не молчит', () => {
  const account = {
    id: 'acc-1',
    session_name: 'Makepao',
    campaign_id: 'camp-1',
    proxy_id: 'proxy-1',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  function seed(consecutiveErrors: number) {
    return createMockSupabase({
      tables: {
        tg_outreach_proxies: [{
          id: 'proxy-1', campaign_id: 'camp-1', url: 'http://1.2.3.4:1080',
          is_active: true, consecutive_errors: consecutiveErrors, total_errors: consecutiveErrors,
          cooldown_until: null,
        }],
        tg_outreach_accounts: [{
          id: 'acc-1', consecutive_proxy_failures: 0, last_failed_proxy_id: null,
        }],
      },
    });
  }

  it('первая ошибка: в логе видно счёт и что свапа не будет', async () => {
    const log = jest.fn();
    const db = seed(0);

    const res = await handleProxyError({
      db: db as never, account: account as never, reason: 'connect_timeout', log,
    });

    expect(res.swappedTo).toBeNull();
    const line = log.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(line).toContain(`ошибка 1 из ${CONSECUTIVE_ERROR_THRESHOLD}`);
    expect(line).toContain('свап пока не делаю');
  });

  it('на пороге сообщение меняется на cooldown, а не дублирует «жду»', async () => {
    const log = jest.fn();
    const db = seed(CONSECUTIVE_ERROR_THRESHOLD - 1);

    await handleProxyError({
      db: db as never, account: account as never, reason: 'connect_timeout', log,
    });

    const line = log.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(line).toContain('ставлю cooldown');
    expect(line).not.toContain('свап пока не делаю');
  });
});
