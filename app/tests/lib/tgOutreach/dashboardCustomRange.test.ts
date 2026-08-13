import { customRange, buildCampaignDashboard } from '@/lib/tgOutreach/dashboard';

/**
 * Произвольный период на сводке кампании.
 *
 * Пресеты («7 дней») режутся по календарным суткам МСК, и руками выбранный
 * период обязан жить по тем же правилам — иначе одна и та же дата давала бы
 * разные цифры в зависимости от того, как её выбрали.
 */
describe('customRange', () => {
  it('нижняя граница — начало суток по МСК', () => {
    const r = customRange('2026-08-01', '2026-08-13');
    expect(new Date(r!.fromMs).toISOString()).toBe('2026-07-31T21:00:00.000Z');
  });

  // Поле подписано «по (включительно)», и верхняя граница обязана быть концом
  // указанных суток: иначе выбор «по 13 августа» терял бы весь день.
  it('верхняя граница — конец суток по МСК, включительно', () => {
    const r = customRange('2026-08-01', '2026-08-13');
    expect(new Date(r!.toMs).toISOString()).toBe('2026-08-13T20:59:59.999Z');
  });

  it('один день — сутки целиком, а не нулевой отрезок', () => {
    const r = customRange('2026-08-13', '2026-08-13');
    expect(r!.toMs - r!.fromMs).toBe(86_400_000 - 1);
  });

  it('конец раньше начала отвергается', () => {
    expect(customRange('2026-08-13', '2026-08-01')).toBeNull();
  });

  it('мусор вместо даты отвергается', () => {
    for (const bad of ['', '13.08.2026', '2026-13-99', 'вчера']) {
      expect(customRange(bad, '2026-08-13')).toBeNull();
      expect(customRange('2026-08-01', bad)).toBeNull();
    }
  });
});

describe('buildCampaignDashboard с произвольным периодом', () => {
  const dialog = (sentAt: string) => ({
    tg_user_id: 1,
    tg_username: 'u',
    status: 'none' as const,
    messages: [],
    last_message_at: null,
    can_send_changed_at: null,
    can_send_changed_reason: null,
    sent_at: sentAt,
  });

  it('range перекрывает пресет period', () => {
    const contacts = [
      { created_at: '2026-08-01T09:00:00.000Z', sent_at: '2026-08-01T09:00:00.000Z' },
      { created_at: '2026-07-01T09:00:00.000Z', sent_at: '2026-07-01T09:00:00.000Z' },
    ];
    const range = customRange('2026-08-01', '2026-08-13')!;
    const res = buildCampaignDashboard({
      contacts,
      dialogs: [dialog('2026-08-01T09:00:00.000Z')].map(({ sent_at: _sent, ...d }) => d),
      forwards: [],
      // period намеренно «1 день»: если бы он победил, июльский контакт и
      // августовский оба выпали бы, и «Отправлено» стало бы нулём.
      period: '1d',
      range,
      now: Date.parse('2026-08-13T12:00:00.000Z'),
    });
    expect(res.funnel.find((s) => s.key === 'delivered')?.value).toBe(1);
    expect(res.from).toBe(new Date(range.fromMs).toISOString());
    expect(res.to).toBe(new Date(range.toMs).toISOString());
  });
});
