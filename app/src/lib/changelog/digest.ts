/**
 * Разбор сводки обновлений портала на разделы.
 *
 * Текст сводки пишет ИИ по шаблону из services/changelog-bot: три блока с
 * заголовками, внутри — нумерованные пункты. В телеграм он уходит одним
 * полотном, а в портале нужен разбор: технический блок по умолчанию свёрнут,
 * иначе модалка превращается в простыню, которую никто не дочитает.
 *
 * Разбор намеренно терпимый. Заголовки формулирует ИИ, и «Прочие технические
 * обновления:» он однажды напишет чуть иначе — падать из-за этого нельзя.
 * Всё, что не опознано, остаётся в разделе «как есть» и показывается целиком.
 */

export type DigestSectionKind = 'portal' | 'client' | 'technical' | 'other';

export interface DigestSection {
  kind: DigestSectionKind;
  title: string;
  /** Пункты раздела без нумерации: список рисует разметка, а не текст. */
  items: string[];
}

/** Заголовок раздела по первым словам: точную формулировку ИИ не гарантирует. */
function classify(line: string): DigestSectionKind | null {
  const text = line.toLowerCase();
  if (!text.includes('обновлен')) return null;
  if (text.includes('клиентск')) return 'client';
  if (text.includes('техническ') || text.includes('прочие')) return 'technical';
  if (text.includes('основного функционала') || text.includes('портала')) return 'portal';
  return null;
}

/** Строка похожа на заголовок раздела: короткая, без нумерации, с двоеточием. */
function looksLikeHeading(line: string): boolean {
  return line.endsWith(':') && !/^\s*[-•\d]/.test(line);
}

/**
 * Пункт списка: «1. …», «- …», «• …».
 *
 * Вложенные пункты (с отступом) приклеиваем к предыдущему: в сводке они
 * поясняют его, а не живут сами по себе.
 */
function itemText(line: string): string | null {
  const match = /^\s*(?:\d+[.)]|[-•*])\s+(.*)$/.exec(line);
  return match ? match[1].trim() : null;
}

export function parseDigest(summary: string): DigestSection[] {
  const sections: DigestSection[] = [];
  let current: DigestSection | null = null;

  for (const raw of (summary ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (looksLikeHeading(line)) {
      current = { kind: classify(line) ?? 'other', title: line.replace(/:$/, ''), items: [] };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = { kind: 'other', title: '', items: [] };
      sections.push(current);
    }

    const item = itemText(line);
    if (item) {
      current.items.push(item);
    } else if (current.items.length) {
      // Продолжение предыдущего пункта — перенос строки или вложенный абзац.
      current.items[current.items.length - 1] += ` ${line.trim()}`;
    } else {
      current.items.push(line.trim());
    }
  }

  return sections.filter((section) => section.items.length > 0);
}

/** Заголовок уведомления и модалки: «Обновления портала за 22.09». */
export function digestTitle(windowTo: string): string {
  const date = new Date(windowTo);
  if (Number.isNaN(date.getTime())) return 'Обновления портала';
  return `Обновления портала за ${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
}

/**
 * Границы периода словами: «с 9:00 21 сентября до 9:00 22 сентября».
 *
 * Сводка накрывает сутки от девяти утра до девяти утра, и без этой строки
 * дата в заголовке читается как «за 22 сентября» — то есть за день, который
 * ещё идёт. Время по Москве: окно бот считает по ней же.
 */
export function digestPeriod(windowFrom: string, windowTo: string): string | null {
  const from = new Date(windowFrom);
  const to = new Date(windowTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;

  const part = (date: Date) => {
    const time = date.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow', hour: 'numeric', minute: '2-digit',
    });
    const day = date.toLocaleDateString('ru-RU', {
      timeZone: 'Europe/Moscow', day: 'numeric', month: 'long',
    });
    return `${time} ${day}`;
  };

  return `Сводка за период с ${part(from)} до ${part(to)}`;
}

/**
 * Короткая выжимка для строки в списке уведомлений.
 *
 * Первый пункт первого продуктового раздела: в списке у уведомления одна
 * строка, и полотно там не нужно — полный текст открывается по клику.
 */
export function digestPreview(summary: string): string {
  const sections = parseDigest(summary);
  const first = sections.find((s) => s.kind === 'portal') ?? sections[0];
  const text = first?.items[0] ?? '';
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}
