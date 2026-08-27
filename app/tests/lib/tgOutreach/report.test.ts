/** @jest-environment node */

/**
 * Отчёт по договору. Цифры отсюда уезжают наружу, клиенту, поэтому проверяем не
 * «функция что-то вернула», а границы: неделя с понедельника, крайние недели
 * обрезаны периодом, конверсия при нуле отправок — прочерк, а не ноль.
 */

import {
  buildCampaignReport,
  weekStart,
  firstReplyAt,
  usernameKey,
  parseSourceChats,
  type ReportInput,
} from '@/lib/tgOutreach/report';

const TZ = 3;

/** Понедельник 03.08.2026 00:00 по Москве = 02.08 21:00 UTC. */
const MON = new Date('2026-08-02T21:00:00.000Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  from: iso(MON),
  to: iso(MON + 14 * DAY),
  tzOffsetHours: TZ,
  dialogs: [],
  contacts: [],
  bases: [],
  ...over,
});

describe('weekStart', () => {
  it('понедельник остаётся понедельником', () => {
    expect(weekStart(MON, TZ)).toBe(MON);
    expect(weekStart(MON + 12 * HOUR, TZ)).toBe(MON);
  });

  it('воскресенье относится к своей неделе, а не к следующей', () => {
    const sundayEvening = MON + 6 * DAY + 20 * HOUR;
    expect(weekStart(sundayEvening, TZ)).toBe(MON);
  });

  it('понедельник в 00:30 по Москве — уже новая неделя', () => {
    const nextMondayNight = MON + 7 * DAY + 30 * 60_000;
    expect(weekStart(nextMondayNight, TZ)).toBe(MON + 7 * DAY);
  });
});

describe('firstReplyAt', () => {
  const dialog = (messages: Array<{ role?: string; timestamp?: string }>) => ({
    tg_user_id: 1, tg_username: 'x', status: 'none', messages,
    last_message_at: null, can_send_changed_at: null, can_send_changed_reason: null,
  });

  it('берёт первое входящее, а не последнее', () => {
    const d = dialog([
      { role: 'assistant', timestamp: iso(MON) },
      { role: 'user', timestamp: iso(MON + HOUR) },
      { role: 'user', timestamp: iso(MON + 5 * HOUR) },
    ]);
    expect(firstReplyAt(d)).toBe(MON + HOUR);
  });

  it('диалог без входящих — ответа не было', () => {
    expect(firstReplyAt(dialog([{ role: 'assistant', timestamp: iso(MON) }]))).toBeNull();
    expect(firstReplyAt(dialog([]))).toBeNull();
  });
});

describe('buildCampaignReport — раздел 1', () => {
  it('режет период на недели с понедельника', () => {
    const r = buildCampaignReport(base());
    expect(r.weeks).toHaveLength(2);
    expect(r.weeks[0].period).toBe('03.08 — 09.08');
    expect(r.weeks[1].period).toBe('10.08 — 16.08');
  });

  it('крайнюю неделю обрезает границей периода', () => {
    // Период стартует в среду: неделя началась в понедельник, но в отчёт
    // попадает только её хвост.
    const r = buildCampaignReport(base({ from: iso(MON + 2 * DAY), to: iso(MON + 7 * DAY) }));
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].period).toBe('05.08 — 09.08');
  });

  it('разносит события по своим неделям', () => {
    const r = buildCampaignReport(base({
      contacts: [
        { base_id: 'b', username: 'a', status: 'sent', created_at: iso(MON), sent_at: iso(MON + HOUR), raw: { 'Ссылка на источник': 'https://t.me/chat_one' } },
        { base_id: 'b', username: 'c', status: 'sent', created_at: iso(MON), sent_at: iso(MON + 8 * DAY), raw: { 'Ссылка на источник': 'https://t.me/chat_two' } },
        { base_id: 'b', username: 'd', status: 'pending', created_at: iso(MON + 8 * DAY), sent_at: null, raw: { 'Ссылка на источник': 'https://t.me/chat_three' } },
      ],
    }));

    expect(r.weeks[0]).toMatchObject({ delivered: 1, chats: 2, contacts: 2 });
    expect(r.weeks[1]).toMatchObject({ delivered: 1, chats: 1, contacts: 1 });
    expect(r.total).toMatchObject({ delivered: 2, chats: 3, contacts: 3 });
  });

  describe('обработанные чаты', () => {
    const contact = (username: string, source: unknown, at = MON) => ({
      base_id: 'b', username, status: 'sent',
      created_at: iso(at), sent_at: iso(at), raw: source === undefined ? null : { 'Ссылка на источник': source },
    });

    it('один чат в разных написаниях считается один раз', () => {
      const r = buildCampaignReport(base({
        contacts: [
          contact('a', 'https://t.me/atol_chat'),
          contact('b', 't.me/atol_chat/'),
          contact('c', '@atol_chat'),
          contact('d', 'ATOL_CHAT'),
        ],
      }));
      expect(r.total.chats).toBe(1);
    });

    it('контакты есть, источник не указан — прочерк, а не ноль', () => {
      const r = buildCampaignReport(base({ contacts: [contact('a', undefined), contact('b', '  ')] }));
      // Ноль читался бы клиентом как «чаты не обрабатывали», хотя их просто не
      // записали в файл выгрузки.
      expect(r.total.chats).toBeNull();
    });

    it('контактов нет вовсе — честный ноль', () => {
      expect(buildCampaignReport(base()).total.chats).toBe(0);
    });

    it('складывает чаты, объявленные у базы, с теми, что пришли в файле', () => {
      const r = buildCampaignReport(base({
        contacts: [contact('a', 'https://t.me/chat_one')],
        bases: [{ id: 'b', name: 'Гипотеза 1', source_chats: 'https://t.me/chat_one\nt.me/chat_two\n@chat_three' }],
      }));
      // chat_one объявлен и у базы, и в файле — это один чат, не два.
      expect(r.total.chats).toBe(3);
    });

    it('чаты базы, в которую за период ничего не грузили, не считаются', () => {
      const r = buildCampaignReport(base({
        contacts: [{ ...contact('a', 'https://t.me/chat_one'), base_id: 'b1' }],
        bases: [
          { id: 'b1', name: 'Работающая', source_chats: 'https://t.me/chat_one' },
          // Гипотеза прошлого месяца: её чаты в этой неделе были бы припиской.
          { id: 'b2', name: 'Прошлая', source_chats: 'https://t.me/old_a\nhttps://t.me/old_b' },
        ],
      }));
      expect(r.total.chats).toBe(1);
    });

    it('чаты базы заполняют «Канал/чат» в разделе офферов', () => {
      const r = buildCampaignReport(base({
        bases: [{ id: 'b', name: 'Гипотеза 1', source_chats: ' https://t.me/a \n\n@b ' }],
      }));
      expect(r.offers[0].channel).toBe('https://t.me/a\n@b');
    });

    it('берёт и «Название источника», и «Источник»', () => {
      const r = buildCampaignReport(base({
        contacts: [
          { base_id: 'b', username: 'a', status: 'sent', created_at: iso(MON), sent_at: iso(MON), raw: { 'Название источника': 'chat_a' } },
          { base_id: 'b', username: 'b', status: 'sent', created_at: iso(MON), sent_at: iso(MON), raw: { 'Источник': 'chat_b' } },
        ],
      }));
      expect(r.total.chats).toBe(2);
    });
  });

  it('считает ответы, лиды и блокировки', () => {
    const r = buildCampaignReport(base({
      dialogs: [
        {
          tg_user_id: 1, tg_username: 'a', status: 'lead',
          messages: [{ role: 'assistant', timestamp: iso(MON) }, { role: 'user', timestamp: iso(MON + HOUR) }],
          last_message_at: iso(MON + 2 * HOUR),
          can_send_changed_at: null, can_send_changed_reason: null,
        },
        {
          tg_user_id: 2, tg_username: 'b', status: 'none',
          messages: [{ role: 'assistant', timestamp: iso(MON) }],
          last_message_at: iso(MON),
          can_send_changed_at: iso(MON + 3 * HOUR), can_send_changed_reason: 'tg_user_blocked_bot',
        },
      ],
      contacts: [
        { base_id: 'b', username: 'a', status: 'sent', created_at: iso(MON), sent_at: iso(MON), raw: null },
        { base_id: 'b', username: 'b', status: 'sent', created_at: iso(MON), sent_at: iso(MON), raw: null },
      ],
    }));

    expect(r.weeks[0]).toMatchObject({
      delivered: 2, anyReplies: 1, targetReplies: 1, blocks: 1, conversion: 50,
    });
  });

  /** Отключение отправки по другой причине блокировкой не считается. */
  it('в блокировки идёт только tg_user_blocked_bot', () => {
    const r = buildCampaignReport(base({
      dialogs: [{
        tg_user_id: 1, tg_username: 'a', status: 'none', messages: [],
        last_message_at: null,
        can_send_changed_at: iso(MON), can_send_changed_reason: 'tg_user_deactivated',
      }],
    }));
    expect(r.total.blocks).toBe(0);
  });

  it('ноль отправленных — прочерк в конверсии, а не ноль процентов', () => {
    const r = buildCampaignReport(base());
    expect(r.total.delivered).toBe(0);
    expect(r.total.conversion).toBeNull();
  });

  it('конверсию округляет до одного знака', () => {
    const contacts = Array.from({ length: 3 }, (_, i) => ({
      base_id: 'b', username: `u${i}`, status: 'sent',
      created_at: iso(MON), sent_at: iso(MON), raw: null,
    }));
    const r = buildCampaignReport(base({
      contacts,
      dialogs: [{
        tg_user_id: 1, tg_username: 'u0', status: 'none',
        messages: [{ role: 'user', timestamp: iso(MON + HOUR) }],
        last_message_at: iso(MON + HOUR), can_send_changed_at: null, can_send_changed_reason: null,
      }],
    }));
    expect(r.total.conversion).toBe(33.3);
  });
});

describe('buildCampaignReport — раздел 2, лиды', () => {
  const input = base({
    dialogs: [{
      tg_user_id: 7, tg_username: '@Ivanov', status: 'lead',
      messages: [{ role: 'user', timestamp: iso(MON + HOUR) }],
      last_message_at: iso(MON + 2 * HOUR),
      can_send_changed_at: null, can_send_changed_reason: null,
    }],
    contacts: [{
      base_id: 'b', username: 'ivanov', status: 'sent',
      created_at: iso(MON), sent_at: iso(MON),
      raw: { 'Ссылка на источник': 'https://t.me/buhrussia' },
    }],
  });

  it('подтягивает чат-источник и дату оффера по юзернейму', () => {
    const [lead] = buildCampaignReport(input).leads;
    expect(lead.sourceChat).toBe('https://t.me/buhrussia');
    expect(lead.nickname).toBe('@ivanov');
    expect(lead.offerSentAt).toBe('03.08.2026');
  });

  it('колонки под ручное заполнение остаются пустыми, а не выдуманными', () => {
    const [lead] = buildCampaignReport(input).leads;
    expect(lead.criterion).toBe('');
    expect(lead.offerNumber).toBe('');
    expect(lead.quality).toBe('');
    expect(lead.handedOverAt).toBe('');
  });

  it('в лиды идут только диалоги со статусом lead и только из периода', () => {
    const r = buildCampaignReport(base({
      dialogs: [
        { tg_user_id: 1, tg_username: 'a', status: 'not_lead', messages: [], last_message_at: iso(MON), can_send_changed_at: null, can_send_changed_reason: null },
        { tg_user_id: 2, tg_username: 'b', status: 'lead', messages: [], last_message_at: iso(MON - 30 * DAY), can_send_changed_at: null, can_send_changed_reason: null },
      ],
    }));
    expect(r.leads).toHaveLength(0);
  });
});

describe('buildCampaignReport — раздел 3, офферы', () => {
  it('на каждую базу строка с цифрами, остальное под руки', () => {
    const r = buildCampaignReport(base({
      bases: [{ id: 'b1', name: 'Гипотеза 1' }],
      contacts: [
        { base_id: 'b1', username: 'a', status: 'sent', created_at: iso(MON), sent_at: iso(MON), raw: null },
        { base_id: 'b1', username: 'b', status: 'sent', created_at: iso(MON), sent_at: iso(MON), raw: null },
      ],
      dialogs: [{
        tg_user_id: 1, tg_username: 'a', status: 'lead',
        messages: [{ role: 'user', timestamp: iso(MON + HOUR) }],
        last_message_at: iso(MON + HOUR), can_send_changed_at: null, can_send_changed_reason: null,
      }],
    }));

    expect(r.offers).toHaveLength(1);
    expect(r.offers[0].offer).toBe('Гипотеза 1');
    expect(r.offers[0].conclusions).toBe('отправлено 2, ответов 1, лидов 1');
    expect(r.offers[0].deadline).toBe('');
  });
});

describe('usernameKey', () => {
  it('сверка не зависит от «@» и регистра', () => {
    expect(usernameKey('@Ivanov')).toBe('ivanov');
    expect(usernameKey(' IVANOV ')).toBe('ivanov');
    expect(usernameKey(null)).toBe('');
  });
});


describe('parseSourceChats', () => {
  it('режет по строкам, запятым и точкам с запятой', () => {
    expect(parseSourceChats('https://t.me/a\nt.me/b, @c; d')).toEqual([
      'https://t.me/a', 't.me/b', '@c', 'd',
    ]);
  });

  it('один и тот же чат в разных написаниях остаётся один', () => {
    // Оператор вставляет ссылки из парсера как есть, и один чат легко попадает
    // в список дважды — «обработано чатов» от этого расти не должно.
    expect(parseSourceChats('https://t.me/atol\n@atol\nATOL/')).toEqual(['https://t.me/atol']);
  });

  it('пусто — пустой список, а не строка из пустоты', () => {
    expect(parseSourceChats('')).toEqual([]);
    expect(parseSourceChats(null)).toEqual([]);
    expect(parseSourceChats('  \n , ; ')).toEqual([]);
  });
});
