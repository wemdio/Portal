/**
 * Отчёт по кампании в форме, приложенной к договору оказания услуг.
 *
 * Три раздела: сводка по рассылке с разбивкой по неделям, список лидов и план
 * работ по офферам.
 *
 * Неделя — семь суток от выбранной даты начала (22.10.2026). Раньше неделя была
 * календарной, и отчёт «с 15 по 21» резался на две строки по понедельнику; по
 * договору нужен другой счёт: выбрал период — получил строки по семь дней,
 * последняя короче, а период до недели — одной строкой «от и до».
 *
 * Чистая функция над уже выбранными строками: считать её приходится по живым
 * данным клиента, и ошибка в цифре уезжает наружу, в документ по договору.
 *
 * Как считается каждая колонка (всё по своей метке времени внутри строки):
 *   - обработано чатов и подобрано контактов — по гипотезам (базам): база
 *     относится к той неделе периода, где по ней ушло первое сообщение, а если
 *     в периоде по ней ничего не ушло — к неделе загрузки. Так одна база не
 *     попадает в две строки, и «Итого» равно сумме недель;
 *   - доставлено — контакты, которым сообщение действительно ушло (sent_at),
 *     отложенные и сорвавшиеся не в счёт;
 *   - любые ответы — первый ответ человека на наше первое касание; люди,
 *     написавшие сами, а не в ответ на рассылку, сюда не попадают;
 *   - целевые ответы — переданные клиенту лиды, по дате передачи;
 *   - конверсия — любые ответы к доставленным.
 */

export interface ReportDialog {
  id?: string | null;
  tg_user_id: number | null;
  tg_username: string | null;
  status: string;
  /**
   * `content` отчётам не нужен — считают они по ролям и времени. Но в базе он
   * есть, и тесты собирают фикстуры такими же, как реальная строка; без поля в
   * типе литерал с текстом сообщения не компилируется.
   */
  messages: Array<{ role?: string; content?: string; timestamp?: string }> | null;
  last_message_at: string | null;
  can_send_changed_at?: string | null;
  can_send_changed_reason?: string | null;
  /** Автопересылка по триггеру — один из способов передать лида. */
  auto_forwarded_at?: string | null;
  /** Метка «лид» (ИИ или сотрудник) — передача, когда чата пересылки нет. */
  lead_marked_at?: string | null;
}

/** Ручная передача карточки лида (кнопка «Передать лида»). */
export interface ReportForward {
  dialog_id: string | null;
  status: string;
  requested_at: string | null;
  sent_at: string | null;
}

export interface ReportContact {
  base_id: string;
  username: string;
  status: string;
  created_at: string | null;
  sent_at: string | null;
  raw: Record<string, unknown> | null;
}

export interface ReportBase {
  id: string;
  name: string;
  /**
   * Чаты, из которых собрана эта гипотеза, — как их ввёл оператор: по одной
   * ссылке в строке. Именно отсюда берутся «обработанные чаты» и «Канал/чат»:
   * в файле базы источника нет, а вводить его на каждую из трёхсот строк ради
   * трёх-четырёх чатов никто не станет.
   */
  source_chats?: string | null;
}

/** Ссылки из поля базы: по одной в строке, пустые и повторы убираем. */
export function parseSourceChats(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (value ?? '').split(/[\n,;]+/)) {
    const chat = line.trim();
    if (!chat) continue;
    const key = sourceChatKey(chat);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(chat);
  }
  return out;
}

export interface ReportInput {
  /** Границы отчётного периода, ISO; конец исключающий. */
  from: string;
  to: string;
  /** Часовой пояс, в котором режем недели. Для отчётов по РФ — +3. */
  tzOffsetHours?: number;
  dialogs: ReportDialog[];
  contacts: ReportContact[];
  bases: ReportBase[];
  forwards?: ReportForward[];
}

/** Гипотеза (база) внутри строки отчёта: сколько чатов и контактов она дала. */
export interface ReportBaseCell {
  base: string;
  /** null — чаты-источники у базы не указаны. */
  chats: number | null;
  contacts: number;
}

export interface ReportWeekRow {
  /** «03.08 — 09.08» */
  period: string;
  fromIso: string;
  toIso: string;
  /**
   * Сумма чатов гипотез этой строки. null — ни у одной гипотезы чаты не
   * указаны: ноль читался бы как «чаты не обрабатывали».
   */
  chats: number | null;
  contacts: number;
  /** Разбивка чатов и контактов по гипотезам строки. */
  bases: ReportBaseCell[];
  delivered: number;
  anyReplies: number;
  targetReplies: number;
  /** Процент с одним знаком. null — делить не на что, в отчёте это прочерк. */
  conversion: number | null;
}

export interface ReportLeadRow {
  /** Неделя передачи — строка раздела 1, к которой относится лид. */
  week: string;
  sourceChat: string;
  /** Заполняется руками. */
  criterion: '';
  nickname: string;
  /** Дата нашего первого сообщения человеку. */
  offerSentAt: string;
  /** Название базы (гипотезы), из которой взят контакт. */
  offerNumber: string;
  quality: 'MQL';
  /** Дата передачи лида клиенту. */
  handedOverAt: string;
}

export interface ReportOfferRow {
  /** Заполняется руками. */
  offerNumber: '';
  offer: string;
  /** Чаты-источники гипотезы. Пусто — их не заполнили у базы. */
  channel: string;
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
 * Чат, из которого взяли контакт, — из сырой строки файла выгрузки.
 *
 * Название колонки у скраперов разное, поэтому пробуем три известных подряд.
 * Пустая строка значит «в файле источника нет».
 */
export function sourceChatOf(raw: Record<string, unknown> | null | undefined): string {
  const value = raw?.['Ссылка на источник']
    ?? raw?.['Название источника']
    ?? raw?.['Источник']
    ?? '';
  return String(value).trim();
}

/**
 * Ключ сверки чатов: у одного и того же чата в выгрузке встречаются и ссылка
 * с «https://t.me/», и голый юзернейм. Без нормализации один чат считался бы
 * за два, и «обработано чатов» в отчёте по договору оказалось бы завышено.
 */
export function sourceChatKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^t\.me\//, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
}

function formatRange(fromMs: number, toMs: number, tzOffsetHours: number): string {
  const fmt = (ms: number) => {
    const d = new Date(ms + tzOffsetHours * 3_600_000);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${day}.${month}`;
  };
  // Конец показываем последним днём строки, а не началом следующей.
  const first = fmt(fromMs);
  const last = fmt(toMs - 1);
  return first === last ? first : `${first} — ${last}`;
}

function inRange(at: number | null, fromMs: number, toMs: number): boolean {
  return at !== null && at >= fromMs && at < toMs;
}

/** Момент первого входящего сообщения — то есть «человек ответил». */
export function firstReplyAt(dialog: ReportDialog): number | null {
  return firstReplyAfter(dialog, null);
}

/** Первое входящее после момента `afterMs` (или вообще первое). */
function firstReplyAfter(dialog: ReportDialog, afterMs: number | null): number | null {
  for (const m of dialog.messages ?? []) {
    if (m?.role !== 'user') continue;
    const t = ts(m.timestamp);
    if (t !== null && (afterMs === null || t >= afterMs)) return t;
  }
  return null;
}

/** Наше первое сообщение в диалоге — запасная «дата оффера». */
function firstOutgoingAt(dialog: ReportDialog): number | null {
  for (const m of dialog.messages ?? []) {
    if (m?.role !== 'assistant') continue;
    const t = ts(m.timestamp);
    if (t !== null) return t;
  }
  return null;
}

function wasDelivered(c: ReportContact): boolean {
  return c.status === 'sent' && ts(c.sent_at) !== null;
}

/**
 * Момент передачи лида клиенту — самый ранний из известных способов:
 * ручная карточка, автопересылка по триггеру, метка «лид». У старых лидов
 * (до лета 2026) ни одной метки нет — для них берём последнее сообщение
 * диалога, ближе к моменту передачи в базе ничего не осталось.
 *
 * null — человек клиенту не передавался.
 */
function handoverAt(dialog: ReportDialog, forwardAt: Map<string, number>): number | null {
  const candidates = [
    dialog.id ? forwardAt.get(dialog.id) ?? null : null,
    ts(dialog.auto_forwarded_at),
    dialog.status === 'lead' ? ts(dialog.lead_marked_at) : null,
  ].filter((t): t is number => t !== null);
  if (candidates.length) return Math.min(...candidates);
  if (dialog.status === 'lead') return ts(dialog.last_message_at) ?? firstReplyAt(dialog);
  return null;
}

/** Всё, что считается один раз на весь отчёт, а не на каждую строку. */
interface Prepared {
  /** Момент, к которому отнесена база: первое сообщение в периоде или загрузка. */
  baseMoment: Map<string, number>;
  baseCell: Map<string, ReportBaseCell>;
  /** Самое раннее отправленное касание по юзернейму. */
  touchByUsername: Map<string, ReportContact>;
  handovers: Array<{ dialog: ReportDialog; at: number }>;
}

function prepare(input: ReportInput, fromMs: number, toMs: number): Prepared {
  const byBase = new Map<string, ReportContact[]>();
  for (const c of input.contacts) {
    const list = byBase.get(c.base_id);
    if (list) list.push(c); else byBase.set(c.base_id, [c]);
  }

  const baseMoment = new Map<string, number>();
  const baseCell = new Map<string, ReportBaseCell>();
  for (const base of input.bases) {
    const contacts = byBase.get(base.id) ?? [];
    const firstSend = minTs(contacts.filter(wasDelivered).map((c) => ts(c.sent_at)), fromMs, toMs);
    const firstLoad = minTs(contacts.map((c) => ts(c.created_at)), fromMs, toMs);
    const moment = firstSend ?? firstLoad;
    if (moment === null) continue;
    baseMoment.set(base.id, moment);

    const declared = parseSourceChats(base.source_chats).map(sourceChatKey);
    const fromFile = contacts.map((c) => sourceChatKey(sourceChatOf(c.raw))).filter(Boolean);
    const chats = new Set(declared.length ? declared : fromFile);
    baseCell.set(base.id, {
      base: base.name,
      chats: chats.size ? chats.size : null,
      // Контакты, загруженные после конца периода, к нему не относятся.
      contacts: contacts.filter((c) => (ts(c.created_at) ?? 0) < toMs).length,
    });
  }

  const touchByUsername = new Map<string, ReportContact>();
  for (const c of input.contacts) {
    if (!wasDelivered(c)) continue;
    const key = usernameKey(c.username);
    const prev = key ? touchByUsername.get(key) : undefined;
    if (key && (!prev || (ts(c.sent_at) ?? 0) < (ts(prev.sent_at) ?? 0))) touchByUsername.set(key, c);
  }

  // Сорвавшиеся передачи не в счёт — до клиента такой лид не дошёл.
  const forwardAt = new Map<string, number>();
  for (const f of input.forwards ?? []) {
    if (f.status !== 'sent' && f.status !== 'pending') continue;
    const at = ts(f.sent_at) ?? ts(f.requested_at);
    if (!f.dialog_id || at === null) continue;
    const prev = forwardAt.get(f.dialog_id);
    if (prev === undefined || at < prev) forwardAt.set(f.dialog_id, at);
  }
  const handovers: Prepared['handovers'] = [];
  for (const dialog of input.dialogs) {
    const at = handoverAt(dialog, forwardAt);
    if (at !== null) handovers.push({ dialog, at });
  }
  handovers.sort((a, b) => a.at - b.at);

  return { baseMoment, baseCell, touchByUsername, handovers };
}

function minTs(values: Array<number | null>, fromMs: number, toMs: number): number | null {
  let min: number | null = null;
  for (const v of values) {
    if (inRange(v, fromMs, toMs) && (min === null || (v as number) < min)) min = v;
  }
  return min;
}

function countWindow(input: ReportInput, prep: Prepared, fromMs: number, toMs: number) {
  const bases: ReportBaseCell[] = [];
  for (const base of input.bases) {
    if (!inRange(prep.baseMoment.get(base.id) ?? null, fromMs, toMs)) continue;
    const cell = prep.baseCell.get(base.id);
    if (cell) bases.push(cell);
  }
  const known = bases.filter((b) => b.chats !== null);
  const chats = known.length ? known.reduce((s, b) => s + (b.chats as number), 0) : (bases.length ? null : 0);
  const contacts = bases.reduce((s, b) => s + b.contacts, 0);

  const delivered = input.contacts
    .filter((c) => wasDelivered(c) && inRange(ts(c.sent_at), fromMs, toMs)).length;

  // Ответ — только на наше касание: диалог с человеком из баз кампании, и
  // написал он после того, как ему ушло первое сообщение.
  let anyReplies = 0;
  for (const d of input.dialogs) {
    const touch = prep.touchByUsername.get(usernameKey(d.tg_username));
    if (!touch) continue;
    if (inRange(firstReplyAfter(d, ts(touch.sent_at)), fromMs, toMs)) anyReplies++;
  }

  const targetReplies = prep.handovers.filter((h) => inRange(h.at, fromMs, toMs)).length;

  return {
    chats,
    contacts,
    bases,
    delivered,
    anyReplies,
    targetReplies,
    // Ноль отправленных — прочерк, а не «0%»: нулевая конверсия и отсутствие
    // рассылки в отчёте по договору читаются очень по-разному.
    conversion: delivered > 0 ? Math.round((anyReplies / delivered) * 1000) / 10 : null,
  };
}

export function buildCampaignReport(input: ReportInput): CampaignReport {
  const tz = input.tzOffsetHours ?? 3;
  const fromMs = ts(input.from) ?? 0;
  const toMs = ts(input.to) ?? fromMs;
  const prep = prepare(input, fromMs, toMs);
  const baseById = new Map(input.bases.map((b) => [b.id, b]));

  const weeks: ReportWeekRow[] = [];
  for (let cursor = fromMs; cursor < toMs; cursor += WEEK_MS) {
    const winTo = Math.min(cursor + WEEK_MS, toMs);
    weeks.push({
      period: formatRange(cursor, winTo, tz),
      fromIso: new Date(cursor).toISOString(),
      toIso: new Date(winTo).toISOString(),
      ...countWindow(input, prep, cursor, winTo),
    });
  }

  const total: ReportWeekRow = {
    period: 'Итого',
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    ...countWindow(input, prep, fromMs, toMs),
  };

  const weekOf = (at: number) => weeks.find((w) => inRange(at, ts(w.fromIso) ?? 0, ts(w.toIso) ?? 0))?.period ?? '';

  // Лиды — ровно те, кого посчитали «целевыми ответами», в порядке передачи.
  const leads: ReportLeadRow[] = prep.handovers
    .filter((h) => inRange(h.at, fromMs, toMs))
    .map(({ dialog: d, at }) => {
      const contact = prep.touchByUsername.get(usernameKey(d.tg_username));
      const base = contact ? baseById.get(contact.base_id) : undefined;
      const offerAt = ts(contact?.sent_at) ?? firstOutgoingAt(d);
      return {
        week: weekOf(at),
        // Колонки «источник» в файлах баз обычно нет — тогда чаты гипотезы.
        sourceChat: sourceChatOf(contact?.raw) || parseSourceChats(base?.source_chats).join(', '),
        criterion: '' as const,
        nickname: d.tg_username ? `@${d.tg_username.trim().replace(/^@/, '')}` : String(d.tg_user_id ?? ''),
        offerSentAt: offerAt === null ? '' : formatDate(offerAt, tz),
        offerNumber: base?.name ?? '',
        quality: 'MQL' as const,
        handedOverAt: formatDate(at, tz),
      };
    });

  // По офферу считаем то же, что в разделе 1, но в разрезе базы.
  const dialogByUsername = new Map<string, ReportDialog>();
  for (const d of input.dialogs) {
    const key = usernameKey(d.tg_username);
    if (key) dialogByUsername.set(key, d);
  }
  const handoverByDialog = new Map(prep.handovers.map((h) => [h.dialog, h.at]));

  // Только гипотезы, по которым в периоде что-то было: строки с нулями за
  // давно отработанные базы раздел только засоряют.
  const offers: ReportOfferRow[] = input.bases.filter((base) => prep.baseMoment.has(base.id)).map((base) => {
    let sent = 0;
    let replies = 0;
    let leadCount = 0;
    for (const c of input.contacts) {
      if (c.base_id !== base.id || !wasDelivered(c)) continue;
      if (inRange(ts(c.sent_at), fromMs, toMs)) sent++;
      // Ответы и лиды — по первому касанию человека, чтобы один человек из
      // двух баз не засчитался обеим.
      if (prep.touchByUsername.get(usernameKey(c.username)) !== c) continue;
      const d = dialogByUsername.get(usernameKey(c.username));
      if (!d) continue;
      if (inRange(firstReplyAfter(d, ts(c.sent_at)), fromMs, toMs)) replies++;
      if (inRange(handoverByDialog.get(d) ?? null, fromMs, toMs)) leadCount++;
    }
    return {
      offerNumber: '' as const,
      offer: base.name,
      channel: parseSourceChats(base.source_chats).join('\n'),
      language: '' as const,
      status: '' as const,
      deadline: '' as const,
      comment: '' as const,
      conclusions: `отправлено ${sent}, ответов ${replies}, лидов ${leadCount}`,
    };
  });

  return { weeks, total, leads, offers };
}

/** «Гипотеза 3 — 4 чата, 120 контактов» для ячейки и копирования. */
export function formatBaseCells(cells: ReportBaseCell[], field: 'chats' | 'contacts'): string[] {
  return cells.map((b) => {
    const value = b[field];
    return `${b.base} — ${value === null ? 'не указаны' : value}`;
  });
}

/** «03.08.2026» — как в форме отчёта. */
export function formatDate(atMs: number, tzOffsetHours: number): string {
  const d = new Date(atMs + tzOffsetHours * 3_600_000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getUTCFullYear()}`;
}
