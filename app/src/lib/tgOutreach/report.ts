/**
 * Отчёт по кампании в форме, приложенной к договору оказания услуг.
 *
 * Три раздела: недельная сводка по рассылке, список лидов и план работ по
 * офферам. Отчёт сдаётся по понедельникам, поэтому неделя тут — с понедельника
 * по воскресенье, а не «последние семь дней».
 *
 * Чистая функция над уже выбранными строками: считать её приходится по живым
 * данным клиента, и ошибка в цифре уезжает наружу, в документ по договору.
 * Отсюда же отдельный тип для каждой колонки, которую портал заполнить не может
 * (номер оффера, критерий отбора, качество лида): они остаются пустыми, чтобы
 * их дозаполнили руками, а не выглядели посчитанными.
 *
 * Точность привязки к неделе разная, и это честно вынесено в тип:
 *   - доставлено, блокировки, подобранные контакты — по своей метке времени,
 *     считаются точно;
 *   - любые ответы — по метке первого входящего сообщения в диалоге, точно;
 *   - целевые ответы — по последнему сообщению диалога: момент, когда сработал
 *     триггер, в базе не сохраняется, и это ближайшее к нему время.
 */

export interface ReportDialog {
  tg_user_id: number | null;
  tg_username: string | null;
  status: string;
  messages: Array<{ role?: string; timestamp?: string }> | null;
  last_message_at: string | null;
  can_send_changed_at: string | null;
  can_send_changed_reason: string | null;
}

export interface ReportContact {
  base_id: string;
  username: string;
  status: string;
  created_at: string | null;
  sent_at: string | null;
  raw: Record<string, unknown> | null;
}

export interface ReportParserJob {
  completed_at: string | null;
  links_count: number;
}

export interface ReportBase {
  id: string;
  name: string;
}

export interface ReportInput {
  /** Границы отчётного периода, ISO. */
  from: string;
  to: string;
  /** Часовой пояс, в котором режем недели. Для отчётов по РФ — +3. */
  tzOffsetHours?: number;
  dialogs: ReportDialog[];
  contacts: ReportContact[];
  parserJobs: ReportParserJob[];
  bases: ReportBase[];
}

export interface ReportWeekRow {
  /** «03.08 — 09.08» */
  period: string;
  fromIso: string;
  toIso: string;
  chats: number;
  contacts: number;
  delivered: number;
  anyReplies: number;
  targetReplies: number;
  blocks: number;
  /** Процент с одним знаком. null — делить не на что, в отчёте это прочерк. */
  conversion: number | null;
}

export interface ReportLeadRow {
  sourceChat: string;
  /** Заполняется руками. */
  criterion: '';
  nickname: string;
  offerSentAt: string;
  /** Заполняется руками. */
  offerNumber: '';
  /** Заполняется руками. */
  quality: '';
  /** Заполняется руками. */
  handedOverAt: '';
}

export interface ReportOfferRow {
  /** Заполняется руками. */
  offerNumber: '';
  offer: string;
  /** Заполняется руками. */
  channel: '';
  /** Заполняется руками. */
  language: '';
  /** Заполняется руками. */
  status: '';
  /** Заполняется руками. */
  deadline: '';
  /** Заполняется руками. */
  comment: '';
  conclusions: string;
}

export interface CampaignReport {
  weeks: ReportWeekRow[];
  total: ReportWeekRow;
  leads: ReportLeadRow[];
  offers: ReportOfferRow[];
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Юзернейм как ключ сверки: без «@» и в нижнем регистре. */
export function usernameKey(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * Понедельник недели, в которую попал момент, в заданном поясе.
 *
 * Считаем сдвигом: переводим в «локальные» миллисекунды, отрезаем по дню
 * недели и возвращаем обратно. Возни с Date-методами и переходами на летнее
 * время это не требует — в РФ его нет, а сдвиг фиксирован.
 */
export function weekStart(atMs: number, tzOffsetHours: number): number {
  const offsetMs = tzOffsetHours * 3_600_000;
  const local = atMs + offsetMs;
  const dayIndex = Math.floor(local / DAY_MS);
  // 1970-01-01 — четверг, поэтому +3 приводит к «0 = понедельник».
  const weekday = ((dayIndex + 3) % 7 + 7) % 7;
  const localMonday = (dayIndex - weekday) * DAY_MS;
  return localMonday - offsetMs;
}

function formatRange(fromMs: number, toMs: number, tzOffsetHours: number): string {
  const fmt = (ms: number) => {
    const d = new Date(ms + tzOffsetHours * 3_600_000);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${day}.${month}`;
  };
  // Конец недели показываем последним её днём, а не началом следующей.
  return `${fmt(fromMs)} — ${fmt(toMs - 1)}`;
}

function inRange(at: number | null, fromMs: number, toMs: number): boolean {
  return at !== null && at >= fromMs && at < toMs;
}

/** Момент первого входящего сообщения — то есть «человек ответил». */
export function firstReplyAt(dialog: ReportDialog): number | null {
  for (const m of dialog.messages ?? []) {
    if (m?.role === 'user') {
      const t = ts(m.timestamp);
      if (t !== null) return t;
    }
  }
  return null;
}

/**
 * Целевой ответ привязываем к последнему сообщению диалога: момента, когда
 * сработал триггер, в базе нет. Ошибка тут — дни, не недели, но на границе
 * недели лид может уехать в соседнюю строку.
 */
function leadAt(dialog: ReportDialog): number | null {
  return ts(dialog.last_message_at) ?? firstReplyAt(dialog);
}

function countWindow(input: ReportInput, fromMs: number, toMs: number) {
  const chats = input.parserJobs
    .filter((j) => inRange(ts(j.completed_at), fromMs, toMs))
    .reduce((sum, j) => sum + (Number(j.links_count) || 0), 0);

  const contacts = input.contacts
    .filter((c) => inRange(ts(c.created_at), fromMs, toMs)).length;

  const delivered = input.contacts
    .filter((c) => inRange(ts(c.sent_at), fromMs, toMs)).length;

  const anyReplies = input.dialogs
    .filter((d) => inRange(firstReplyAt(d), fromMs, toMs)).length;

  const targetReplies = input.dialogs
    .filter((d) => d.status === 'lead' && inRange(leadAt(d), fromMs, toMs)).length;

  const blocks = input.dialogs
    .filter((d) => d.can_send_changed_reason === 'tg_user_blocked_bot'
      && inRange(ts(d.can_send_changed_at), fromMs, toMs)).length;

  return {
    chats,
    contacts,
    delivered,
    anyReplies,
    targetReplies,
    blocks,
    // Ноль отправленных — прочерк, а не «0%»: нулевая конверсия и отсутствие
    // рассылки в отчёте по договору читаются очень по-разному.
    conversion: delivered > 0 ? Math.round((anyReplies / delivered) * 1000) / 10 : null,
  };
}

export function buildCampaignReport(input: ReportInput): CampaignReport {
  const tz = input.tzOffsetHours ?? 3;
  const fromMs = ts(input.from) ?? 0;
  const toMs = ts(input.to) ?? fromMs;

  const weeks: ReportWeekRow[] = [];
  for (let cursor = weekStart(fromMs, tz); cursor < toMs; cursor += WEEK_MS) {
    // Крайние недели обрезаем границами периода: отчёт за 3 августа не должен
    // включать субботу 2-го только потому, что неделя началась раньше.
    const winFrom = Math.max(cursor, fromMs);
    const winTo = Math.min(cursor + WEEK_MS, toMs);
    weeks.push({
      period: formatRange(winFrom, winTo, tz),
      fromIso: new Date(winFrom).toISOString(),
      toIso: new Date(winTo).toISOString(),
      ...countWindow(input, winFrom, winTo),
    });
  }

  const total: ReportWeekRow = {
    period: 'Итого',
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    ...countWindow(input, fromMs, toMs),
  };

  // Контакт по юзернейму — так лид узнаёт, из какого чата его взяли и когда
  // ему отправили оффер. Сверяем по юзернейму, а не по tg_user_id: в базе
  // контактов числового id нет до самой отправки.
  const contactByUsername = new Map<string, ReportContact>();
  for (const c of input.contacts) {
    const key = usernameKey(c.username);
    if (key && !contactByUsername.has(key)) contactByUsername.set(key, c);
  }

  const leads: ReportLeadRow[] = input.dialogs
    .filter((d) => d.status === 'lead' && inRange(leadAt(d), fromMs, toMs))
    .sort((a, b) => (leadAt(a) ?? 0) - (leadAt(b) ?? 0))
    .map((d) => {
      const contact = contactByUsername.get(usernameKey(d.tg_username));
      const raw = contact?.raw ?? {};
      const source = String(
        raw['Ссылка на источник'] ?? raw['Название источника'] ?? raw['Источник'] ?? '',
      );
      return {
        sourceChat: source,
        criterion: '' as const,
        nickname: d.tg_username ? `@${usernameKey(d.tg_username)}` : String(d.tg_user_id ?? ''),
        offerSentAt: contact?.sent_at ? formatDate(ts(contact.sent_at)!, tz) : '',
        offerNumber: '' as const,
        quality: '' as const,
        handedOverAt: '' as const,
      };
    });

  // По офферу считаем то, что портал знает точно: сколько ушло, сколько
  // ответили, сколько лидов. Остальные колонки раздела ведутся в таблице
  // плана работ и заполняются руками.
  const dialogByUsername = new Map<string, ReportDialog>();
  for (const d of input.dialogs) {
    const key = usernameKey(d.tg_username);
    if (key) dialogByUsername.set(key, d);
  }

  const offers: ReportOfferRow[] = input.bases.map((base) => {
    const baseContacts = input.contacts.filter((c) => c.base_id === base.id);
    const sent = baseContacts.filter((c) => inRange(ts(c.sent_at), fromMs, toMs)).length;
    let replies = 0;
    let leadCount = 0;
    for (const c of baseContacts) {
      const d = dialogByUsername.get(usernameKey(c.username));
      if (!d) continue;
      if (inRange(firstReplyAt(d), fromMs, toMs)) replies++;
      if (d.status === 'lead' && inRange(leadAt(d), fromMs, toMs)) leadCount++;
    }
    return {
      offerNumber: '' as const,
      offer: base.name,
      channel: '' as const,
      language: '' as const,
      status: '' as const,
      deadline: '' as const,
      comment: '' as const,
      conclusions: `отправлено ${sent}, ответов ${replies}, лидов ${leadCount}`,
    };
  });

  return { weeks, total, leads, offers };
}

/** «03.08.2026» — как в форме отчёта. */
export function formatDate(atMs: number, tzOffsetHours: number): string {
  const d = new Date(atMs + tzOffsetHours * 3_600_000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getUTCFullYear()}`;
}
