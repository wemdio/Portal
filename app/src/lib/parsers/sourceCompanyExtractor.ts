import * as cheerio from 'cheerio';
import type { Dispatcher } from 'undici';
import { normalizeUrl } from '@/lib/enrich/urlUtils';

type ExtractedCompanySite = {
  site: string; // canonical origin: https://example.com/
  link: string; // a concrete page url we found
  title: string | null; // anchor text or best-effort label
  source_url: string; // which page produced it
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = Number(process.env.SEARCH_SOURCE_EXPAND_TIMEOUT_MS ?? '10000') || 10000;
const DEFAULT_MAX_INTERNAL_PAGES = Number(process.env.SEARCH_SOURCE_EXPAND_MAX_INTERNAL_PAGES ?? '20') || 20;
const DEFAULT_MAX_SITES_PER_SOURCE = Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SITES_PER_SOURCE ?? '80') || 80;

const SKIP_HOSTS = [
  // social / messengers
  't.me',
  'telegram.me',
  'vk.com',
  'ok.ru',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'youtu.be',
  // search engines
  'google.com',
  'yandex.ru',
  'ya.ru',
  'duckduckgo.com',
  'bing.com',
  // generic docs / storage
  'drive.google.com',
  'docs.google.com',
  'dropbox.com',
];

let SEARCH_PROXY_DISPATCHER: Dispatcher | undefined | null = null;

async function getSearchProxyDispatcher(): Promise<Dispatcher | undefined> {
  if (SEARCH_PROXY_DISPATCHER !== null) return SEARCH_PROXY_DISPATCHER ?? undefined;
  const proxyUrl = (process.env.SEARCH_PROXY_URL?.trim() || process.env.HH_PROXY_URL?.trim()) ?? '';
  if (!proxyUrl) {
    SEARCH_PROXY_DISPATCHER = undefined;
    return undefined;
  }
  try {
    const mod = await import('undici');
    const dispatcher = new mod.ProxyAgent(proxyUrl) as unknown as Dispatcher;
    SEARCH_PROXY_DISPATCHER = dispatcher;
    return dispatcher;
  } catch {
    SEARCH_PROXY_DISPATCHER = undefined;
    return undefined;
  }
}

function canonicalSiteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host || !host.includes('.')) return null;
    return `https://${host}/`;
  } catch {
    return null;
  }
}

function isSkippableTarget(parsedUrl: URL): boolean {
  const host = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
  if (SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // file links
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)(\?|#|$)/i.test(parsedUrl.pathname)) return true;
  return false;
}

function looksLikeInternalCompanyPage(href: string): boolean {
  const h = href.toLowerCase();
  return (
    /(company|companies|organization|org|profile|card|participant|exhibitor|catalog|directory|registry|reestr|reest|firm|supplier|vendors?)/i.test(
      h,
    ) ||
    /(компан|организац|предприят|участник|профил|карточк|каталог|реестр|поставщик)/i.test(h)
  );
}

async function fetchHtml(
  url: string,
  timeoutMs: number,
  /** Внешняя отмена (остановка воркера / потеря аренды). */
  signal?: AbortSignal,
): Promise<{ html: string; finalUrl: string; status: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Свой контроллер нужен для таймаута, поэтому внешний сигнал не заменяет его,
  // а ПОДВЯЗЫВАЕТСЯ: отмена снаружи обрывает запрос так же, как таймаут.
  // AbortSignal не переигрывает уже случившуюся отмену для поздних слушателей —
  // поэтому сперва проверка, и только потом подписка.
  if (signal?.aborted) controller.abort();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const dispatcher = await getSearchProxyDispatcher();
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      redirect: 'follow',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    };
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (ct && !(ct.includes('text/html') || ct.includes('application/xhtml') || ct.includes('application/xml') || ct.startsWith('text/plain'))) {
      return null;
    }
    const html = await res.text();
    return { html, finalUrl: res.url, status: res.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

function extractSitesFromHtml(html: string, baseUrl: string, sourceUrl: string): { external: ExtractedCompanySite[]; internal: string[] } {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const origin = base.origin;

  const external: ExtractedCompanySite[] = [];
  const internal: string[] = [];
  const seenLinks = new Set<string>();

  $('a[href]').each((_, el) => {
    const rawHref = ($(el).attr('href') ?? '').trim();
    if (!rawHref) return;
    if (/^(#|mailto:|tel:|javascript:)/i.test(rawHref)) return;

    let abs: string;
    try {
      abs = new URL(rawHref, baseUrl).href;
    } catch {
      return;
    }
    // Strip fragment for dedupe
    const linkKey = abs.replace(/#.*$/, '');
    if (seenLinks.has(linkKey)) return;
    seenLinks.add(linkKey);

    let parsed: URL;
    try {
      parsed = new URL(abs);
    } catch {
      return;
    }

    const host = parsed.hostname;
    if (!host) return;
    if (isSkippableTarget(parsed)) return;

    const title = ($(el).text() ?? '').trim().replace(/\s+/g, ' ').slice(0, 160) || null;
    const isSameOrigin = parsed.origin === origin;

    if (!isSameOrigin) {
      try {
        const normalized = normalizeUrl(abs);
        const site = canonicalSiteOrigin(normalized);
        if (!site) return;
        external.push({ site, link: normalized, title, source_url: sourceUrl });
      } catch {
        return;
      }
      return;
    }

    if (looksLikeInternalCompanyPage(parsed.href)) {
      internal.push(parsed.href);
    }
  });

  return { external, internal };
}

export async function extractCompanySitesFromSource(
  sourcePageUrl: string,
  opts?: { timeoutMs?: number; maxInternalPages?: number; maxSites?: number; signal?: AbortSignal },
): Promise<{ sites: ExtractedCompanySite[]; debug: { fetched: string[]; internalQueued: number } }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts?.signal;
  const maxInternalPages = Math.max(0, Math.min(40, opts?.maxInternalPages ?? DEFAULT_MAX_INTERNAL_PAGES));
  const maxSites = Math.max(1, Math.min(400, opts?.maxSites ?? DEFAULT_MAX_SITES_PER_SOURCE));

  const fetched: string[] = [];
  const uniqueBySite = new Map<string, ExtractedCompanySite>();

  const main = await fetchHtml(sourcePageUrl, timeoutMs, signal);
  if (!main?.html) {
    return { sites: [], debug: { fetched, internalQueued: 0 } };
  }
  fetched.push(main.finalUrl);

  const mainExtracted = extractSitesFromHtml(main.html, main.finalUrl, main.finalUrl);
  for (const item of mainExtracted.external) {
    if (uniqueBySite.size >= maxSites) break;
    if (!uniqueBySite.has(item.site)) uniqueBySite.set(item.site, item);
  }

  const internalCandidates = mainExtracted.internal
    .filter(Boolean)
    .slice(0, maxInternalPages);

  // Follow a small number of internal "card/profile" pages to find the actual company site links.
  for (const u of internalCandidates) {
    if (uniqueBySite.size >= maxSites) break;
    // Обход внутренних страниц последовательный и длинный (до 40 штук), так что
    // отмену проверяем на каждом шаге, а не только внутри самого запроса.
    if (signal?.aborted) break;
    const page = await fetchHtml(u, timeoutMs, signal);
    if (!page?.html) continue;
    fetched.push(page.finalUrl);
    const extracted = extractSitesFromHtml(page.html, page.finalUrl, main.finalUrl);
    for (const item of extracted.external) {
      if (uniqueBySite.size >= maxSites) break;
      if (!uniqueBySite.has(item.site)) uniqueBySite.set(item.site, item);
    }
  }

  return {
    sites: Array.from(uniqueBySite.values()),
    debug: { fetched, internalQueued: internalCandidates.length },
  };
}

