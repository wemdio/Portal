/**
 * Поля карточки AMO для модалки сделки на дашборде первички.
 *
 * В `amo_leads.raw` лежит снимок карточки целиком, и содержательных полей там
 * меньшинство: остальное — разметка рекламы и техника форм (`utm_*`, `COOKIES`,
 * `FORMID`, `_ym_uid`, `yclid`). Показать всё — превратить модалку в свалку, в
 * которой «Источник» и ИНН тонут между двумя десятками строк с идентификаторами.
 *
 * Отсев списком, а не правилом «прячем всё латиницей»: латиницей названы и
 * `Telegram`, и `CTA` — вполне содержательные поля, а по-русски названо
 * `КАК_С_ВАМИ_СВЯЗАТЬСЯ`. Никакого признака, кроме смысла, у этих имён нет,
 * поэтому список ведётся руками. **Новое техническое поле, заведённое в AMO,
 * появится в модалке, пока его сюда не добавят** — это осознанный выбор:
 * лишняя строка заметна и чинится за минуту, а молча спрятанное содержательное
 * поле не заметит никто.
 */

/** Технические поля, скрытые из модалки. Сверяются без учёта регистра. */
const HIDDEN_FIELDS = new Set(
  [
    'TRANID',
    'REFERER',
    'referrer',
    'FORMID',
    'FORMNAME',
    'COOKIES',
    'SITE',
    'CHECKBOX',
    'PRIVACY_POLICY',
    'CONNECT',
    'COMMUNICATION_METHOD',
    'COMMUNICATION_CAPABILITY',
    'YMCLIENTID',
    '_ym_uid',
    'yclid',
    'fbclid',
    'gclid',
  ].map((name) => name.toLowerCase()),
);

/** Префиксы технических полей: разметка рекламных кампаний плодится сама. */
const HIDDEN_PREFIXES = ['utm_'];

export type DealCardField = { name: string; value: string };

/**
 * Типы полей AMO, в которых лежит дата unix-секундами.
 *
 * Определяем дату по типу поля, а не по виду значения: десятизначный ИНН
 * («1234567890») неотличим от метки времени, и правило «десять цифр — значит
 * дата» превратило бы ИНН компании в 2009 год.
 */
const DATE_FIELD_TYPES = new Set(['date', 'date_time', 'birthday']);

/**
 * Дата и время по Москве, до минут: «20.05.2026 00:00».
 *
 * Зона задана явно: сервер может жить в UTC, и без неё дата поля «Дата
 * оплаты» — полночь по Москве — показалась бы предыдущим днём в 21:00.
 */
const MSK_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatAmoDate(value: string): string {
  if (!/^\d{1,12}$/.test(value)) return value;
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return value;
  // Intl ставит запятую между датой и временем — в карточке она лишняя.
  return MSK_DATE_TIME.format(date).replace(', ', ' ');
}

function isHidden(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (HIDDEN_FIELDS.has(lower)) return true;
  return HIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Содержательные поля карточки в том порядке, в каком их отдал AMO.
 *
 * Значение приводится к строке: в `select`-полях лежит текст, в числовых —
 * число. Даты AMO отдаёт unix-секундами, и модалка показывала «1779310800»
 * вместо дня — поэтому поля с типом даты переводятся в «ДД.ММ.ГГГГ ЧЧ:ММ» по
 * Москве. Пустые значения выбрасываются, чтобы не рисовать строку «Оффер: —»
 * ради самого факта существования поля.
 */
export function readDealCardFields(raw: unknown): DealCardField[] {
  if (raw === null || typeof raw !== 'object') return [];
  const fields = (raw as { custom_fields_values?: unknown }).custom_fields_values;
  if (!Array.isArray(fields)) return [];

  const out: DealCardField[] = [];
  for (const field of fields) {
    if (field === null || typeof field !== 'object') continue;
    const name = (field as { field_name?: unknown }).field_name;
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (isHidden(name)) continue;

    const values = (field as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length === 0) continue;

    const fieldType = (field as { field_type?: unknown }).field_type;
    const isDate = typeof fieldType === 'string' && DATE_FIELD_TYPES.has(fieldType);

    // Мультиселект отдаёт несколько значений — склеиваем, а не берём первое:
    // «Аутрич, ЛинкедИн» и «Аутрич» это разные ответы.
    const parts: string[] = [];
    for (const entry of values) {
      if (entry === null || typeof entry !== 'object') continue;
      const value = (entry as { value?: unknown }).value;
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text !== '') parts.push(isDate ? formatAmoDate(text) : text);
    }
    if (parts.length === 0) continue;

    out.push({ name: name.trim(), value: parts.join(', ') });
  }
  return out;
}
