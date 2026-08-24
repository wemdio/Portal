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

  /**
   * Реальный случай: база на 300 контактов, тексты 430–461 знак. При зашитом
   * пороге 400 не уходило ни одно сообщение — база вставала целиком. Порог
   * приходит из настроек кампании и обязан доезжать до самой проверки.
   */
  it('порог длины из настроек кампании доезжает до проверки', async () => {
    const long = 'я'.repeat(440);

    const blocked = fakeDb([contact({ message: long })]);
    const blockedClient = fakeClient();
    const noSetting = await sendFirstTouchBatch({ ...baseArgs, db: blocked, client: blockedClient } as never);
    expect(noSetting).toMatchObject({ sent: 0, postponed: 1 });

    const allowed = fakeDb([contact({ message: long })]);
    const allowedClient = fakeClient();
    const raised = await sendFirstTouchBatch({
      ...baseArgs, maxChars: 500, db: allowed, client: allowedClient,
    } as never);

    expect(raised.sent).toBe(1);
    expect((allowedClient as unknown as { sendMessage: jest.Mock }).sendMessage)
      .toHaveBeenCalledWith('@ivanov', { message: long });
  });

  it('в причине отложенного контакта стоит порог кампании, а не дефолтные 400', async () => {
    const db = fakeDb([contact({ message: 'я'.repeat(700) })]);
    const client = fakeClient();

    await sendFirstTouchBatch({ ...baseArgs, maxChars: 600, db, client } as never);

    const postponed = db.updates.find((u) => u.patch.attempts === 1);
    expect(String(postponed?.patch.skip_reason)).toBe('текст длиннее 600 знаков');
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

  /**
   * Выключенная фича не должна стоить вообще ничего. Круг кампании идёт по
   * каждому аккаунту каждые несколько минут, и у всех кампаний, заведённых до
   * первого касания, нормы нет вовсе: один лишний запрос здесь превращается в
   * постоянный поток запросов от кампаний, которым эта фича не нужна.
   */
  it.each([
    ['норма не задана', undefined],
    ['норма ноль', 0],
  ])('%s — в базу тоже не ходим', async (_name, perDay) => {
    const db = fakeDb([contact()]);
    const client = fakeClient();
    const fromSpy = jest.spyOn(db as unknown as { from: () => unknown }, 'from');

    const res = await sendFirstTouchBatch({ ...baseArgs, perDay, db, client } as never);

    expect(res).toEqual({ sent: 0, skipped: 0, postponed: 0 });
    expect(fromSpy).not.toHaveBeenCalled();
  });
});

/**
 * Регресс 18.08.2026: аккаунты били в одних и тех же людей десятками раз.
 *
 * Две независимые причины. Счётчик попыток не доезжал из базы (loadPendingByBase
 * не выбирал колонку attempts), поэтому лимит трёх попыток не наступал никогда:
 * один username собрал 168 заходов, 548 попыток пришлись на 18 человек. И сам
 * PRIVACY_PREMIUM_REQUIRED попыток тратить не должен — это настройка приватности
 * получателя, она не изменится от повторов.
 */
describe('sendFirstTouchBatch — недоступные контакты и ограничения аккаунта', () => {
  const tgError = (code: string) =>
    Object.assign(new Error(`403: ${code} (caused by messages.SendMessage)`), { code });

  it('навсегда пропускает того, кто принимает только Premium — без траты попыток', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        throw tgError('PRIVACY_PREMIUM_REQUIRED');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.skipped).toBe(1);
    expect(res.postponed).toBe(0);
    const patch = db.updates.find((u) => u.table === 'tg_outreach_base_contacts')?.patch;
    expect(patch?.status).toBe('skipped');
    expect(String(patch?.skip_reason)).toContain('Premium');
    // Попытка не засчитана: контакт уходит из очереди сразу, а не через три круга.
    expect(patch?.attempts).toBeUndefined();
  });

  it('не тратит попытку контакта, когда Telegram ограничил наш аккаунт (PEER_FLOOD)', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        throw tgError('PEER_FLOOD');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.postponed).toBe(1);
    expect(res.skipped).toBe(0);
    // Виноват аккаунт, а не лид — контакт остаётся нетронутым в очереди.
    expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
  });

  /**
   * До 24.08 PEER_FLOOD на первом касании только останавливал порцию.
   * Воркер в следующем круге снова брал тот же номер — отсюда три удара
   * в стену за день у 998950879438. Пауза кампании уже существовала,
   * но ставилась только на флуде ответа. Здесь она должна встать тоже.
   */
  it('PEER_FLOOD на первом касании ставит аккаунт на паузу кампании', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        throw tgError('PEER_FLOOD');
      }),
    });

    const before = Date.now();
    await sendFirstTouchBatch({ ...baseArgs, cooldownHours: 24, db, client } as never);

    const park = db.updates.find((u) => u.table === 'tg_outreach_accounts');
    expect(park?.id).toBe('acc-1');
    const until = new Date(String(park?.patch.cooldown_until)).getTime();
    expect(until - before).toBeGreaterThan(23 * 3600_000);
    expect(until - before).toBeLessThan(25 * 3600_000);
  });

  it('PEER_FLOOD на резолве юзернейма тоже ставит паузу аккаунта', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      getEntity: jest.fn(async () => {
        throw tgError('PEER_FLOOD');
      }),
    });

    await sendFirstTouchBatch({ ...baseArgs, cooldownHours: 24, db, client } as never);

    expect(db.updates.some((u) => u.table === 'tg_outreach_accounts' && Boolean(u.patch.cooldown_until))).toBe(true);
  });

  it('обрыв прокси не уводит аккаунт в паузу на сутки', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });

    await sendFirstTouchBatch({ ...baseArgs, cooldownHours: 24, db, client } as never);

    expect(db.updates.filter((u) => u.table === 'tg_outreach_accounts')).toHaveLength(0);
  });

  it('на ограничении аккаунта прекращает порцию, а не идёт по остальным', async () => {
    const db = fakeDb([contact({ id: 'c-1', username: 'first' }), contact({ id: 'c-2', username: 'second' })]);
    const sendMessage = jest.fn(async () => {
      throw tgError('PEER_FLOOD');
    });
    const client = fakeClient({ sendMessage });

    await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    // Один отказ — и хватит: PEER_FLOOD выдают именно за долбёжку по незнакомым.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ловит FLOOD_WAIT по тексту gramJS, а не по коду — кода в message нет', async () => {
    // Ровно та строка, которую строит gramJS: RPCErrorList.js переписывает
    // message на человеческий текст, подстроки FLOOD_WAIT в нём НЕТ. Проверка
    // по коду тут мертва, и без матча по тексту флуд-вейт сжигал бы попытку
    // живому контакту — на проде за 30 дней ни одной строки лога с «FLOOD_WAIT».
    const db = fakeDb([contact({ attempts: 2 })]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        throw new Error('A wait of 42 seconds is required (caused by messages.SendMessage)');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.postponed).toBe(1);
    // Ни одной записи по контакту: попытка не засчитана, в failed он не ушёл.
    expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
  });

  it('забаненный аккаунт останавливает порцию, а не укатывает очередь в failed', async () => {
    // Худший случай при рабочем счётчике: ошибка повторяется на КАЖДОМ контакте,
    // поэтому «просто попытка» означала бы -1 жизнь у всей очереди за круг.
    const db = fakeDb([
      contact({ id: 'c-1', username: 'first', attempts: 2 }),
      contact({ id: 'c-2', username: 'second', attempts: 2 }),
    ]);
    const sendMessage = jest.fn(async () => {
      throw Object.assign(new Error('401: AUTH_KEY_UNREGISTERED (caused by messages.SendMessage)'), {
        code: 'AUTH_KEY_UNREGISTERED',
      });
    });
    const client = fakeClient({ sendMessage });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(res.postponed).toBe(1);
    expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
  });

  it('ограничение аккаунта на резолве юзернейма тоже не тратит попытку', async () => {
    // Классификация раньше висела только на sendMessage, а getEntity — такой же
    // поход в Telegram и падает на тех же ограничениях.
    const db = fakeDb([contact({ attempts: 2 })]);
    const client = fakeClient({
      getEntity: jest.fn(async () => {
        throw Object.assign(new Error('420: PEER_FLOOD (caused by contacts.ResolveUsername)'), {
          code: 'PEER_FLOOD',
        });
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.postponed).toBe(1);
    expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
  });

  it('закрытая личка, обнаруженная на резолве, пропускает контакт навсегда', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      getEntity: jest.fn(async () => {
        throw Object.assign(new Error('403: USER_PRIVACY_RESTRICTED (caused by contacts.ResolveUsername)'), {
          code: 'USER_PRIVACY_RESTRICTED',
        });
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.skipped).toBe(1);
    const patch = db.updates.find((u) => u.table === 'tg_outreach_base_contacts')?.patch;
    expect(patch?.status).toBe('skipped');
    expect(patch?.attempts).toBeUndefined();
  });

  it('обрыв связи не тратит попытку контакта и прекращает порцию', async () => {
    // Аудит 19.08: с починенным счётчиком просадка прокси списывала бы попытку
    // каждому контакту порции, а три просадки увели бы живую базу в failed
    // целиком. 43% кругов и так идут с мёртвым сокетом — это не гипотеза.
    const db = fakeDb([contact({ attempts: 2 }), contact({ id: 'c-2', username: 'second' })]);
    const sendMessage = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const client = fakeClient({ sendMessage });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.postponed).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
  });

  it('обрыв связи пишет в лог про обрыв связи, а не «Telegram ограничил аккаунт»', async () => {
    // Аудит 20.08: транспортная ветка переиспользовала kind='account_limited',
    // а строка лога для него зашита как «Telegram ограничил аккаунт» — оператору
    // уходил диагноз, которому сам код противоречил: умер сокет, а не аккаунт.
    const db = fakeDb([contact()]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        throw new Error('SOCKET HANG UP');
      }),
    });
    const log = jest.fn();

    await sendFirstTouchBatch({ ...baseArgs, db, client, log } as never);

    const line = (log.mock.calls as unknown[][]).map((c) => String(c[1])).join('\n');
    expect(line).toContain('обрыв');
    expect(line).not.toContain('Telegram ограничил аккаунт');
  });

  it('обычный сбой по-прежнему тратит попытку и считает её от значения из базы', async () => {
    const db = fakeDb([contact({ attempts: 2 })]);
    const client = fakeClient({
      sendMessage: jest.fn(async () => {
        // Не транспорт и не ограничение аккаунта — именно такой сбой должен
        // расходовать попытку.
        throw new Error('400: MESSAGE_TOO_LONG (caused by messages.SendMessage)');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.postponed).toBe(1);
    const patch = db.updates.find((u) => u.table === 'tg_outreach_base_contacts')?.patch;
    // Третья попытка — контакт выбывает. Раньше attempts не доезжал и здесь
    // всегда была «1», поэтому статус failed не наступал никогда.
    expect(patch?.attempts).toBe(3);
    expect(patch?.status).toBe('failed');
  });
});
