/**
 * Разметка первого сообщения → текст и форматирование Telegram.
 *
 * До 28.09.2026 текст уходил в gramJS как есть, и форматирование работало
 * побочным эффектом: встроенная markdown-разметка gramJS понимает `**жирный**`,
 * `__курсив__`, `~~зачёркнутый~~`, `` `код` `` и ```` ```блок``` ````. Ни
 * подчёркивания, ни ссылок `[текст](адрес)` в ней нет, а незакрытый маркер
 * она молча съедает. Здесь свой разбор с тем же поведением для этих пяти
 * маркеров плюс:
 *   - `<u>подчёркнутый</u>`;
 *   - `[текст](https://адрес)` — ссылка под словом;
 *   - маркер без пары остаётся в тексте как есть (раньше пропадал).
 *
 * Смещения — в единицах UTF-16, как их считает и JS, и Telegram.
 */
import { Api } from 'telegram';

export interface FormattedText {
  /** Текст, который увидит получатель, — без маркеров разметки. */
  text: string;
  entities: Api.TypeMessageEntity[];
}

type EntityMaker = (offset: number, length: number) => Api.TypeMessageEntity;

interface Marker {
  open: string;
  close: string;
  make: EntityMaker;
}

// Длинные первыми: ``` раньше `, иначе блок разобрался бы как три пустых кода.
const MARKERS: Marker[] = [
  { open: '```', close: '```', make: (offset, length) => new Api.MessageEntityPre({ offset, length, language: '' }) },
  { open: '**', close: '**', make: (offset, length) => new Api.MessageEntityBold({ offset, length }) },
  { open: '__', close: '__', make: (offset, length) => new Api.MessageEntityItalic({ offset, length }) },
  { open: '~~', close: '~~', make: (offset, length) => new Api.MessageEntityStrike({ offset, length }) },
  { open: '<u>', close: '</u>', make: (offset, length) => new Api.MessageEntityUnderline({ offset, length }) },
  { open: '`', close: '`', make: (offset, length) => new Api.MessageEntityCode({ offset, length }) },
];

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/y;

export function formatFirstTouch(source: string): FormattedText {
  let out = '';
  const entities: Api.TypeMessageEntity[] = [];
  /** Открытые маркеры: ключ — открывающий маркер, значение — начало в out. */
  const open = new Map<Marker, number>();
  let i = 0;

  outer: while (i < source.length) {
    LINK_RE.lastIndex = i;
    const link = LINK_RE.exec(source);
    if (link) {
      const offset = out.length;
      out += link[1];
      entities.push(new Api.MessageEntityTextUrl({ offset, length: link[1].length, url: link[2] }));
      i += link[0].length;
      continue;
    }

    for (const m of MARKERS) {
      const start = open.get(m);
      if (start !== undefined && source.startsWith(m.close, i)) {
        open.delete(m);
        if (out.length > start) entities.push(m.make(start, out.length - start));
        i += m.close.length;
        continue outer;
      }
      // Открываем, только если дальше есть пара: одиночная звёздочка или «<u>»
      // без закрытия — просто символы текста.
      if (start === undefined && source.startsWith(m.open, i) && source.indexOf(m.close, i + m.open.length) !== -1) {
        open.set(m, out.length);
        i += m.open.length;
        continue outer;
      }
    }

    out += source[i];
    i += 1;
  }

  return { text: out, entities: entities.sort((a, b) => a.offset - b.offset) };
}
