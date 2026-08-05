/**
 * Кодовая пост-верификация доказательств гипотез (стадия evidence).
 *
 * УТП инструмента — «доказательства, с которыми не поспоришь». Промпт
 * требует URL только из скачанных источников и дословную цитату, но без
 * проверки в коде это декларация: модель может сочинить источник/цитату,
 * и никто не поймает. Здесь каждое доказательство сверяется с реально
 * скачанным текстом: URL обязан быть среди fetched-источников, цитата —
 * подстрокой его текста (после нормализации пробелов/регистра).
 */

import type { HeEvidenceItem } from './types';

export interface HeFetchedSource {
  url: string;
  text: string;
}

/** Нормализация для подстрочного матча: регистр + любые пробельные серии. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** URL-ключ: регистр хоста, без trailing slash и якоря. */
function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!s) return '';
  try {
    const url = new URL(s.includes('://') ? s : `https://${s}`);
    url.hash = '';
    s = url.toString();
  } catch {
    // кривой URL — матчим как есть после грубой чистки
  }
  return s.toLowerCase().replace(/\/+$/, '');
}

/** Цитата короче порога — не доказательство (слишком легко «угадать»). */
const MIN_QUOTE_CHARS = 12;

export interface HeEvidenceVerification {
  valid: HeEvidenceItem[];
  /** Сколько пунктов отброшено (URL не из скачанных или цитата не найдена). */
  dropped: number;
}

/**
 * Отфильтровать доказательства, не подтверждённые скачанными источниками.
 * Пустой sources (поиск/фетч ничего не дал) → всё отбрасывается.
 */
export function verifyEvidenceItems(
  items: HeEvidenceItem[],
  sources: HeFetchedSource[],
): HeEvidenceVerification {
  const textByUrl = new Map<string, string>();
  for (const s of sources) {
    textByUrl.set(normalizeUrl(s.url), normalizeForMatch(s.text));
  }
  const valid: HeEvidenceItem[] = [];
  let dropped = 0;
  for (const item of items ?? []) {
    const sourceText = textByUrl.get(normalizeUrl(item?.source_url ?? ''));
    const quote = normalizeForMatch(item?.quote ?? '');
    if (!sourceText || quote.length < MIN_QUOTE_CHARS || !sourceText.includes(quote)) {
      dropped += 1;
      continue;
    }
    valid.push(item);
  }
  return { valid, dropped };
}
