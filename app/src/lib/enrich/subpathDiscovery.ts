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
    pathPatterns: [
      /\/pricing\b/, /\/тариф/, /\/цены/, /\/цена/, /\/prices?\b/, /\/plans?\b/,
      /\/стоимость/, /\/cost\b/, /\/rates?\b/, /\/calculator\b/, /\/калькулятор/,
      /\/services?\b/, /\/услуги/,
    ],
    textPatterns: [
      /\bpricing\b/, /цены/, /цена/, /тариф/, /стоимость/, /\bplans?\b/,
      /прайс/, /расценки/, /калькулятор/, /сколько стоит/,
    ],
  },
  careers: {
    pathPatterns: [
      /\/careers?\b/, /\/jobs?\b/, /\/вакан/, /\/работа/, /\/join[-_]?us\b/,
      /\/vacancy/, /\/openings?\b/, /\/hiring\b/, /\/work[-_]?with[-_]?us/,
      /\/team\b/, /\/команда/,
    ],
    textPatterns: [
      /\bcareers?\b/, /вакан/, /\bjobs?\b/, /работа у нас/, /\bjoin our team\b/,
      /вакансии/, /мы нанимаем/, /we.?re hiring/, /открытые позиции/, /open positions/,
    ],
  },
  cases: {
    pathPatterns: [
      /\/cases?\b/, /\/case[-_]studies?\b/, /\/portfolio\b/, /\/customers?\b/,
      /\/clients?\b/, /\/кейсы?/, /\/клиент/, /\/истории/,
      /\/projects?\b/, /\/проект/, /\/works?\b/, /\/работы/,
      /\/success[-_]?stories?\b/, /\/results?\b/, /\/отзыв/,
    ],
    textPatterns: [
      /\bcases?\b/, /\bcase studies\b/, /\bcustomers\b/, /\bclients\b/, /\bportfolio\b/,
      /кейсы/, /клиенты/, /истории успеха/, /наши клиенты/, /наши работы/,
      /проекты/, /портфолио/, /\bour work\b/, /результаты/, /нам доверяют/,
    ],
  },
  integrations: {
    pathPatterns: [
      /\/integrations?\b/, /\/интеграц/, /\/partners?\b/, /\/партн/,
      /\/apps?\b/, /\/marketplace\b/, /\/connectors?\b/, /\/ecosystem\b/,
      /\/api\b/, /\/подключен/,
    ],
    textPatterns: [
      /\bintegrations?\b/, /интеграции/, /\bpartners?\b/, /партнёры/, /партнеры/,
      /подключения/, /экосистема/, /совместимость/, /\bapps?\b/, /\bconnectors?\b/,
    ],
  },
  about: {
    pathPatterns: [
      /\/about\b/, /\/о[-_]?нас/, /\/о[-_]?компании/, /\/company\b/, /\/team\b/, /\/команда/,
      /\/who[-_]?we[-_]?are/, /\/our[-_]?story/, /\/история/,
    ],
    textPatterns: [
      /\babout\b/, /о нас/, /о компании/, /\bcompany\b/, /команда/, /\bteam\b/,
      /кто мы/, /наша история/, /\bour story\b/,
    ],
  },
  blog: {
    pathPatterns: [
      /\/blog\b/, /\/news\b/, /\/новости/, /\/press\b/, /\/медиа/,
      /\/articles?\b/, /\/статьи/, /\/journal\b/, /\/insights?\b/,
      /\/posts?\b/, /\/публикации/,
    ],
    textPatterns: [
      /\bblog\b/, /новости/, /\bnews\b/, /пресс/, /статьи/, /\barticles?\b/,
      /\binsights?\b/, /публикации/, /\bjournal\b/,
    ],
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

/**
 * Well-known paths to try via direct HEAD request when link discovery fails.
 * Ordered by likelihood — first match wins.
 */
export const FALLBACK_PATHS: Record<SubpageKind, string[]> = {
  pricing: ['/pricing', '/prices', '/tariffs', '/plans'],
  careers: ['/careers', '/jobs', '/vacancies'],
  cases: ['/cases', '/portfolio', '/clients', '/projects', '/works'],
  integrations: ['/integrations', '/partners', '/apps'],
  about: ['/about', '/company', '/about-us'],
  blog: ['/blog', '/news', '/articles'],
};
