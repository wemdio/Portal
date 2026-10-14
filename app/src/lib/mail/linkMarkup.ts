/**
 * Ссылка под словом в тексте письма: `[Alial](https://alial.ru)`.
 *
 * Разметка та же, что в первом касании Telegram-аутрича (tgOutreach/firstTouch/
 * formatText) — одно правило на оба канала, чтобы оператор не держал в голове
 * два синтаксиса.
 *
 * Письмо уходит двумя частями. В HTML-части ссылка становится обычным `<a>`,
 * в текстовой — «Alial (https://alial.ru)»: в plain text ссылки под словом не
 * существует, а адрес получателю всё равно нужен.
 *
 * Модуль намеренно без серверных зависимостей: тем же разбором форма рисует
 * предпросмотр письма в браузере.
 */

/** Подпись без переносов и адрес http(s) без пробелов и скобок. */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g;

/** Начатая ссылка без адреса или с адресом без схемы: «[Alial](alial.ru)». */
const BROKEN_LINK_RE = /\[[^\]\n]+\]\((?!https?:\/\/)[^)\n]*\)/;

export type LetterChunk =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; url: string };

/**
 * Текст письма — на куски: обычный текст и ссылки. По этому разбору строятся
 * и HTML письма, и предпросмотр на экране — иначе они разъедутся.
 */
export function splitLinkMarkup(source: string): LetterChunk[] {
  const chunks: LetterChunk[] = [];
  let last = 0;
  for (const match of source.matchAll(LINK_RE)) {
    const start = match.index ?? 0;
    if (start > last) chunks.push({ kind: 'text', text: source.slice(last, start) });
    chunks.push({ kind: 'link', text: match[1], url: match[2] });
    last = start + match[0].length;
  }
  if (last < source.length) chunks.push({ kind: 'text', text: source.slice(last) });
  return chunks;
}

/** Текстовая часть письма: разметка разворачивается в «подпись (адрес)». */
export function linkMarkupToText(source: string): string {
  return splitLinkMarkup(source)
    .map((chunk) => {
      if (chunk.kind === 'text') return chunk.text;
      // Подпись и есть адрес — скобки с тем же адресом только мешают.
      return chunk.text.trim() === chunk.url ? chunk.url : `${chunk.text} (${chunk.url})`;
    })
    .join('');
}

/** Есть ли в тексте ссылка, записанная так, что она не станет ссылкой. */
export function hasBrokenLinkMarkup(source: string): boolean {
  return BROKEN_LINK_RE.test(source);
}

/** Адрес из поля формы: без схемы ссылка не соберётся, дописываем https. */
export function normalizeLinkUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`;
}
