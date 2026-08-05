import { domainToUnicode } from 'node:url';

/**
 * Нормализация сайта клиента: «example.com» → «https://example.com/».
 * Проверка минимальная (протокол http/https + валидный hostname с точкой) —
 * реальная доступность сайта выяснится воркером на стадии site_profile.
 *
 * Вынесено из api/tools/hypothesis-engine/projects/route.ts: та же
 * нормализация нужна клиентскому ENG-контуру (api/client/eng/projects).
 */
export function normalizeWebsiteInput(raw: string): { url: string; hostname: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)) return null;
  if (!hostname.includes('.') || hostname.includes('..')) return null;
  // IDN-домены (например кириллические .рф) храним в Unicode, а не в punycode
  // («xn--…») — иначе закодированный вид торчит в интерфейсе, имени проекта
  // по умолчанию и в промптах. Фетч воркера сам перекодирует при запросе.
  const unicodeHostname = domainToUnicode(hostname) || hostname;
  const url =
    unicodeHostname === hostname
      ? parsed.href
      : `${parsed.protocol}//${unicodeHostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return { url, hostname: unicodeHostname };
}
