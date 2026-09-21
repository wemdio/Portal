import { randomUUID } from 'crypto';

/**
 * Сборка исходящего письма — общая для обоих движков отправки портала:
 * инструмента «Рассылка» (lib/sender) и клиентского BYO (lib/byoMailbox).
 *
 * Здесь живёт то, от чего зависит, попадёт письмо во «Входящие» или в спам, и
 * что поэтому обязано быть одинаковым везде:
 *   • свой Message-ID на домене отправителя;
 *   • две части письма (текст и HTML) вместо одной;
 *   • видимый способ отказаться от рассылки и заголовок List-Unsubscribe.
 */

/**
 * Message-ID делаем сами и до отправки.
 *
 * Иначе его проставит MTA провайдера — и у него там окажется свой домен, не
 * совпадающий с доменом в From. Для фильтров это несоответствие — минус к
 * репутации; для нас — потерянная связь письма с ответом на него.
 */
export function buildMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1]?.trim() || 'localhost';
  return `<${randomUUID()}@${domain}>`;
}

/** Адрес внутри «Имя <box@dom.ru>» или сам адрес, если имени нет. */
export function bareAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim();
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Текст письма в простой HTML: абзацы и переносы строк, больше ничего.
 *
 * Разметка нарочно скучная. HTML здесь нужен не для оформления, а чтобы
 * письмо было multipart/alternative: холодное письмо из одной-единственной
 * части фильтры считают типичной машинной рассылкой.
 */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => escapeHtml(block.trim()).replace(/\n/g, '<br>'))
    .filter(Boolean);
  const body = paragraphs.length ? paragraphs.map((p) => `<p>${p}</p>`).join('\n') : '<p></p>';
  return `<div dir="auto">\n${body}\n</div>`;
}

/** Грубое обратное преобразование: нужно, когда у письма есть только HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Куда отписываться. Отдельного эндпоинта у нас нет, поэтому адрес — сам ящик
 * отправителя: письмо и так уходит от него, ответ на него дойдёт всегда.
 *
 * Парного заголовка List-Unsubscribe-Post здесь намеренно нет: одним
 * mailto: он невалиден, для него нужен https-адрес, принимающий POST.
 */
export function unsubscribeMailto(fromEmail: string): string {
  return `mailto:${bareAddress(fromEmail)}?subject=unsubscribe`;
}

/** Видимая строка отказа — её дописываем в конец письма. */
export function unsubscribeLine(fromEmail: string): string {
  return `Не хотите писем — ответьте на это письмо словом «стоп», и я больше не побеспокою (${bareAddress(fromEmail)}).`;
}

export interface MailParts {
  text: string;
  html: string;
  /** Заголовки письма: List-Unsubscribe. */
  headers: Record<string, string>;
}

/**
 * Собрать части письма из того, что написал автор кампании.
 *
 * Видимая строка отказа дописывается здесь, а не хранится в тексте кампании:
 * релей провайдера может срезать заголовок List-Unsubscribe, и тогда способ
 * отказаться остаётся только один — в самом тексте. Повторно строка не
 * добавляется: если автор уже написал свою, чужую снизу не подставляем.
 */
export function buildMailParts(input: {
  from: string;
  text?: string | null;
  html?: string | null;
  /** Строку отказа и заголовок можно не добавлять — например, у тестового письма. */
  unsubscribe?: boolean;
}): MailParts {
  const unsubscribe = input.unsubscribe ?? true;
  const address = bareAddress(input.from);

  let text = (input.text ?? '').trim();
  let html = (input.html ?? '').trim();
  if (!text && !html) text = '';
  if (!text) text = htmlToText(html);

  if (unsubscribe && !text.includes(address)) {
    const line = unsubscribeLine(input.from);
    text = text ? `${text}\n\n—\n${line}` : line;
    // HTML пересобираем из текста ниже, если своего HTML у письма нет.
    if (html) html += `\n<p style="color:#888;font-size:12px">${escapeHtml(line)}</p>`;
  }

  if (!html) html = textToHtml(text);

  return {
    text,
    html,
    headers: unsubscribe ? { 'List-Unsubscribe': `<${unsubscribeMailto(input.from)}>` } : {},
  };
}
