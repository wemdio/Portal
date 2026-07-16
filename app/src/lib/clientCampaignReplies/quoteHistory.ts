/**
 * Цитирование истории переписки в теле ответа.
 *
 * Зачем: когда мы отвечаем лиду и добавляем в CC коллегу/ЛПР (например Настю),
 * этот получатель — НОВЫЙ в треде, и Instantly НЕ подкладывает ему прошлую
 * переписку. Без цитаты он видит только наш ответ и не понимает, на что мы
 * отвечаем (инцидент 09.07: «Настя видит наш ответ, но не видит письмо
 * клиента»). Дописываем процитированное письмо лида (оно уже содержит наш
 * исходный оффер) прямо в тело — и в text, и в HTML.
 */

export interface QuoteSource {
  /** Уже извлечённый текст письма лида (то, что цитируем). */
  bodyText: string | null | undefined;
  fromName?: string | null;
  fromEmail?: string | null;
  /** ISO-таймстамп письма лида. */
  timestamp?: string | null;
}

/** «дата, кто писал(а):» — заголовок цитаты. */
export function buildQuoteHeader(src: QuoteSource): string {
  const who = src.fromName?.trim() || src.fromEmail?.trim() || 'Отправитель';
  let when = '';
  if (src.timestamp) {
    const d = new Date(src.timestamp);
    // timeZone обязателен: заголовок цитаты уходит ЛИДУ во внешнем письме, а TZ
    // контейнера = UTC — без него собеседник видел время своего же письма на
    // 3 часа раньше московского.
    if (!Number.isNaN(d.getTime())) {
      when = d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    }
  }
  return `${[when, who].filter(Boolean).join(', ')} писал(а):`;
}

const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Кап на размер цитаты: длинные треды (вложенные цитаты, тяжёлый HTML) без
 * лимита раздували бы payload в Instantly — validateReplyInput проверяет
 * только НАБРАННЫЙ текст, ДО дописывания цитаты. 20k символов хватает на
 * любой разумный диалог; хвост честно помечаем обрезкой.
 */
const MAX_QUOTED_CHARS = 20_000;

function clampHistory(raw: string | null | undefined): string {
  const history = (raw ?? '').trim();
  if (history.length <= MAX_QUOTED_CHARS) return history;
  return `${history.slice(0, MAX_QUOTED_CHARS)}\n[…текст обрезан]`;
}

/** Дописывает процитированную историю под ТЕКСТ ответа. Пусто → без изменений. */
export function appendQuotedHistoryText(replyText: string, src: QuoteSource): string {
  const history = clampHistory(src.bodyText);
  if (!history) return replyText;
  const quoted = history.split(/\r\n|\r|\n/).map((l) => `> ${l}`).join('\n');
  return `${replyText}\n\n${buildQuoteHeader(src)}\n${quoted}`;
}

/** Дописывает процитированную историю под HTML-тело ответа (blockquote). */
export function appendQuotedHistoryHtml(replyHtml: string, src: QuoteSource): string {
  const history = clampHistory(src.bodyText);
  if (!history) return replyHtml;
  const quotedHtml = escHtml(history).replace(/\r\n|\r|\n/g, '<br>\n');
  return (
    `${replyHtml}<br>\n<br>\n` +
    `<div style="color:#6b7280;font-size:13px">${escHtml(buildQuoteHeader(src))}</div>\n` +
    `<blockquote style="margin:4px 0 0;padding-left:10px;border-left:2px solid #d1d5db;color:#4b5563">${quotedHtml}</blockquote>`
  );
}
