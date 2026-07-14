// com\.tr ДО com: альтернация ищет по порядку, иначе для yandex.com.tr
// матчится только «com» и получается битый «yandex.ru.tr». Актуально для
// прокси с турецким выходом — Яндекс редиректит их на yandex.com.tr.
const YANDEX_DOMAIN_REGEX = /^https?:\/\/yandex\.(by|kz|ua|com\.tr|com)\b/i;

export function normalizeYandexOrgUrl(rawUrl: string): string {
  const input = (rawUrl ?? '').trim();
  if (!input) return '';

  const url = input.replace(YANDEX_DOMAIN_REGEX, 'https://yandex.ru');

  const mapsMatch = url.match(/(https:\/\/yandex\.ru\/maps\/org\/[^/]+\/\d+)/i);
  if (mapsMatch?.[1]) return `${mapsMatch[1]}/`;

  const orgMatch = url.match(/(https:\/\/yandex\.ru\/org\/[^/]+\/\d+)/i);
  if (orgMatch?.[1]) return `${orgMatch[1].replace('/org/', '/maps/org/')}/`;

  return url;
}

export function normalizeYandexOrgUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of urls ?? []) {
    const normalized = normalizeYandexOrgUrl(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

