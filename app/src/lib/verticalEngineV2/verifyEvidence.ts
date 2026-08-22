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

import type { VeEvidenceItem } from './types';

export interface VeFetchedSource {
  url: string;
  text: string;
}

/** Нормализация для подстрочного матча: регистр, пробелы, типографика
 *  (модель при цитировании часто меняет «ёлочки»/тире/апострофы). */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[«»„“”«»]/g, '"')
    .replace(/[‘’`]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * Цитата найдена в тексте источника? Промпт разрешает сокращение многоточием
 * («начало … конец») — такие цитаты проверяем по фрагментам: каждый фрагмент
 * (≥8 символов) обязан быть подстрокой текста.
 */
function quoteMatchesSource(quoteNorm: string, sourceNorm: string): boolean {
  if (sourceNorm.includes(quoteNorm)) return true;
  if (!quoteNorm.includes('…') && !quoteNorm.includes('...')) return false;
  const fragments = quoteNorm
    .split(/…|\.\.\./)
    .map((f) => f.trim())
    .filter((f) => f.length >= 8);
  return fragments.length > 0 && fragments.every((f) => sourceNorm.includes(f));
}

export interface VeEvidenceVerification {
  valid: VeEvidenceItem[];
  /** Сколько пунктов отброшено (URL не из скачанных или цитата не найдена). */
  dropped: number;
}

/**
 * Отфильтровать доказательства, не подтверждённые скачанными источниками.
 * Пустой sources (поиск/фетч ничего не дал) → всё отбрасывается.
 */
export function verifyEvidenceItems(
  items: VeEvidenceItem[],
  sources: VeFetchedSource[],
): VeEvidenceVerification {
  const textByUrl = new Map<string, string>();
  for (const s of sources) {
    textByUrl.set(normalizeUrl(s.url), normalizeForMatch(s.text));
  }
  const valid: VeEvidenceItem[] = [];
  let dropped = 0;
  for (const item of items ?? []) {
    const sourceText = textByUrl.get(normalizeUrl(item?.source_url ?? ''));
    const quote = normalizeForMatch(item?.quote ?? '');
    if (!sourceText || quote.length < MIN_QUOTE_CHARS || !quoteMatchesSource(quote, sourceText)) {
      dropped += 1;
      continue;
    }
    valid.push(item);
  }
  return { valid, dropped };
}
