/** @jest-environment node */

/**
 * Сводка по кампании: воронка, ряды графика, темп, остаток базы.
 *
 * Главный тест здесь — последний: цифры дашборда обязаны совпадать с отчётом
 * по договору на одних и тех же данных. Два экрана, расходящиеся в числах про
 * одно и то же, отнимают доверие к обоим, и поймать такое расхождение должен
 * тест, а не оператор.
 */

import {
  buildCampaignDashboard,
  dayStart,
  periodRange,
  type DashboardContact,
  type DashboardDialog,
  type DashboardForward,
} from '@/lib/tgOutreach/dashboard';
import { buildCampaignReport } from '@/lib/tgOutreach/report';

/** Момент по московскому времени (+3), в котором режутся сутки. */
const at = (iso: string) => new Date(iso).getTime();

const contact = (createdAt: string | null, sentAt: string | null): DashboardContact => ({
  created_at: createdAt,
  sent_at: sentAt,
});

const dialog = (over: Partial<DashboardDialog> = {}): DashboardDialog => ({
  tg_user_id: 1,
  tg_username: 'someone',
  status: 'none',
  messages: null,
  last_message_at: null,
  can_send_changed_at: null,
  can_send_changed_reason: null,
  ...over,
});

const reply = (iso: string) => [{ role: 'assistant', timestamp: iso }, { role: 'user', timestamp: iso }];

describe('границы периода', () => {
  it('«1 день» — это сегодняшние сутки по +3, а не последние 24 часа', () => {
    // 02:00 по Москве 10 августа: сутки начались два часа назад, а не вчера.
    const now = at('2026-08-10T02:00:00+03:00');
    const { fromMs } = periodRange('1d', now);
    expect(new Date(fromMs).toISOString()).toBe(new Date(at('2026-08-10T00:00:00+03:00')).toISOString());
  });

  it('«7 дней» — семь календарных суток, считая сегодняшние', () => {
    const now = at('2026-08-10T15:00:00+03:00');
    const { fromMs } = periodRange('7d', now);
    expect(new Date(fromMs).toISOString()).toBe(new Date(at('2026-08-04T00:00:00+03:00')).toISOString());
  });

  it('«всё время» начинается с нуля эпохи', () => {
    expect(periodRange('all', at('2026-08-10T15:00:00+03:00')).fromMs).toBe(0);
  });

  it('сутки режутся по +3, а не по UTC', () => {
    // 23:30 UTC 9 августа — это уже 02:30 10 августа по Москве.
    expect(dayStart(at('2026-08-09T23:30:00Z'), 3)).toBe(at('2026-08-10T00:00:00+03:00'));
  });
});

describe('воронка', () => {
  const now = at('2026-08-10T20:00:00+03:00');

  it('пустая кампания даёт нули и прочерки, а не деление на ноль', () => {
    const d = buildCampaignDashboard({
      contacts: [], dialogs: [], forwards: [], period: 'all', now,
    });
    expect(d.funnel.map((s) => s.value)).toEqual([0, 0, 0, 0, 0]);
    // Первый шаг делить не на что по определению, остальные — из-за нуля выше.
    expect(d.funnel.map((s) => s.fromPrev)).toEqual([null, null, null, null, null]);
  });

  it('конверсия считается от предыдущего шага, а не от первого', () => {
    const d = buildCampaignDashboard({
      contacts: [
        contact('2026-08-10T09:00:00+03:00', '2026-08-10T10:00:00+03:00'),
        contact('2026-08-10T09:00:00+03:00', '2026-08-10T10:00:00+03:00'),
        contact('2026-08-10T09:00:00+03:00', null),
        contact('2026-08-10T09:00:00+03:00', null),
      ],
      dialogs: [dialog({ messages: reply('2026-08-10T11:00:00+03:00') })],
      forwards: [],
      period: '1d',
      now,
    });
    const byKey = Object.fromEntries(d.funnel.map((s) => [s.key, s]));
    expect(byKey.contacts.value).toBe(4);
    expect(byKey.delivered.value).toBe(2);
    expect(byKey.replies.value).toBe(1);
    // 2 из 4 = 50 %, 1 из 2 = 50 %. Если бы считали от первого шага, вышло бы 25 %.
    expect(byKey.delivered.fromPrev).toBe(50);
    expect(byKey.replies.fromPrev).toBe(50);
  });

  it('сорвавшаяся передача в воронку не идёт: до менеджера лид не дошёл', () => {
    const forwards: DashboardForward[] = [
      { status: 'sent', created_at: '2026-08-10T12:00:00+03:00' },
      { status: 'pending', created_at: '2026-08-10T12:00:00+03:00' },
      { status: 'failed', created_at: '2026-08-10T12:00:00+03:00' },
    ];
    const d = buildCampaignDashboard({ contacts: [], dialogs: [], forwards, period: '1d', now });
    expect(d.funnel.find((s) => s.key === 'forwarded')!.value).toBe(2);
  });

  it('блокировки стоят отдельно от воронки, а не ступенью в ней', () => {
    const d = buildCampaignDashboard({
      contacts: [],
      dialogs: [dialog({
        can_send_changed_reason: 'tg_user_blocked_bot',
        can_send_changed_at: '2026-08-10T12:00:00+03:00',
      })],
      forwards: [], period: '1d', now,
    });
    expect(d.blocks).toBe(1);
    expect(d.funnel.map((s) => s.key)).not.toContain('blocks');
  });

  it('события вне периода не считаются', () => {
    const d = buildCampaignDashboard({
      contacts: [contact('2026-07-01T10:00:00+03:00', '2026-07-01T10:00:00+03:00')],
      dialogs: [], forwards: [], period: '1d', now,
    });
    expect(d.funnel.find((s) => s.key === 'delivered')!.value).toBe(0);
  });
});

describe('ряды графика', () => {
  const now = at('2026-08-10T20:00:00+03:00');

  /**
   * Без пустых дней линия соединит вторник с четвергом и покажет тренд,
   * которого не было.
   */
  it('дни без событий присутствуют нулями', () => {
    const d = buildCampaignDashboard({
      contacts: [
        contact('2026-08-04T10:00:00+03:00', '2026-08-04T10:00:00+03:00'),
        contact('2026-08-10T10:00:00+03:00', '2026-08-10T10:00:00+03:00'),
      ],
      dialogs: [], forwards: [], period: '7d', now,
    });
    expect(d.days).toHaveLength(7);
    expect(d.days.map((x) => x.delivered)).toEqual([1, 0, 0, 0, 0, 0, 1]);
  });

  it('«всё время» начинает график с первого события, а не с 1970 года', () => {
    const d = buildCampaignDashboard({
      contacts: [contact('2026-08-08T10:00:00+03:00', '2026-08-08T10:00:00+03:00')],
      dialogs: [], forwards: [], period: 'all', now,
    });
    expect(d.days).toHaveLength(3);
    expect(d.days[0].date).toBe(new Date(at('2026-08-08T00:00:00+03:00')).toISOString());
  });
});

describe('темп и остаток базы', () => {
  const now = at('2026-08-10T20:00:00+03:00');

  it('сегодня и вчера считаются по местным суткам', () => {
    const d = buildCampaignDashboard({
      contacts: [
        contact(null, '2026-08-10T01:00:00+03:00'),
        contact(null, '2026-08-09T23:00:00+03:00'),
        contact(null, '2026-08-09T10:00:00+03:00'),
      ],
      dialogs: [], forwards: [], period: '7d', now,
    });
    expect(d.pace.sentToday).toBe(1);
    expect(d.pace.sentYesterday).toBe(2);
  });

  /** «Хватит навсегда» — враньё, поэтому при нулевом темпе честный прочерк. */
  it('при нулевом темпе остаток базы не обещает бесконечность', () => {
    const d = buildCampaignDashboard({
      contacts: [contact('2026-08-01T10:00:00+03:00', null)],
      dialogs: [], forwards: [], period: '7d', now,
    });
    expect(d.base.remaining).toBe(1);
    expect(d.base.daysLeft).toBeNull();
  });

  it('остаток делится на среднесуточный темп', () => {
    const d = buildCampaignDashboard({
      contacts: [
        contact(null, '2026-08-10T10:00:00+03:00'),
        contact(null, '2026-08-09T10:00:00+03:00'),
        contact(null, null), contact(null, null), contact(null, null), contact(null, null),
      ],
      dialogs: [], forwards: [], period: '7d', now,
    });
    // 2 отправки за 7 суток окна = 0.3 в день; 4 контакта хватит примерно на 13 дней.
    expect(d.pace.perDay).toBe(0.3);
    expect(d.base.remaining).toBe(4);
    expect(d.base.daysLeft).toBeCloseTo(13.3, 1);
  });
});

/**
 * Сверка с отчётом по договору — то, ради чего дашборд не считает воронку
 * заново. Берём неделю с понедельника по воскресенье: у отчёта недели
 * понедельничные, а «7 дней» дашборда, отсчитанные от воскресенья, дают ровно
 * тот же отрезок.
 */
describe('цифры сходятся с отчётом по договору', () => {
  const now = at('2026-08-09T23:59:00+03:00'); // воскресенье
  const from = '2026-08-03T00:00:00+03:00'; // понедельник
  const to = '2026-08-10T00:00:00+03:00';

  const contacts = [
    contact('2026-08-03T09:00:00+03:00', '2026-08-03T10:00:00+03:00'),
    contact('2026-08-04T09:00:00+03:00', '2026-08-05T10:00:00+03:00'),
    contact('2026-08-06T09:00:00+03:00', null),
  ];
  const dialogs: DashboardDialog[] = [
    dialog({ messages: reply('2026-08-04T12:00:00+03:00') }),
    dialog({
      status: 'lead',
      messages: reply('2026-08-05T12:00:00+03:00'),
      last_message_at: '2026-08-05T13:00:00+03:00',
    }),
    dialog({
      can_send_changed_reason: 'tg_user_blocked_bot',
      can_send_changed_at: '2026-08-06T12:00:00+03:00',
    }),
  ];

  it('отправлено, ответы, целевые и блокировки совпадают', () => {
    const dash = buildCampaignDashboard({ contacts, dialogs, forwards: [], period: '7d', now });
    const report = buildCampaignReport({
      from, to, tzOffsetHours: 3,
      dialogs, contacts: contacts.map((c) => ({
        base_id: 'b1', username: 'u', status: 'sent', created_at: c.created_at, sent_at: c.sent_at, raw: null,
      })),
      parserJobs: [], bases: [{ id: 'b1', name: 'база' }],
    });

    const byKey = Object.fromEntries(dash.funnel.map((s) => [s.key, s.value]));
    expect(byKey.contacts).toBe(report.total.contacts);
    expect(byKey.delivered).toBe(report.total.delivered);
    expect(byKey.replies).toBe(report.total.anyReplies);
    expect(byKey.leads).toBe(report.total.targetReplies);
    expect(dash.blocks).toBe(report.total.blocks);
  });
});
