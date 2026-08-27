/**
 * Цифры по каждой базе кампании: отправки, отклики, лиды, передачи менеджеру,
 * блокировки и какими аккаунтами база рассылалась.
 *
 * Зачем отдельно от сводки. Сводка складывает все базы в одну кучу, и блок
 * «Остаток базы» отвечал числом «320» на вопрос, который никто не задавал:
 * оператор не понимал, это одна база или пять, какая из них заканчивается и
 * какая гипотеза вообще работает. Сравнивать гипотезы — смысл всей вкладки
 * «Базы», а сравнивать было нечем.
 *
 * Предикаты те же, что у воронки (`dashboard.ts`) и отчёта по договору
 * (`report.ts`): `firstReplyAt` переиспользуется, лид считается по статусу,
 * передача — по факту, а не по способу. Иначе на одном экране «ответов 62», а
 * на другом по тем же людям 58, и доверие теряют оба.
 *
 * Связь диалога с базой — по юзернейму. Прямой ссылки в базе нет: диалог
 * заводится по входящему из Telegram и знает только собеседника. Это
 * ограничение модели, а не выбор: тот же ключ использует и отчёт, когда
 * подтягивает лиду чат-источник.
 */
import { firstReplyAt, usernameKey, type ReportDialog } from './report';

const DAY_MS = 86_400_000;

export interface BaseRef {
  id: string;
  name: string;
}

export interface BaseContact {
  base_id: string;
  username: string;
  created_at: string | null;
  sent_at: string | null;
  account_id?: string | null;
}

export type BaseDialog = ReportDialog & {
  id?: string | null;
  auto_forwarded_at?: string | null;
};

export interface BaseForward {
  dialog_id?: string | null;
  status: string;
  created_at: string | null;
}

export interface BaseDay {
  /** Начало местных суток, ISO. */
  date: string;
  sent: number;
  replies: number;
  leads: number;
  blocks: number;
}

export interface BaseStats {
  baseId: string;
  name: string;
  /** Контактов в базе всего — независимо от периода. */
  total: number;
  /** Не отправляли ни разу. */
  remaining: number;
  /** Отправлено за период. */
  sent: number;
  replies: number;
  leads: number;
  forwarded: number;
  blocks: number;
  /** Ответов на сотню отправленных, один знак. null — отправок не было. */
  replyRate: number | null;
  /** Лидов на сотню ответивших, один знак. null — ответов не было. */
  leadRate: number | null;
  /** Аккаунты, которыми база рассылалась за период. */
  accountIds: string[];
  /** Среднесуточные отправки за период, один знак. */
  perDay: number;
  /**
   * На сколько дней хватит остатка при текущем темпе. null — темп нулевой:
   * «хватит навсегда» было бы враньём.
   */
  daysLeft: number | null;
  days: BaseDay[];
}

export interface BaseStatsInput {
  bases: BaseRef[];
  contacts: BaseContact[];
  dialogs: BaseDialog[];
  forwards: BaseForward[];
  fromMs: number;
  toMs: number;
  tzOffsetHours?: number;
}

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function inRange(at: number | null, fromMs: number, toMs: number): boolean {
  return at !== null && at >= fromMs && at <= toMs;
}

function dayStart(atMs: number, tzOffsetHours: number): number {
  const offset = tzOffsetHours * 3_600_000;
  return Math.floor((atMs + offset) / DAY_MS) * DAY_MS - offset;
}

/** Как в воронке: точки срабатывания триггера в базе нет, берём последнее сообщение. */
function leadAt(dialog: BaseDialog): number | null {
  return ts(dialog.last_message_at) ?? firstReplyAt(dialog);
}

function share(value: number, base: number): number | null {
  if (base <= 0) return null;
  return Math.round((value / base) * 1000) / 10;
}

export function buildBaseStats(input: BaseStatsInput): BaseStats[] {
  const tz = input.tzOffsetHours ?? 3;
  const { fromMs, toMs } = input;

  // Диалог по юзернейму — единственная связь с базой, см. шапку модуля.
  const dialogByUsername = new Map<string, BaseDialog>();
  for (const d of input.dialogs) {
    const key = usernameKey(d.tg_username);
    if (key) dialogByUsername.set(key, d);
  }

  // Живые передачи по диалогам: сорвавшиеся не в счёт — до менеджера такой лид
  // не дошёл. Тот же предикат, что у ступени воронки.
  const forwardedDialogIds = new Set<string>();
  for (const f of input.forwards) {
    if (f.status !== 'pending' && f.status !== 'sent') continue;
    if (!inRange(ts(f.created_at), fromMs, toMs)) continue;
    if (f.dialog_id) forwardedDialogIds.add(f.dialog_id);
  }

  const contactsByBase = new Map<string, BaseContact[]>();
  for (const c of input.contacts) {
    const list = contactsByBase.get(c.base_id);
    if (list) list.push(c);
    else contactsByBase.set(c.base_id, [c]);
  }

  // Сетка суток общая для всех баз: графики двух гипотез сравнивают глазами, и
  // разъехавшиеся оси делают сравнение бессмысленным.
  const firstDay = dayStart(fromMs, tz);
  const lastDay = dayStart(toMs, tz);

  return input.bases.map((base) => {
    const contacts = contactsByBase.get(base.id) ?? [];

    const days = new Map<number, BaseDay>();
    for (let d = firstDay; d <= lastDay; d += DAY_MS) {
      days.set(d, { date: new Date(d).toISOString(), sent: 0, replies: 0, leads: 0, blocks: 0 });
    }
    const bump = (at: number | null, field: keyof Omit<BaseDay, 'date'>) => {
      if (!inRange(at, fromMs, toMs)) return;
      const slot = days.get(dayStart(at as number, tz));
      if (slot) slot[field]++;
    };

    let sent = 0;
    let replies = 0;
    let leads = 0;
    let forwarded = 0;
    let blocks = 0;
    const accountIds = new Set<string>();

    for (const c of contacts) {
      const sentAt = ts(c.sent_at);
      if (inRange(sentAt, fromMs, toMs)) {
        sent++;
        bump(sentAt, 'sent');
        if (c.account_id) accountIds.add(c.account_id);
      }

      const dialog = dialogByUsername.get(usernameKey(c.username));
      if (!dialog) continue;

      const replyAt = firstReplyAt(dialog);
      if (inRange(replyAt, fromMs, toMs)) {
        replies++;
        bump(replyAt, 'replies');
      }

      if (dialog.status === 'lead') {
        const at = leadAt(dialog);
        if (inRange(at, fromMs, toMs)) {
          leads++;
          bump(at, 'leads');
        }
      }

      // Передача — по факту, а не по способу: автопересылка по триггеру и
      // ручная кнопка ведут к одному и тому же — человек у менеджера.
      const autoAt = ts(dialog.auto_forwarded_at);
      const wentAuto = inRange(autoAt, fromMs, toMs);
      const wentManual = Boolean(dialog.id && forwardedDialogIds.has(dialog.id));
      if (wentAuto || wentManual) forwarded++;

      if (dialog.can_send_changed_reason === 'tg_user_blocked_bot') {
        const at = ts(dialog.can_send_changed_at);
        if (inRange(at, fromMs, toMs)) {
          blocks++;
          bump(at, 'blocks');
        }
      }
    }

    const remaining = contacts.filter((c) => !c.sent_at).length;
    // Делим на прошедшие сутки периода, а не на его номинальную длину: у базы,
    // залитой три дня назад, «за 30 дней» занизило бы темп в десять раз.
    const spanDays = Math.max(Math.round((lastDay - firstDay) / DAY_MS) + 1, 1);
    const perDay = Math.round((sent / spanDays) * 10) / 10;

    return {
      baseId: base.id,
      name: base.name,
      total: contacts.length,
      remaining,
      sent,
      replies,
      leads,
      forwarded,
      blocks,
      replyRate: share(replies, sent),
      leadRate: share(leads, replies),
      accountIds: [...accountIds],
      perDay,
      daysLeft: perDay > 0 ? Math.round((remaining / perDay) * 10) / 10 : null,
      days: [...days.values()],
    };
  });
}
