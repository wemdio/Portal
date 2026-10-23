/**
 * Оформление текста письма: жирный `**так**` и список строк с `- ` в начале.
 *
 * Разметка живёт в обычном поле письма (как и ссылки под словом, см.
 * linkMarkup). Тем же разбором письмо собирается в HTML, а предпросмотр на
 * экране рисуется — иначе они разъедутся. Модуль без серверных зависимостей.
 */

const BULLET_RE = /^\s*[-•]\s+(.*)$/;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

export type LetterBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'list'; items: string[] };

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
      if (bullet) {
        if (current?.kind !== 'list') {
          current = { kind: 'list', items: [] };
          out.push(current);
        }
        current.items.push(bullet[1]);
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
  return source
    .replace(BOLD_RE, '$1')
    .replace(/^([ \t]*)[-•][ \t]+/gm, '$1• ');
}

export interface TextEdit {
  text: string;
  selStart: number;
  selEnd: number;
}

/** Жирный: оборачивает выделение в `**`, повторное нажатие снимает. Без выделения — вставляет пару для набора. */
export function toggleBold(text: string, start: number, end: number): TextEdit {
  if (start === end) {
    const next = `${text.slice(0, start)}****${text.slice(end)}`;
    return { text: next, selStart: start + 2, selEnd: start + 2 };
  }
  const wrapped = text.slice(start - 2, start) === '**' && text.slice(end, end + 2) === '**';
  if (wrapped) {
    return {
      text: `${text.slice(0, start - 2)}${text.slice(start, end)}${text.slice(end + 2)}`,
      selStart: start - 2,
      selEnd: end - 2,
    };
  }
  const selected = text.slice(start, end);
  const inner = /^\*\*[^*\n]+\*\*$/.test(selected) ? selected.slice(2, -2) : `**${selected}**`;
  return {
    text: text.slice(0, start) + inner + text.slice(end),
    selStart: start,
    selEnd: start + inner.length,
  };
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
