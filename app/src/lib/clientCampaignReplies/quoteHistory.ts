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

/**
 * Время письма для заголовков цитаты и пересылки.
 *
 * timeZone обязателен: заголовок уходит ВО ВНЕШНЕМ письме, а TZ контейнера =
 * UTC — без него собеседник видел время своего же письма на 3 часа раньше
 * московского. Подпись «(МСК)» — потому что лиды бывают по всей РФ
 * (UTC+2..+12): время без пояса у них не совпало бы с их почтовым клиентом без
 * объяснения. Пустая строка — если таймстампа нет или он битый.
 */
function formatMskTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)`;
}

/** «дата, кто писал(а):» — заголовок цитаты. */
export function buildQuoteHeader(src: QuoteSource): string {
  const who = src.fromName?.trim() || src.fromEmail?.trim() || 'Отправитель';
  const when = formatMskTimestamp(src.timestamp);
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

export interface ForwardSource extends QuoteSource {
  subject?: string | null;
}

/**
 * HTML-тело пересылки, собранное нами, — для обходного пути, где провайдер сам
 * исходное письмо не подкладывает.
 *
 * Обычная пересылка идёт через forward с include_original_body: провайдер сам
 * дописывает исходное письмо. По «сироте» (ответ, не привязанный к кампании) он
 * этот вызов отвергает — `400 … is not part of a campaign`, — и мы отправляем
 * НОВОЕ письмо тем же ящиком (см. forward/route.ts). Тогда исходное письмо
 * приходится вложить самим, иначе адресат получит пустое «Fwd:».
 *
 * Формат — как у почтовиков: разделитель, От / Дата / Тема, затем текст.
 * Получатель пересылки — обычно коллега клиента, ему нужно видеть, кто и когда
 * написал. Строку «Кому» не выводим: там наш отправляющий ящик, адресату он ни к
 * чему.
 */
export function buildForwardedMessageHtml(src: ForwardSource): string {
  const name = src.fromName?.trim();
  const email = src.fromEmail?.trim();
  const from = name && email ? `${name} <${email}>` : name || email || 'Отправитель';
  const headerLines = [
    '---------- Пересланное сообщение ----------',
    `От: ${from}`,
    ...(formatMskTimestamp(src.timestamp) ? [`Дата: ${formatMskTimestamp(src.timestamp)}`] : []),
    ...(src.subject?.trim() ? [`Тема: ${src.subject.trim()}`] : []),
  ];
  const headerHtml = headerLines.map(escHtml).join('<br>\n');
  const history = clampHistory(src.bodyText);
  const bodyHtml = history ? escHtml(history).replace(/\r\n|\r|\n/g, '<br>\n') : '';
  return (
    `<div style="color:#6b7280;font-size:13px">${headerHtml}</div>\n` +
    (bodyHtml ? `<br>\n<div>${bodyHtml}</div>` : '')
  );
}
