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
 *   - обработанные чаты — уникальные источники контактов, загруженных в базы
 *     этой кампании за неделю; точно, но зависит от того, что источник вообще
 *     указан в файле выгрузки;
 *   - любые ответы — по метке первого входящего сообщения в диалоге, точно;
 *   - целевые ответы — по последнему сообщению диалога: момент, когда сработал
 *     триггер, в базе не сохраняется, и это ближайшее к нему время.
 */

export interface ReportDialog {
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
  /** Границы отчётного периода, ISO. */
  from: string;
  to: string;
  /** Часовой пояс, в котором режем недели. Для отчётов по РФ — +3. */
  tzOffsetHours?: number;
  dialogs: ReportDialog[];
  contacts: ReportContact[];
  bases: ReportBase[];
}

export interface ReportWeekRow {
  /** «03.08 — 09.08» */
  period: string;
  fromIso: string;
  toIso: string;
  /**
   * Уникальных чатов-источников за неделю. null — источник не указан ни у
   * одного контакта, и в отчёте это прочерк: ноль читался бы как «чаты не
   * обрабатывали», хотя на самом деле их просто не записали в файл.
   */
  chats: number | null;
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
 * Пустая строка значит «в файле источника нет», и это не то же самое, что
 * «источников не было»: на этой разнице держится прочерк в колонке отчёта.
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
  /**
   * Обработанные чаты считаем по самим контактам кампании, а не по задачам
   * парсера. Задачи к кампании не привязаны — у них есть только владелец, и в
   * отчёт клиента попадали чаты, которые специалист парсил в тот же период для
   * кого-то другого. Контакт же всегда лежит в базе конкретной кампании и несёт
   * ссылку на свой чат-источник.
   */
  const windowContacts = input.contacts
    .filter((c) => inRange(ts(c.created_at), fromMs, toMs));

  const chatKeys = new Set<string>();
  for (const c of windowContacts) {
    const key = sourceChatKey(sourceChatOf(c.raw));
    if (key) chatKeys.add(key);
  }
  /**
   * Чаты, объявленные у самих баз. Считаем только те базы, в которые за это
   * окно грузили контакты: гипотеза, заведённая в мае, к неделе августа
   * отношения не имеет, и её чаты в этой строке отчёта были бы приписками.
   */
  const loadedBaseIds = new Set(windowContacts.map((c) => c.base_id));
  for (const base of input.bases) {
    if (!loadedBaseIds.has(base.id)) continue;
    for (const chat of parseSourceChats(base.source_chats)) {
      chatKeys.add(sourceChatKey(chat));
    }
  }
  // Контакты есть, а источников нет — прочерк: колонку заполнят руками, а не
  // сдадут клиенту ноль, который читается как «не работали».
  const chats = chatKeys.size > 0 ? chatKeys.size : (windowContacts.length ? null : 0);

  const contacts = windowContacts.length;

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
      const source = sourceChatOf(contact?.raw);
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

/** «03.08.2026» — как в форме отчёта. */
export function formatDate(atMs: number, tzOffsetHours: number): string {
  const d = new Date(atMs + tzOffsetHours * 3_600_000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getUTCFullYear()}`;
}
