/**
 * Оформление текста письма: жирный `**так**`, курсив `''так''`, подчёркнутый
 * `__так__`, зачёркнутый `~~так~~`, список строк с `- ` или `1. ` в начале и
 * цитата со строками `> `.
 *
 * Разметка живёт в обычном поле письма (как и ссылки под словом, см.
 * linkMarkup). Тем же разбором письмо собирается в HTML, а предпросмотр на
 * экране рисуется — иначе они разъедутся. Модуль без серверных зависимостей.
 */

const BULLET_RE = /^\s*[-•]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

export type LetterBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'list'; ordered?: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] };

/**
 * Текст письма на блоки: абзацы (разделены пустой строкой) и маркированные
 * списки. Строки с «- » или «• » подряд — один список, даже внутри абзаца.
 */
export function letterBlocks(source: string): LetterBlock[] {
  const out: LetterBlock[] = [];
  for (const raw of source.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    let current: LetterBlock | null = null;
    for (const line of block.split('\n')) {
      const bullet = BULLET_RE.exec(line);
      const numbered = bullet ? null : NUMBERED_RE.exec(line);
      const quote = bullet || numbered ? null : QUOTE_RE.exec(line);
      if (bullet || numbered) {
        const ordered = Boolean(numbered);
        if (current?.kind !== 'list' || Boolean(current.ordered) !== ordered) {
          current = ordered ? { kind: 'list', ordered: true, items: [] } : { kind: 'list', items: [] };
          out.push(current);
        }
        current.items.push((bullet ?? numbered)![1]);
      } else if (quote) {
        if (current?.kind !== 'quote') {
          current = { kind: 'quote', lines: [] };
          out.push(current);
        }
        current.lines.push(quote[1]);
      } else {
        if (current?.kind !== 'text') {
          current = { kind: 'text', lines: [] };
          out.push(current);
        }
        current.lines.push(line);
      }
    }
  }
  return out;
}

export interface BoldChunk {
  bold: boolean;
  text: string;
}

/** Кусок текста — на обычное и выделенное жирным. */
export function splitBold(source: string): BoldChunk[] {
  const chunks: BoldChunk[] = [];
  let last = 0;
  for (const match of source.matchAll(BOLD_RE)) {
    const start = match.index ?? 0;
    if (start > last) chunks.push({ bold: false, text: source.slice(last, start) });
    chunks.push({ bold: true, text: match[1] });
    last = start + match[0].length;
  }
  if (last < source.length) chunks.push({ bold: false, text: source.slice(last) });
  return chunks;
}

/** Текстовая часть письма: жирный без звёздочек, пункты списка — «• пункт». */
export function letterMarkupToText(source: string): string {
  return stripInlineMarks(source).replace(/^([ \t]*)[-•][ \t]+/gm, '$1• ');
}

const STYLE_RE = /(\*\*|''|__|~~)([^\n]+?)\1/g;

export type InlineMark = 'bold' | 'italic' | 'underline' | 'strike';

const MARK_BY_TOKEN: Record<string, InlineMark> = { '**': 'bold', "''": 'italic', __: 'underline', '~~': 'strike' };

export interface StyledChunk {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** Оформленный текст — на куски со своими отметками (вложенность допустима). */
export function splitStyled(source: string, marks: Partial<Record<InlineMark, boolean>> = {}): StyledChunk[] {
  const chunks: StyledChunk[] = [];
  let last = 0;
  for (const match of source.matchAll(STYLE_RE)) {
    const start = match.index ?? 0;
    if (start > last) chunks.push({ text: source.slice(last, start), ...marks });
    chunks.push(...splitStyled(match[2], { ...marks, [MARK_BY_TOKEN[match[1]]]: true }));
    last = start + match[0].length;
  }
  if (last < source.length) chunks.push({ text: source.slice(last), ...marks });
  return chunks;
}

/** Текст без отметок оформления (для текстовой части письма). */
export function stripInlineMarks(source: string): string {
  let text = source;
  for (let i = 0; i < 4; i++) {
    const next = text.replace(STYLE_RE, '$2');
    if (next === text) break;
    text = next;
  }
  return text;
}

export interface TextEdit {
  text: string;
  selStart: number;
  selEnd: number;
}

/** Оформление выделения: оборачивает в `marker`, повторное нажатие снимает. Без выделения — вставляет пару для набора. */
export function toggleMark(text: string, start: number, end: number, marker: string): TextEdit {
  const n = marker.length;
  if (start === end) {
    const next = `${text.slice(0, start)}${marker}${marker}${text.slice(end)}`;
    return { text: next, selStart: start + n, selEnd: start + n };
  }
  const wrapped = text.slice(start - n, start) === marker && text.slice(end, end + n) === marker;
  if (wrapped) {
    return {
      text: `${text.slice(0, start - n)}${text.slice(start, end)}${text.slice(end + n)}`,
      selStart: start - n,
      selEnd: end - n,
    };
  }
  const selected = text.slice(start, end);
  const already =
    selected.length > 2 * n && selected.startsWith(marker) && selected.endsWith(marker) && !selected.slice(n, -n).includes('\n');
  const inner = already ? selected.slice(n, -n) : `${marker}${selected}${marker}`;
  return {
    text: text.slice(0, start) + inner + text.slice(end),
    selStart: start,
    selEnd: start + inner.length,
  };
}

export const toggleBold = (text: string, start: number, end: number) => toggleMark(text, start, end, '**');
export const toggleItalic = (text: string, start: number, end: number) => toggleMark(text, start, end, "''");
export const toggleUnderline = (text: string, start: number, end: number) => toggleMark(text, start, end, '__');
export const toggleStrike = (text: string, start: number, end: number) => toggleMark(text, start, end, '~~');

/** Строки, которых касается выделение: границы блока и сами строки. */
function selectedLines(text: string, start: number, end: number) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;
  return { lineStart, lineEnd, lines: text.slice(lineStart, lineEnd).split('\n') };
}

function replaceLines(text: string, lineStart: number, lineEnd: number, changed: string): TextEdit {
  return {
    text: text.slice(0, lineStart) + changed + text.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + changed.length,
  };
}

/** Нумерованный список: «1. », «2. »… перед строками выделения; если все уже пункты — снимает. */
export function toggleNumbered(text: string, start: number, end: number): TextEdit {
  const { lineStart, lineEnd, lines } = selectedLines(text, start, end);
  const filled = lines.filter((line) => line.trim());
  const all = filled.length > 0 && filled.every((line) => NUMBERED_RE.test(line));
  let n = 0;
  const changed = lines
    .map((line) => {
      if (all) return line.replace(/^(\s*)\d+[.)]\s+/, '$1');
      if (!line.trim() && lines.length > 1) return line;
      n += 1;
      return `${n}. ${line.replace(/^(\s*)(?:\d+[.)]|[-•])\s+/, '$1')}`;
    })
    .join('\n');
  return replaceLines(text, lineStart, lineEnd, changed);
}

/** Цитата: «> » перед строками выделения; если все уже цитата — снимает. */
export function toggleQuote(text: string, start: number, end: number): TextEdit {
  const { lineStart, lineEnd, lines } = selectedLines(text, start, end);
  const filled = lines.filter((line) => line.trim());
  const all = filled.length > 0 && filled.every((line) => QUOTE_RE.test(line));
  const changed = lines
    .map((line) => {
      if (all) return line.replace(/^(\s*)>\s?/, '$1');
      if (!line.trim() && lines.length > 1) return line;
      return QUOTE_RE.test(line) ? line : `> ${line}`;
    })
    .join('\n');
  return replaceLines(text, lineStart, lineEnd, changed);
}

/** Убрать оформление: в строках выделения уходят отметки и маркеры списков и цитаты. */
export function clearFormatting(text: string, start: number, end: number): TextEdit {
  const { lineStart, lineEnd, lines } = selectedLines(text, start, end);
  const changed = stripInlineMarks(lines.join('\n'))
    .split('\n')
    .map((line) => line.replace(/^(\s*)(?:[-•]|\d+[.)]|>)\s?/, '$1'))
    .join('\n');
  return replaceLines(text, lineStart, lineEnd, changed);
}

/** Список: ставит «- » перед каждой строкой выделения; если все уже пункты — снимает. */
export function toggleBullets(text: string, start: number, end: number): TextEdit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const filled = lines.filter((line) => line.trim());
  const allBullets = filled.length > 0 && filled.every((line) => BULLET_RE.test(line));
  const changed = lines
    .map((line) => {
      if (allBullets) return line.replace(/^(\s*)[-•]\s+/, '$1');
      if (!line.trim() && lines.length > 1) return line;
      return BULLET_RE.test(line) ? line : `- ${line}`;
    })
    .join('\n');
  return {
    text: text.slice(0, lineStart) + changed + text.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + changed.length,
  };
}
