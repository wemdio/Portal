/**
 * TASK 1.2 — Нормализация данных компании.
 * Очистка названия, приведение к единому формату, ключ для дедупликации.
 */

/** Организационно-правовые формы (аббревиатуры). Удаляем ТОЛЬКО как отдельные токены. */
const OPF_TOKENS = new Set([
  'ООО',
  'ОАО',
  'ЗАО',
  'ПАО',
  'АО',
  'ИП',
  'НП',
  'ЧП',
  'ФГУП',
  'ГУП',
  'МУП',
  'ОП',
]);
const QUOTES = /["«»""']/g;
const MULTI_SPACE = /\s+/g;
const TOKEN_EDGE_PUNCT = /^[\s().,;:]+|[\s().,;:]+$/g;

/**
 * Очищает и нормализует название компании:
 * - lowercase (опционально, по умолчанию false — для отображения оставляем как есть, для сравнения — true)
 * - удаление организационно-правовых форм (ООО, ЗАО, ОАО и т.д.)
 * - нормализация кавычек и пробелов
 */
export function normalizeCompanyName(
  raw: string | null | undefined,
  options: { lowercase?: boolean; stripOpf?: boolean } = {},
): string {
  const { lowercase = false, stripOpf = true } = options;
  let s = String(raw ?? '').trim();
  if (!s) return '';

  s = s.replace(QUOTES, ' ').replace(MULTI_SPACE, ' ').trim();
  if (stripOpf) {
    const tokens = s
      .split(' ')
      .map((t) => t.replace(TOKEN_EDGE_PUNCT, '').trim())
      .filter(Boolean)
      .filter((t) => !OPF_TOKENS.has(t.toUpperCase()));
    s = tokens.join(' ').replace(MULTI_SPACE, ' ').trim();
  }
  if (lowercase) s = s.toLowerCase();
  return s.trim();
}

/**
 * Ключ для дедупликации: нормализованное название в lowercase без ОПФ.
 * Используется для сравнения компаний по названию.
 */
export function companyDedupKey(name: string | null | undefined): string {
  return normalizeCompanyName(name, { lowercase: true, stripOpf: true });
}

/**
 * Проверка, что две компании по названию считаются одной и той же (по ключу дедупа).
 */
export function companyNamesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const keyA = companyDedupKey(a);
  const keyB = companyDedupKey(b);
  if (!keyA || !keyB) return false;
  return keyA === keyB;
}
