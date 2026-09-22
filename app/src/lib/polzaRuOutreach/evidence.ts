/**
 * Дословная сверка цитат-доказательств.
 *
 * Железное правило всех трёх офферов: цитата в письме или в выгрузке обязана
 * буквально встречаться в сохранённом тексте источника после одинаковой
 * нормализации HTML и пробелов. Модель не может «подтвердить» факт сама —
 * несверившаяся цитата считается отсутствующей, и строка уходит в generic.
 */

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
};

/** HTML → плоский текст: блочные теги в переводы строк, сущности раскрыты. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Ключ сравнения: регистр, ё/е, виды кавычек и тире, пробелы не важны. */
function compareKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»„“”"']/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsVerbatim(source: string, quote: string | null | undefined): boolean {
  if (!quote || !quote.trim()) return false;
  const q = compareKey(quote.replace(/^[«"“]+|[»"”]+$/g, ''));
  if (q.length < 8) return false;
  return compareKey(source).includes(q);
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Цитата пригодна для письма: дословная и не длиннее 30 слов (правила RU §5). */
export function acceptQuote(source: string, quote: string | null | undefined, maxWords = 30): string | null {
  if (!quote) return null;
  const clean = quote.trim().replace(/^[«"“]+|[»"”]+$/g, '').replace(/[.;,\s]+$/, '');
  if (!containsVerbatim(source, clean)) return null;
  if (wordCount(clean) > maxWords) return null;
  return clean;
}
