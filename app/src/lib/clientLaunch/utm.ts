/**
 * UTM-метки для ссылок в письмах клиентских кампаний.
 *
 * Письма уходят plain-text (HTML запрещён), поэтому «ссылка» — это просто
 * текст URL. appendUtm дописывает к URL utm_*-параметры; EmailBodyField
 * подставляет результат прямо в текст письма вместо выделенного фрагмента.
 */

export interface UtmParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

/** Порядок, в котором utm-параметры дописываются в query (предсказуемый вид). */
const UTM_ORDER: (keyof UtmParams)[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
];

/**
 * Похоже ли значение на ссылку: непустое, без пробелов, домен с точкой.
 * Голый домен (без http) считается ссылкой — протокол добавит appendUtm.
 */
export function looksLikeUrl(raw: string): boolean {
  const s = (raw ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withProtocol).hostname.includes('.');
  } catch {
    return false;
  }
}

/**
 * Дописывает UTM-параметры к URL.
 *  - голый домен (polzaagency.ru) дополняется до https://;
 *  - уже существующая query-строка сохраняется (новые параметры — через &);
 *  - пустые параметры пропускаются;
 *  - если строка не парсится как URL — возвращается без изменений.
 */
export function appendUtm(rawUrl: string, params: UtmParams): string {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return trimmed;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return rawUrl;
  }

  for (const key of UTM_ORDER) {
    const value = (params[key] ?? '').trim();
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}
