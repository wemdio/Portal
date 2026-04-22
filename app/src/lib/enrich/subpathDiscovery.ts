import * as cheerio from 'cheerio';
import { SubpageKind } from './extractors/types';

/**
 * Discover canonical subpage URLs from the main HTML for each requested kind.
 *
 * Strategy: scan all <a href="..."> links on the page. For each link, we look
 * at BOTH the URL path (decoded) AND the anchor text against per-kind
 * EN+RU keyword patterns. The first same-domain match wins.
 *
 * External, hash-only, javascript:, and pure query-string links are ignored.
 */

interface KindMatcher {
  /** Match against decoded URL path (lowercase) — strongest signal. */
  pathPatterns: RegExp[];
  /** Match against anchor text content (lowercase, trimmed). */
  textPatterns: RegExp[];
}

const MATCHERS: Record<SubpageKind, KindMatcher> = {
  pricing: {
    pathPatterns: [/\/pricing\b/, /\/тариф/, /\/цены/, /\/цена/, /\/prices?\b/, /\/plans?\b/],
    textPatterns: [/\bpricing\b/, /цены/, /цена/, /тариф/, /стоимость/, /\bplans\b/],
  },
  careers: {
    pathPatterns: [/\/careers?\b/, /\/jobs?\b/, /\/вакан/, /\/работа/, /\/join[-_]?us\b/],
    textPatterns: [/\bcareers?\b/, /вакан/, /\bjobs?\b/, /работа у нас/, /\bjoin our team\b/, /вакансии/],
  },
  cases: {
    pathPatterns: [
      /\/cases?\b/, /\/case[-_]studies?\b/, /\/portfolio\b/, /\/customers?\b/,
      /\/clients?\b/, /\/кейсы?/, /\/клиент/, /\/истории/,
    ],
    textPatterns: [
      /\bcases\b/, /\bcase studies\b/, /\bcustomers\b/, /\bclients\b/, /\bportfolio\b/,
      /кейсы/, /клиенты/, /истории успеха/, /наши клиенты/,
    ],
  },
  integrations: {
    pathPatterns: [/\/integrations?\b/, /\/интеграц/, /\/partners?\b/, /\/партн/],
    textPatterns: [/\bintegrations?\b/, /интеграции/, /\bpartners\b/, /партнёры/, /партнеры/],
  },
  about: {
    pathPatterns: [/\/about\b/, /\/о[-_]?нас/, /\/о[-_]?компании/, /\/company\b/, /\/team\b/, /\/команда/],
    textPatterns: [/\babout\b/, /о нас/, /о компании/, /\bcompany\b/, /команда/, /\bteam\b/],
  },
  blog: {
    pathPatterns: [/\/blog\b/, /\/news\b/, /\/новости/, /\/press\b/, /\/медиа/],
    textPatterns: [/\bblog\b/, /новости/, /\bnews\b/, /пресс/],
  },
};

/**
 * @param html - raw HTML of the main page
 * @param baseUrl - normalized base URL (e.g. "https://example.com")
 * @param requested - which kinds to look for; only these will be returned
 */
export function discoverSubpaths(
  html: string,
  baseUrl: string,
  requested: SubpageKind[],
): Partial<Record<SubpageKind, string>> {
  if (!html || requested.length === 0) return {};

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return {};
  }

  const $ = cheerio.load(html);
  const result: Partial<Record<SubpageKind, string>> = {};
  const remaining = new Set(requested);

  $('a[href]').each((_, el) => {
    if (remaining.size === 0) return false;

    const rawHref = $(el).attr('href') ?? '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
    if (rawHref.startsWith('?')) return;

    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      return;
    }

    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    if (abs.host !== base.host) return;
    if (!abs.pathname || abs.pathname === '/') return;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(abs.pathname).toLowerCase();
    } catch {
      decodedPath = abs.pathname.toLowerCase();
    }
    const text = $(el).text().toLowerCase().trim();

    for (const kind of remaining) {
      const matcher = MATCHERS[kind];
      const pathHit = matcher.pathPatterns.some((re) => re.test(decodedPath));
      const textHit = matcher.textPatterns.some((re) => re.test(text));
      if (pathHit || textHit) {
        result[kind] = abs.toString();
        remaining.delete(kind);
        break;
      }
    }
  });

  return result;
}
