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

  /**
   * Регрессия 28.08.2026. Вызовы Telegram в боевом круге и первом касании шли
   * без ограничения по времени, и повисший запрос останавливал кампанию
   * навсегда: цикл стоял внутри `await`, до проверки «просили остановиться» не
   * доходил, а разрыв сокетов снаружи его не будил. Сторожу оставалось уронить
   * весь процесс вместе с четырьмя здоровыми кампаниями.
   */
  it('зависшая отправка не останавливает порцию, а завершается ошибкой', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({
      // Никогда не отвечающий Telegram — ровно то, что делает мобильный прокси,
      // сменивший IP посреди запроса.
      sendMessage: jest.fn(() => new Promise(() => {})),
    });

    const res = await sendFirstTouchBatch({
      ...baseArgs, sendTimeoutMs: 20, db, client,
    } as never);

    // Порция завершилась, а не повисла — это и есть главная проверка.
    expect(res).toMatchObject({ sent: 0 });
  });

  /**
   * Таймаут на отправке — не то же самое, что отказ: сообщение могло уйти, а
   * потеряться могло подтверждение. Повторить — значит написать человеку то же
   * самое второй раз, а для холодного аутрича это выглядит как работа бота.
   */
  it('неподтверждённая отправка не повторяется: задвоить хуже, чем пропустить', async () => {
    const db = fakeDb([contact()]);
    const client = fakeClient({ sendMessage: jest.fn(() => new Promise(() => {})) });

    const res = await sendFirstTouchBatch({
      ...baseArgs, sendTimeoutMs: 20, db, client,
    } as never);

    expect(res.skipped).toBe(1);
    // Попытку контакту не засчитываем и в очередь не возвращаем: он закрыт
    // с честной причиной, по которой видно, что это неизвестность, а не отказ.
    const skip = db.updates.find((u) => u.patch.status === 'skipped');
    expect(skip?.patch.skip_reason).toContain('возможно, доставлено');
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

  it('«No user has X as username» не сжигает — контакт откладывается', async () => {
    // gramJS в _getEntityFromUsername маскирует RPC USERNAME_NOT_OCCUPIED в эту
    // строку (telegram/client/users.js), а на замороженном аккаунте Telegram
    // отдаёт её и на живые ники. Поэтому сжигать здесь нельзя — откладываем.
    const db = fakeDb([contact()]);
    const client = fakeClient({
      getEntity: jest.fn(async () => {
        throw new Error('No user has "ivanov" as username');
      }),
    });

    const res = await sendFirstTouchBatch({ ...baseArgs, db, client } as never);

    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.postponed).toBe(1);
    const patch = db.updates.find((u) => u.patch.attempts === 1)?.patch;
    expect(patch?.attempts).toBe(1);
    expect(patch?.status).toBeUndefined();
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
    const account = { ...baseArgs.account, cooldown_until: null as string | null };
    await sendFirstTouchBatch({ ...baseArgs, account, cooldownHours: 24, db, client } as never);

    const park = db.updates.find((u) => u.table === 'tg_outreach_accounts');
    expect(park?.id).toBe('acc-1');
    const until = new Date(String(park?.patch.cooldown_until)).getTime();
    expect(until - before).toBeGreaterThan(23 * 3600_000);
    expect(until - before).toBeLessThan(25 * 3600_000);
    // Круг кампании не перечитывает аккаунты из БД. Без записи в этот же
    // объект следующий обход снова возьмёт номер — как 998950879438 трижды за день.
    expect(account.cooldown_until).toBe(park?.patch.cooldown_until);
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

  /**
   * Аудит 25.08.2026, кампания TG_VBI, аккаунт 254360278 (Василий); 26.08 — та же
   * картина на TG_Roistat (живые polydamas/savinovadi/spasisohrany и т.д.).
   *
   * gramJS getEntity → contacts.ResolveUsername. Когда аккаунт урезан/frozen,
   * Telegram отвечает USERNAME_NOT_OCCUPIED на ЖИВЫЕ ники — один и тот же код,
   * что и для мёртвого ника. Причём gramJS в _getEntityFromUsername ловит этот
   * RPC-код и маскирует его в строку `No user has "X" as username`, так что до
   * нашего кода сырой код не доезжает. Раньше isUsernameNotFound считал всё это
   * «ника нет» и ставил status=skipped навсегда: сотни контактов сожжено.
   *
   * Дискриминатор — не строка ошибки (она одинакова), а порция целиком: мёртвый
   * ник — явление редкое и одиночное, а замороженный аккаунт отдаёт
   * USERNAME_NOT_OCCUPIED на каждый резолв. Поэтому вся порция «не найдена» =
   * виноват аккаунт, а не база.
   */
  describe('USERNAME_NOT_OCCUPIED / «No user has» — замороженный аккаунт vs мёртвый ник', () => {
    const usernameRpcError = () =>
      Object.assign(
        new Error('400: USERNAME_NOT_OCCUPIED (caused by contacts.ResolveUsername)'),
        { code: 'USERNAME_NOT_OCCUPIED' },
      );
    // gramJS-маска того же RPC — именно в этой форме ошибка реально доезжает до кода.
    const usernameGramjsError = (username = 'x') =>
      new Error(`No user has "${username}" as username`);

    it('весь резолв порции вернул USERNAME_NOT_OCCUPIED — паркуем аккаунт, а не базу', async () => {
      const db = fakeDb([
        contact({ id: 'c-1', username: 'dng68' }),
        contact({ id: 'c-2', username: 'ver1nika20' }),
        contact({ id: 'c-3', username: 'vasaivanov38' }),
      ]);
      const getEntity = jest.fn(async () => {
        throw usernameRpcError();
      });
      const client = fakeClient({ getEntity });
      const account = { ...baseArgs.account, cooldown_until: null as string | null };

      const res = await sendFirstTouchBatch({ ...baseArgs, account, cooldownHours: 24, db, client } as never);

      // Живые ники не сожжены: ни одной записи по контактам, skipped=0.
      expect(res.skipped).toBe(0);
      expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
      // Заморожен аккаунт — он паркуется паузой кампании до следующего круга.
      const park = db.updates.find((u) => u.table === 'tg_outreach_accounts');
      expect(park?.id).toBe('acc-1');
      expect(Boolean(park?.patch.cooldown_until)).toBe(true);
      // Круг кампании не перечитывает аккаунты из БД — пауза обязана жить и в памяти.
      expect(account.cooldown_until).toBe(park?.patch.cooldown_until);
      // Порция остановлена, в Telegram по никам дальше не ходим.
      expect(getEntity).toHaveBeenCalledTimes(3);
    });

    it('вся порция «No user has X as username» (грамJS-маска RPC) — тоже паркуем аккаунт, а не базу', async () => {
      // Это РЕАЛЬНАЯ форма ошибки: gramJS перехватывает USERNAME_NOT_OCCUPIED и
      // бросает строку. Раньше она скипалась как «честный мёртвый ник» — 26.08 на
      // TG_Roistat так сожжены живые polydamas/savinovadi/spasisohrany.
      const db = fakeDb([
        contact({ id: 'c-1', username: 'polydamas' }),
        contact({ id: 'c-2', username: 'savinovadi' }),
        contact({ id: 'c-3', username: 'vstille' }),
      ]);
      const getEntity = jest.fn(async () => {
        throw usernameGramjsError();
      });
      const client = fakeClient({ getEntity });
      const account = { ...baseArgs.account, cooldown_until: null as string | null };

      const res = await sendFirstTouchBatch({ ...baseArgs, account, cooldownHours: 24, db, client } as never);

      expect(res.skipped).toBe(0);
      expect(db.updates.filter((u) => u.table === 'tg_outreach_base_contacts')).toHaveLength(0);
      const park = db.updates.find((u) => u.table === 'tg_outreach_accounts');
      expect(park?.id).toBe('acc-1');
      expect(Boolean(park?.patch.cooldown_until)).toBe(true);
      expect(account.cooldown_until).toBe(park?.patch.cooldown_until);
      expect(getEntity).toHaveBeenCalledTimes(3);
    });

    it('одиночный USERNAME_NOT_OCCUPIED среди живых — контакт откладывается, а не сжигается', async () => {
      const db = fakeDb([
        contact({ id: 'c-1', username: 'dead_nick' }),
        contact({ id: 'c-2', username: 'alive' }),
      ]);
      let first = true;
      const client = fakeClient({
        getEntity: jest.fn(async () => {
          if (first) {
            first = false;
            throw usernameRpcError();
          }
          return { id: 777, username: 'alive' };
        }),
      });
      const account = { ...baseArgs.account, cooldown_until: null as string | null };

      const res = await sendFirstTouchBatch({ ...baseArgs, account, cooldownHours: 24, db, client } as never);

      // Аккаунт не тронут: порция не была «вся не найдена».
      expect(db.updates.filter((u) => u.table === 'tg_outreach_accounts')).toHaveLength(0);
      // Живой контакт отправлен.
      expect(res.sent).toBe(1);
      // Сомнительный ник не сожжён навсегда: контакт отложен с попыткой.
      expect(res.skipped).toBe(0);
      expect(res.postponed).toBe(1);
      const patch = db.updates.find(
        (u) => u.table === 'tg_outreach_base_contacts' && u.patch.attempts === 1,
      )?.patch;
      expect(patch?.attempts).toBe(1);
      expect(patch?.status).toBeUndefined();
    });

    it('одно-единственное «ника нет» в порции из одного (квота 1) — контакт отложен, аккаунт не паркуется', async () => {
      // Квота 1: порция из одного контакта не может быть «вся не найдена» как
      // сигнал о заморозке — это может быть и просто мёртвый ник. Сжигать тоже
      // нельзя (аккаунт мог быть заморожен), поэтому откладываем.
      const db = fakeDb([contact()]);
      const client = fakeClient({ getEntity: jest.fn(async () => { throw usernameRpcError(); }) });
      const account = { ...baseArgs.account, cooldown_until: null as string | null };

      const res = await sendFirstTouchBatch({ ...baseArgs, account, perDay: 1, cooldownHours: 24, db, client } as never);

      expect(res.skipped).toBe(0);
      expect(res.postponed).toBe(1);
      expect(db.updates.filter((u) => u.table === 'tg_outreach_accounts')).toHaveLength(0);
      const patch = db.updates.find((u) => u.table === 'tg_outreach_base_contacts')?.patch;
      expect(patch?.attempts).toBe(1);
    });

    it('USERNAME_INVALID — кривой ник, а не заморозка: скипаем, аккаунт не паркуем', async () => {
      // USERNAME_INVALID = «ник с недопустимыми символами». Это не сигнал
      // замороженного аккаунта: пачка кривых ников не должна ложно уводить
      // исправный номер в паузу. Плюс normalizeUsername уже режет ник до
      // [a-z0-9_]{5,32}, так что на первом касании код практически недостижим.
      const db = fakeDb([
        contact({ id: 'c-1', username: 'bad!!nick' }),
        contact({ id: 'c-2', username: 'bad__nick' }),
      ]);
      const client = fakeClient({
        getEntity: jest.fn(async () => {
          throw Object.assign(
            new Error('400: USERNAME_INVALID (caused by contacts.ResolveUsername)'),
            { code: 'USERNAME_INVALID' },
          );
        }),
      });
      const account = { ...baseArgs.account, cooldown_until: null as string | null };

      const res = await sendFirstTouchBatch({ ...baseArgs, account, cooldownHours: 24, db, client } as never);

      expect(res.skipped).toBe(2);
      expect(res.postponed).toBe(0);
      expect(db.updates.filter((u) => u.table === 'tg_outreach_accounts')).toHaveLength(0);
      const skips = db.updates.filter((u) => u.table === 'tg_outreach_base_contacts' && u.patch.status === 'skipped');
      expect(skips).toHaveLength(2);
    });
  });
});
