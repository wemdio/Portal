import { buildCampaignDashboard, type DashboardDialog } from '@/lib/tgOutreach/dashboard';

/**
 * Четыре сигнала рядом с воронкой: недоступные, ждущие ответа, требующие
 * разбора и средняя скорость ответа. Все — за тот же период, что и воронка.
 */

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const IN = '2026-08-10T09:00:00.000Z';
const OUT_OF_RANGE = '2026-01-01T09:00:00.000Z';

function dlg(over: Partial<DashboardDialog> = {}): DashboardDialog {
  return {
    id: 'd1',
    tg_user_id: 1,
    tg_username: 'u',
    status: 'none',
    messages: [],
    last_message_at: null,
    can_send_changed_at: null,
    can_send_changed_reason: null,
    ...over,
  } as DashboardDialog;
}

const build = (over: {
  dialogs?: DashboardDialog[];
  forwards?: Array<{ status: string; created_at: string | null; dialog_id?: string | null }>;
}) =>
  buildCampaignDashboard({
    contacts: [],
    dialogs: over.dialogs ?? [],
    forwards: over.forwards ?? [],
    period: '30d',
    now: NOW,
  });

describe('недоступные', () => {
  it('считает техническую недоступность, кроме блокировок', () => {
    const res = build({
      dialogs: [
        dlg({ id: 'a', can_send_changed_reason: 'tg_user_deactivated', can_send_changed_at: IN }),
        dlg({ id: 'b', can_send_changed_reason: 'tg_peer_invalid', can_send_changed_at: IN }),
        dlg({ id: 'c', can_send_changed_reason: 'tg_user_banned_in_channel', can_send_changed_at: IN }),
        dlg({ id: 'd', can_send_changed_reason: 'tg_unreachable', can_send_changed_at: IN }),
      ],
    });
    expect(res.unreachable).toBe(4);
  });

  // Блокировки живут в собственной плашке. Считать их и здесь значило бы
  // показать одного человека дважды в соседних цифрах.
  it('блокировки сюда не входят — у них своя плашка', () => {
    const res = build({
      dialogs: [dlg({ can_send_changed_reason: 'tg_user_blocked_bot', can_send_changed_at: IN })],
    });
    expect(res.unreachable).toBe(0);
    expect(res.blocks).toBe(1);
  });

  it('ручное отключение недоступностью не считается', () => {
    for (const reason of ['manual', 'blocklist_add', 'blocklist_remove']) {
      const res = build({ dialogs: [dlg({ can_send_changed_reason: reason, can_send_changed_at: IN })] });
      expect(res.unreachable).toBe(0);
    }
  });

  it('вне периода не считается', () => {
    const res = build({
      dialogs: [dlg({ can_send_changed_reason: 'tg_unreachable', can_send_changed_at: OUT_OF_RANGE })],
    });
    expect(res.unreachable).toBe(0);
  });
});

describe('ждут ответа', () => {
  it('написали в периоде и молчат', () => {
    const res = build({
      dialogs: [dlg({ messages: [{ role: 'assistant', content: 'привет', timestamp: IN }] })],
    });
    expect(res.awaiting).toBe(1);
  });

  it('ответил — уже не ждём', () => {
    const res = build({
      dialogs: [
        dlg({
          messages: [
            { role: 'assistant', content: 'привет', timestamp: IN },
            { role: 'user', content: 'да', timestamp: '2026-08-10T10:00:00.000Z' },
          ],
        }),
      ],
    });
    expect(res.awaiting).toBe(0);
  });

  // Ответ мог прийти уже после конца периода — человек всё равно не «ждёт».
  it('ответ вне периода тоже снимает ожидание', () => {
    const res = build({
      dialogs: [
        dlg({
          messages: [
            { role: 'assistant', content: 'привет', timestamp: IN },
            { role: 'user', content: 'да', timestamp: '2027-01-01T10:00:00.000Z' },
          ],
        }),
      ],
    });
    expect(res.awaiting).toBe(0);
  });

  it('написали вне периода — не считается', () => {
    const res = build({
      dialogs: [dlg({ messages: [{ role: 'assistant', content: 'привет', timestamp: OUT_OF_RANGE }] })],
    });
    expect(res.awaiting).toBe(0);
  });
});

describe('требуют внимания', () => {
  const answered = (over: Partial<DashboardDialog> = {}) =>
    dlg({
      messages: [
        { role: 'assistant', content: 'привет', timestamp: '2026-08-10T08:00:00.000Z' },
        { role: 'user', content: 'да', timestamp: IN },
      ],
      ...over,
    });

  it('ответили, но статус не проставлен и менеджеру не передали', () => {
    expect(build({ dialogs: [answered()] }).needsAttention).toBe(1);
  });

  it('размеченный диалог внимания не требует', () => {
    for (const status of ['lead', 'not_lead', 'later'] as const) {
      expect(build({ dialogs: [answered({ status })] }).needsAttention).toBe(0);
    }
  });

  // Переданный менеджеру уже разобран, даже если статус так и не проставили —
  // ровно тот случай, из-за которого «Целевые» расходятся с «Переданы».
  it('переданный менеджеру внимания не требует', () => {
    const res = build({
      dialogs: [answered({ id: 'x' })],
      forwards: [{ status: 'sent', created_at: IN, dialog_id: 'x' }],
    });
    expect(res.needsAttention).toBe(0);
  });

  it('сорвавшаяся передача внимание не снимает — до менеджера не дошло', () => {
    const res = build({
      dialogs: [answered({ id: 'x' })],
      forwards: [{ status: 'failed', created_at: IN, dialog_id: 'x' }],
    });
    expect(res.needsAttention).toBe(1);
  });
});

describe('среднее время до ответа', () => {
  it('считает от нашего последнего сообщения до ответа', () => {
    const res = build({
      dialogs: [
        dlg({
          messages: [
            { role: 'assistant', content: 'привет', timestamp: '2026-08-10T09:00:00.000Z' },
            { role: 'user', content: 'да', timestamp: '2026-08-10T11:00:00.000Z' },
          ],
        }),
      ],
    });
    expect(res.avgReplyMinutes).toBe(120);
  });

  it('усредняет по всем ответившим в периоде', () => {
    const res = build({
      dialogs: [
        dlg({
          id: 'a',
          messages: [
            { role: 'assistant', content: 'п', timestamp: '2026-08-10T09:00:00.000Z' },
            { role: 'user', content: 'д', timestamp: '2026-08-10T10:00:00.000Z' },
          ],
        }),
        dlg({
          id: 'b',
          messages: [
            { role: 'assistant', content: 'п', timestamp: '2026-08-10T09:00:00.000Z' },
            { role: 'user', content: 'д', timestamp: '2026-08-10T12:00:00.000Z' },
          ],
        }),
      ],
    });
    expect(res.avgReplyMinutes).toBe(120);
  });

  // Прочерк, а не ноль: «никто не ответил» и «отвечают мгновенно» — разное.
  it('без ответов — null, а не ноль', () => {
    expect(build({ dialogs: [dlg()] }).avgReplyMinutes).toBeNull();
  });

  it('ответ без нашего сообщения до него в среднее не идёт', () => {
    const res = build({
      dialogs: [dlg({ messages: [{ role: 'user', content: 'сам написал', timestamp: IN }] })],
    });
    expect(res.avgReplyMinutes).toBeNull();
  });
});
