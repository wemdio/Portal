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

function isHidden(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (HIDDEN_FIELDS.has(lower)) return true;
  return HIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Содержательные поля карточки в том порядке, в каком их отдал AMO.
 *
 * Значение приводится к строке: в `select`-полях лежит текст, в числовых —
 * число, в датах — unix-секунды. Разбирать их по типам здесь не нужно, модалка
 * показывает поле как есть; пустые значения выбрасываются, чтобы не рисовать
 * строку «Оффер: —» ради самого факта существования поля.
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

    // Мультиселект отдаёт несколько значений — склеиваем, а не берём первое:
    // «Аутрич, ЛинкедИн» и «Аутрич» это разные ответы.
    const parts: string[] = [];
    for (const entry of values) {
      if (entry === null || typeof entry !== 'object') continue;
      const value = (entry as { value?: unknown }).value;
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text !== '') parts.push(text);
    }
    if (parts.length === 0) continue;

    out.push({ name: name.trim(), value: parts.join(', ') });
  }
  return out;
}
