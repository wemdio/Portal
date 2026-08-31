/** @jest-environment node */

/**
 * Цифры по каждой базе.
 *
 * Главное требование — сходиться с воронкой и отчётом на тех же данных: три
 * экрана про одних и тех же людей, и расхождение в любой паре отнимает доверие
 * ко всем трём. Поэтому проверяем не «функция что-то вернула», а предикаты:
 * что считается ответом, что лидом, что передачей и по какому ключу диалог
 * связывается с базой.
 */

import { buildBaseStats, type BaseStatsInput, type BaseDialog } from '@/lib/tgOutreach/baseStats';

const TZ = 3;
/** 10.08.2026 00:00 МСК. */
const DAY0 = new Date('2026-08-09T21:00:00.000Z').getTime();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const dialog = (over: Partial<BaseDialog> = {}): BaseDialog => ({
  tg_user_id: 1,
  tg_username: 'someone',
  status: 'none',
  messages: null,
  last_message_at: null,
  can_send_changed_at: null,
  can_send_changed_reason: null,
  ...over,
});

const reply = (at: number) => [
  { role: 'assistant', timestamp: iso(at - HOUR) },
  { role: 'user', timestamp: iso(at) },
];

const base = (over: Partial<BaseStatsInput> = {}): BaseStatsInput => ({
  bases: [{ id: 'b1', name: 'Гипотеза 1' }],
  contacts: [],
  dialogs: [],
  forwards: [],
  fromMs: DAY0,
  toMs: DAY0 + 3 * DAY - 1,
  tzOffsetHours: TZ,
  ...over,
});

describe('buildBaseStats — счётчики', () => {
  it('считает отправки, остаток и аккаунты, которыми рассылали', () => {
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0 + HOUR), account_id: 'acc1' },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0 + DAY), account_id: 'acc2' },
        { base_id: 'b1', username: 'c', created_at: iso(DAY0), sent_at: null },
      ],
    }))[0];

    expect(stats.total).toBe(3);
    expect(stats.sent).toBe(2);
    expect(stats.remaining).toBe(1);
    expect(stats.accountIds.sort()).toEqual(['acc1', 'acc2']);
  });

  it('контакты чужой базы в счёт не идут', () => {
    // Иначе сравнение двух гипотез теряет всякий смысл.
    const stats = buildBaseStats(base({
      bases: [{ id: 'b1', name: 'Первая' }, { id: 'b2', name: 'Вторая' }],
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b2', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b2', username: 'c', created_at: iso(DAY0), sent_at: iso(DAY0) },
      ],
    }));
    expect(stats.find((s) => s.baseId === 'b1')!.sent).toBe(1);
    expect(stats.find((s) => s.baseId === 'b2')!.sent).toBe(2);
  });

  it('связывает диалог с базой по юзернейму, не различая регистр и «@»', () => {
    const stats = buildBaseStats(base({
      contacts: [{ base_id: 'b1', username: 'Ivan', created_at: iso(DAY0), sent_at: iso(DAY0) }],
      dialogs: [dialog({ tg_username: '@ivan', messages: reply(DAY0 + 2 * HOUR) })],
    }))[0];
    expect(stats.replies).toBe(1);
  });

  it('лидом считает статус, а не сам факт ответа', () => {
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0) },
      ],
      dialogs: [
        dialog({ tg_username: 'a', status: 'lead', messages: reply(DAY0 + HOUR), last_message_at: iso(DAY0 + 2 * HOUR) }),
        dialog({ tg_username: 'b', status: 'none', messages: reply(DAY0 + HOUR) }),
      ],
    }))[0];
    expect(stats.replies).toBe(2);
    expect(stats.leads).toBe(1);
  });

  it('передача считается по факту: и автоматом, и руками, и один раз', () => {
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'c', created_at: iso(DAY0), sent_at: iso(DAY0) },
      ],
      dialogs: [
        dialog({ id: 'd1', tg_username: 'a', auto_forwarded_at: iso(DAY0 + HOUR) }),
        dialog({ id: 'd2', tg_username: 'b' }),
        // Ушёл и автоматом, и руками — менеджеру он один.
        dialog({ id: 'd3', tg_username: 'c', auto_forwarded_at: iso(DAY0 + HOUR) }),
      ],
      forwards: [
        { dialog_id: 'd2', status: 'sent', created_at: iso(DAY0 + HOUR) },
        { dialog_id: 'd3', status: 'sent', created_at: iso(DAY0 + 2 * HOUR) },
      ],
    }))[0];
    expect(stats.forwarded).toBe(3);
  });

  it('сорвавшаяся передача не считается: до менеджера лид не дошёл', () => {
    const stats = buildBaseStats(base({
      contacts: [{ base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) }],
      dialogs: [dialog({ id: 'd1', tg_username: 'a' })],
      forwards: [{ dialog_id: 'd1', status: 'failed', created_at: iso(DAY0 + HOUR) }],
    }))[0];
    expect(stats.forwarded).toBe(0);
  });

  it('блокировкой считает только «нас заблокировали», а не любую недоступность', () => {
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0) },
      ],
      dialogs: [
        dialog({ tg_username: 'a', can_send_changed_reason: 'tg_user_blocked_bot', can_send_changed_at: iso(DAY0 + HOUR) }),
        dialog({ tg_username: 'b', can_send_changed_reason: 'tg_user_deactivated', can_send_changed_at: iso(DAY0 + HOUR) }),
      ],
    }))[0];
    expect(stats.blocks).toBe(1);
  });

  it('события вне периода не считаются', () => {
    const stats = buildBaseStats(base({
      contacts: [{ base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0 - DAY) }],
      dialogs: [dialog({ tg_username: 'a', messages: reply(DAY0 - DAY) })],
    }))[0];
    expect(stats.sent).toBe(0);
    expect(stats.replies).toBe(0);
    // Контакт всё равно в базе: «всего» и «осталось» — не про период.
    expect(stats.total).toBe(1);
    expect(stats.remaining).toBe(0);
  });
});

describe('buildBaseStats — конверсии и остаток', () => {
  it('нулевые знаменатели дают прочерк, а не ноль процентов', () => {
    // «0 %» и «мы ещё не отправляли» читаются очень по-разному.
    const stats = buildBaseStats(base())[0];
    expect(stats.replyRate).toBeNull();
    expect(stats.leadRate).toBeNull();
    expect(stats.daysLeft).toBeNull();
  });

  it('конверсии считаются от предыдущего шага', () => {
    const contacts = Array.from({ length: 10 }, (_, i) => ({
      base_id: 'b1', username: `u${i}`, created_at: iso(DAY0), sent_at: iso(DAY0),
    }));
    const stats = buildBaseStats(base({
      contacts,
      dialogs: [
        dialog({ tg_username: 'u0', status: 'lead', messages: reply(DAY0 + HOUR), last_message_at: iso(DAY0 + HOUR) }),
        dialog({ tg_username: 'u1', messages: reply(DAY0 + HOUR) }),
        dialog({ tg_username: 'u2', messages: reply(DAY0 + HOUR) }),
        dialog({ tg_username: 'u3', messages: reply(DAY0 + HOUR) }),
      ],
    }))[0];
    expect(stats.sent).toBe(10);
    expect(stats.replies).toBe(4);
    expect(stats.replyRate).toBe(40);
    // Лидов от ОТВЕТИВШИХ, а не от отправленных: 1 из 4.
    expect(stats.leadRate).toBe(25);
  });

  it('остатка хватит на столько дней, сколько даёт текущий темп', () => {
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0 + DAY) },
        { base_id: 'b1', username: 'c', created_at: iso(DAY0), sent_at: iso(DAY0 + 2 * DAY) },
        { base_id: 'b1', username: 'd', created_at: iso(DAY0), sent_at: null },
        { base_id: 'b1', username: 'e', created_at: iso(DAY0), sent_at: null },
        { base_id: 'b1', username: 'f', created_at: iso(DAY0), sent_at: null },
      ],
    }))[0];
    // 3 отправки за 3 суток = 1/день, осталось 3 → на 3 дня.
    expect(stats.perDay).toBe(1);
    expect(stats.daysLeft).toBe(3);
  });
});

describe('buildBaseStats — лиды поимённо', () => {
  it('список сходится со счётчиком и помечает дошедших до менеджера', () => {
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0) },
        { base_id: 'b1', username: 'c', created_at: iso(DAY0), sent_at: iso(DAY0) },
      ],
      dialogs: [
        dialog({ id: 'd1', tg_username: 'a', tg_user_id: 11, status: 'lead', messages: reply(DAY0 + HOUR), last_message_at: iso(DAY0 + 2 * HOUR) }),
        dialog({ id: 'd2', tg_username: 'b', tg_user_id: 12, status: 'lead', messages: reply(DAY0 + HOUR), last_message_at: iso(DAY0 + DAY) }),
        dialog({ id: 'd3', tg_username: 'c', tg_user_id: 13, status: 'none', messages: reply(DAY0 + HOUR) }),
      ],
      forwards: [{ dialog_id: 'd2', status: 'sent', created_at: iso(DAY0 + DAY) }],
    }))[0];

    expect(stats.leadList).toHaveLength(stats.leads);
    // Свежие сверху.
    expect(stats.leadList.map((l) => l.username)).toEqual(['b', 'a']);
    expect(stats.leadList[0]).toMatchObject({ tgUserId: 12, forwarded: true });
    expect(stats.leadList[1]).toMatchObject({ tgUserId: 11, forwarded: false });
  });

  it('лид вне периода в список не попадает — как и в счётчик', () => {
    const stats = buildBaseStats(base({
      contacts: [{ base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) }],
      dialogs: [
        dialog({ tg_username: 'a', status: 'lead', messages: reply(DAY0 - DAY), last_message_at: iso(DAY0 - HOUR) }),
      ],
    }))[0];
    expect(stats.leads).toBe(0);
    expect(stats.leadList).toEqual([]);
  });
});

describe('buildBaseStats — дни', () => {
  it('сетка суток одинаковая у всех баз: графики сравнивают глазами', () => {
    const stats = buildBaseStats(base({
      bases: [{ id: 'b1', name: 'Первая' }, { id: 'b2', name: 'Вторая' }],
      contacts: [{ base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0) }],
    }));
    expect(stats[0].days).toHaveLength(3);
    expect(stats[1].days).toHaveLength(3);
    expect(stats[0].days.map((d) => d.date)).toEqual(stats[1].days.map((d) => d.date));
  });

  it('дни без событий остаются нулями, а не выпадают из ряда', () => {
    // Без них линия соединила бы понедельник со средой и показала тренд,
    // которого не было.
    const stats = buildBaseStats(base({
      contacts: [
        { base_id: 'b1', username: 'a', created_at: iso(DAY0), sent_at: iso(DAY0 + HOUR) },
        { base_id: 'b1', username: 'b', created_at: iso(DAY0), sent_at: iso(DAY0 + 2 * DAY + HOUR) },
      ],
    }))[0];
    expect(stats.days.map((d) => d.sent)).toEqual([1, 0, 1]);
  });
});
