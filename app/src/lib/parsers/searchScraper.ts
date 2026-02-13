
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import type { Dispatcher } from 'undici';
import type { Browser } from 'playwright';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function isPlaywrightEnabled() {
  return process.env.SEARCH_PLAYWRIGHT_ENABLED === '1';
}

function playwrightTimeoutMs() {
  // Default a bit higher because Playwright is used as a fallback path (blocked/202),
  // and slow proxies / first browser launch can exceed 25s.
  return Number(process.env.SEARCH_PLAYWRIGHT_TIMEOUT_MS ?? '45000') || 45000;
}

function playwrightHeadless() {
  return process.env.SEARCH_PLAYWRIGHT_HEADLESS !== '0';
}

function playwrightReuseBrowser() {
  return process.env.SEARCH_PLAYWRIGHT_REUSE_BROWSER !== '0';
}

let SEARCH_PROXY_DISPATCHER: Dispatcher | undefined | null = null;

async function getSearchProxyDispatcher(): Promise<Dispatcher | undefined> {
  if (SEARCH_PROXY_DISPATCHER !== null) return SEARCH_PROXY_DISPATCHER ?? undefined;

  const proxyUrl = (process.env.SEARCH_PROXY_URL?.trim() || process.env.HH_PROXY_URL?.trim()) ?? '';
  if (!proxyUrl) {
    SEARCH_PROXY_DISPATCHER = undefined;
    return undefined;
  }

  try {
    // Lazy import to avoid loading undici internals in Jest environment
    const mod = await import('undici');
    const dispatcher = new mod.ProxyAgent(proxyUrl) as unknown as Dispatcher;
    SEARCH_PROXY_DISPATCHER = dispatcher;
    return dispatcher;
  } catch {
    SEARCH_PROXY_DISPATCHER = undefined;
    return undefined;
  }
}

let playwrightBrowserPromise: Promise<unknown> | null = null;

async function fetchHtmlWithPlaywright(url: string): Promise<{ html: string; finalUrl: string }> {
  if (!isPlaywrightEnabled()) {
    throw new Error('Playwright is disabled (SEARCH_PLAYWRIGHT_ENABLED!=1)');
  }

  // Lazy import so tests/build don’t eagerly load Playwright.
  const pw = await import('playwright');
  const proxyUrl = (process.env.SEARCH_PROXY_URL?.trim() || process.env.HH_PROXY_URL?.trim()) ?? '';
  const userAgent = getRandomUserAgent();
  const timeoutMs = playwrightTimeoutMs();

  const launch = async () =>
    pw.chromium.launch({
      headless: playwrightHeadless(),
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    });

  let browser: Browser;
  try {
    browser = playwrightReuseBrowser()
      ? await (playwrightBrowserPromise ?? (playwrightBrowserPromise = launch()))
      : await launch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Executable doesn't exist") || msg.includes('playwright install')) {
      throw new Error(
        'Playwright браузер не установлен. Запусти `npx playwright install chromium` в папке `app/` (или просто `npm install`, если postinstall включён).',
      );
    }
    throw e;
  }

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1365, height: 768 },
    locale: 'ru-RU',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  // Speed up and reduce flakiness: we only need HTML, not images/fonts/media.
  await page.route('**/*', async (route: { request: () => { resourceType: () => string }; abort: () => Promise<void>; continue: () => Promise<void> }) => {
    try {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        await route.abort();
        return;
      }
    } catch {
      // ignore
    }
    await route.continue();
  });
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (e) {
      // Some environments hang on domcontentloaded even though HTML is already available.
      // If we can read meaningful HTML, continue; otherwise retry with a lighter waitUntil.
      const isTimeout = e instanceof Error && e.name === 'TimeoutError';
      if (!isTimeout) throw e;

      const html = await page.content().catch(() => '');
      const finalUrl = page.url();
      if (html && html.length > 200) {
        return { html, finalUrl };
      }

      await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
    }
    // Give client-side rendering / interstitials a moment.
    await page.waitForTimeout(900 + Math.round(Math.random() * 900));
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    if (!playwrightReuseBrowser()) {
      await browser.close().catch(() => {});
    }
  }
}

export interface SearchResultItem {
  query: string;
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export type SearchProvider = 'google' | 'duckduckgo';

export function buildGoogleSearchUrl(
  query: string,
  opts?: { numResults?: number; hl?: string; gl?: string },
): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.max(10, Math.min(100, opts?.numResults ?? 10))));
  url.searchParams.set('hl', opts?.hl ?? 'ru');
  url.searchParams.set('gl', opts?.gl ?? 'ru');
  return url.toString();
}

export function buildDuckDuckGoSearchUrl(query: string): string {
  // Use "lite" endpoint: stable HTML and typically returns 200 for GET.
  // The "html" endpoint often responds with 202 and no results for server-side scraping.
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  return url.toString();
}

export class GoogleSearchError extends Error {
  code: 'blocked' | 'request_failed';

  constructor(code: 'blocked' | 'request_failed', message: string) {
    super(message);
    this.name = 'GoogleSearchError';
    this.code = code;
  }
}

export function isGoogleBlockedError(error: unknown): error is GoogleSearchError {
  return error instanceof GoogleSearchError && error.code === 'blocked';
}

export class DuckDuckGoSearchError extends Error {
  code: 'blocked' | 'request_failed';

  constructor(code: 'blocked' | 'request_failed', message: string) {
    super(message);
    this.name = 'DuckDuckGoSearchError';
    this.code = code;
  }
}

export function isDuckDuckGoBlockedError(error: unknown): error is DuckDuckGoSearchError {
  return error instanceof DuckDuckGoSearchError && error.code === 'blocked';
}

let cheerioModule: typeof import('cheerio') | null = null;

async function getCheerio(): Promise<typeof import('cheerio') | null> {
  if (cheerioModule) return cheerioModule;
  try {
    cheerioModule = await import('cheerio');
    return cheerioModule;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function extractGoogleRedirect(href: string): string {
  try {
    const parsed = new URL(href);
    if (parsed.hostname.includes('google.') && parsed.pathname === '/url') {
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (target) return target;
    }
  } catch {
    // ignore
  }
  return href;
}

function extractDuckDuckGoRedirect(href: string): string {
  try {
    // DDG may return absolute, protocol-relative (//...), or relative (/l/...) links.
    const parsed = new URL(href, 'https://duckduckgo.com');
    const host = parsed.hostname.toLowerCase();
    // DDG sometimes wraps outbound links as /l/?uddg=<encoded>
    if (host.includes('duckduckgo.com') && (parsed.pathname === '/l/' || parsed.pathname === '/l')) {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return uddg;
    }
  } catch {
    // ignore
  }
  return href;
}

function isSearchEngineHost(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host.includes('google.') ||
    host.includes('googleusercontent.com') ||
    host.includes('gstatic.com') ||
    host.includes('duckduckgo.com')
  );
}

export function detectGoogleBlockReason(html: string): string | null {
  const lower = html.toLowerCase();
  if (lower.includes('consent.google.com')) return 'Google consent required';
  // Google often returns an "enable JS" interstitial instead of SERP HTML.
  // In this case the page looks like a normal 200 response but contains no results.
  if (
    lower.includes('/httpservice/retry/enablejs') ||
    lower.includes('httpservice/retry/enablejs') ||
    (lower.includes('enablejs') && lower.includes('<noscript')) ||
    (lower.includes('enablejs') && lower.includes('google') && lower.includes('http-equiv="refresh"'))
  ) {
    return 'Google blocked the request (requires JavaScript: enablejs)';
  }
  if (lower.includes('/sorry/') || lower.includes('captcha')) return 'Google blocked the request (captcha)';
  if (lower.includes('g-recaptcha') || lower.includes('recaptcha')) return 'Google blocked the request (recaptcha)';
  if (lower.includes('unusual traffic') || lower.includes('detected unusual traffic')) {
    return 'Google blocked the request (unusual traffic)';
  }
  if (lower.includes('before you continue') && lower.includes('google')) {
    return 'Google consent/redirect page (before you continue)';
  }
  if (lower.includes('enable cookies') && lower.includes('google')) return 'Google requires cookies';
  if (lower.includes('прежде чем перейти') && lower.includes('google')) return 'Google consent required (ru)';
  if (lower.includes('включите') && lower.includes('cookie') && lower.includes('google')) return 'Google requires cookies (ru)';
  return null;
}

type GoogleSearchDebugInfo = {
  request_url: string;
  final_url: string;
  status: number;
  title: string | null;
  block_reason: string | null;
  container_count: number;
  h3_count: number;
  anchor_with_h3_count: number;
  html_snippet: string;
};

type DuckDuckGoSearchDebugInfo = {
  request_url: string;
  final_url: string;
  status: number;
  title: string | null;
  block_reason: string | null;
  result_count: number;
  html_snippet: string;
};

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return stripHtml(match[1]).slice(0, 200) || null;
}

function compressHtmlSnippet(html: string, maxLen = 600) {
  const text = html.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function detectGoogleBlockReasonByUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.includes('consent.google.com')) return 'Google consent required (redirect)';
    if (path.includes('/sorry')) return 'Google blocked the request (sorry redirect)';
    if (path.includes('/httpservice/retry/enablejs') || path.includes('/sorry/index')) {
      return 'Google blocked the request (requires JavaScript: enablejs redirect)';
    }
    if (parsed.searchParams.has('enablejs')) {
      return 'Google blocked the request (requires JavaScript: enablejs param)';
    }
  } catch {
    // ignore
  }
  return null;
}

async function extractGoogleResultsWithStats(html: string, query: string) {
  const cheerio = await getCheerio();
  if (!cheerio) {
    const results = extractGoogleResultsFallback(html, query);
    return {
      results,
      stats: { container_count: 0, h3_count: 0, anchor_with_h3_count: 0 },
    };
  }

  const $ = cheerio.load(html);
  const containers = findResultContainers($);
  const anchorWithH3Count = containers
    .find('a[href]')
    .filter((_, el) => $(el).find('h3').length > 0)
    .length;

  const results = await extractGoogleResults(html, query);
  return {
    results,
    stats: {
      container_count: containers.length,
      h3_count: containers.find('h3').length,
      anchor_with_h3_count: anchorWithH3Count,
    },
  };
}

function findResultContainers($: CheerioAPI) {
  const scoped = $('#search');
  if (scoped.length > 0) {
    return scoped.find('div.g, div.MjjYud, div.tF2Cxc');
  }
  return $('div.g, div.MjjYud, div.tF2Cxc');
}

function resolveLink(rawHref: string) {
  if (!rawHref) return '';
  if (rawHref.startsWith('/')) return `https://www.google.com${rawHref}`;
  return rawHref;
}

function extractSnippet($el: Cheerio<AnyNode>) {
  const snippetSelectors = ['.VwiC3b', '.IsZvec', '.aCOpRe', 'span.st', 'div[data-sncf]'];
  for (const selector of snippetSelectors) {
    const text = $el.find(selector).first().text().trim();
    if (text) return text;
  }

  const clone = $el.clone();
  clone.find('h3, a, cite, .action-menu').remove();
  return clone.text().replace(/\s+/g, ' ').trim();
}

function stripHtml(text: string) {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractGoogleResultsFallback(html: string, query: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    const rawHref = match[1];
    const title = stripHtml(match[2]);
    if (!rawHref || !title) continue;
    const resolved = resolveLink(rawHref);
    try {
      const cleanedLink = extractGoogleRedirect(resolved);
      const validLink = normalizeUrl(cleanedLink);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) continue;
      const key = validLink.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const snippetSlice = html.slice(match.index, match.index + 2000);
      const snippetMatch = snippetSlice.match(/class=["'][^"']*VwiC3b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

      results.push({
        query,
        title,
        link: validLink,
        snippet,
        position: results.length + 1,
      });
    } catch {
      // Ignore invalid URLs
    }
  }

  return results;
}

export async function extractGoogleResults(html: string, query: string): Promise<SearchResultItem[]> {
  const cheerio = await getCheerio();
  if (!cheerio) {
    return extractGoogleResultsFallback(html, query);
  }

  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  findResultContainers($).each((_, element) => {
    const $el = $(element);
    // Google SERP often includes internal links; use the anchor that actually wraps an <h3>.
    const anchor = $el
      .find('a[href]')
      .filter((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#')) return false;
        return $(el).find('h3').length > 0;
      })
      .first();

    const title = anchor.find('h3').first().text().trim();
    let link = anchor.attr('href') || '';

    if (!title || !link) return;
    link = resolveLink(link);

    try {
      const cleanedLink = extractGoogleRedirect(link);
      const validLink = normalizeUrl(cleanedLink);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) return;
      const key = validLink.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        query,
        title,
        link: validLink,
        snippet: extractSnippet($el),
        position: results.length + 1,
      });
    } catch {
      // Ignore invalid URLs
    }
  });

  return results;
}

export async function extractDuckDuckGoResults(html: string, query: string): Promise<SearchResultItem[]> {
  const cheerio = await getCheerio();
  if (!cheerio) return extractDuckDuckGoResultsFallback(html, query);

  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  // "html" endpoint uses `.result__a`, "lite" uses `.result-link` (but keep a tolerant fallback too).
  // lite also commonly uses protocol-relative URLs (//duckduckgo.com/l/?uddg=...)
  const anchors = $('a.result__a[href], a.result-link[href], a[href*="uddg="]');

  anchors.each((_, element) => {
    if (results.length >= 100) return;
    const a = $(element);
    const title = a.text().trim();
    let href = a.attr('href') || '';
    if (!title || !href) return;

    try {
      // Normalize protocol-relative URLs
      if (href.startsWith('//')) href = `https:${href}`;
      href = extractDuckDuckGoRedirect(href);
      const validLink = normalizeUrl(href);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) return;
      const key = validLink.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const container = a.closest('.result, tr, .result__body, .results, body, table');
      const snippet =
        container.find('.result__snippet, .result__snippet--highlight, .result-snippet').first().text().trim() ||
        // lite often stores snippet in the next <tr> with `td.result-snippet`
        a.closest('tr').nextAll('tr').find('td.result-snippet').first().text().trim() ||
        '';

      results.push({
        query,
        title,
        link: validLink,
        snippet: snippet.replace(/\s+/g, ' ').trim(),
        position: results.length + 1,
      });
    } catch {
      // ignore invalid urls
    }
  });

  return results;
}

function extractDuckDuckGoResultsFallback(html: string, query: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  const anchorRegex =
    /<a[^>]+class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    if (results.length >= 100) break;
    const rawHref = match[1];
    const title = stripHtml(match[2]);
    if (!rawHref || !title) continue;

    try {
      const cleanedLink = extractDuckDuckGoRedirect(rawHref);
      const validLink = normalizeUrl(cleanedLink);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) continue;
      const key = validLink.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Best-effort snippet: look shortly after the anchor.
      const snippetSlice = html.slice(match.index, match.index + 2000);
      const snippetMatch = snippetSlice.match(
        /class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i,
      );
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

      results.push({
        query,
        title,
        link: validLink,
        snippet,
        position: results.length + 1,
      });
    } catch {
      // ignore invalid urls
    }
  }

  return results;
}

/**
 * Perform a Google search for the given query and return parsed results.
 * This uses direct scraping and is subject to rate limits and blocking.
 */
export async function googleSearch(query: string, numResults = 10): Promise<SearchResultItem[]> {
  const detailed = await googleSearchDetailed(query, numResults);
  return detailed.results;
}

export async function duckDuckGoSearch(query: string): Promise<SearchResultItem[]> {
  const detailed = await duckDuckGoSearchDetailed(query);
  return detailed.results;
}

export async function googleSearchDetailed(query: string, numResults = 10): Promise<{
  results: SearchResultItem[];
  debug: GoogleSearchDebugInfo;
}> {
  const requestUrl = buildGoogleSearchUrl(query, { numResults, hl: 'ru', gl: 'ru' });

  // Random delay before request to reduce bot detection
  await sleep(1000 + Math.random() * 2000);

  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  try {
    const dispatcher = await getSearchProxyDispatcher();
    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      method: 'GET',
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    };
    const response = await fetch(requestUrl, fetchInit);

    if (!response.ok) {
      if (response.status === 429) {
        throw new GoogleSearchError('blocked', 'Google blocking: Too Many Requests (429)');
      }
      throw new GoogleSearchError('request_failed', `Google search failed with status ${response.status}`);
    }

    const blockedByUrl = detectGoogleBlockReasonByUrl(response.url);
    const html = await response.text();
    const blockReason = blockedByUrl ?? detectGoogleBlockReason(html);
    if (blockReason) {
      if (isPlaywrightEnabled()) {
        try {
          const pw = await fetchHtmlWithPlaywright(requestUrl);
          const pwBlockReason = detectGoogleBlockReason(pw.html);
          if (pwBlockReason) throw new GoogleSearchError('blocked', pwBlockReason);
          const title = extractTitle(pw.html);
          const { results, stats } = await extractGoogleResultsWithStats(pw.html, query);
          return {
            results,
            debug: {
              request_url: requestUrl,
              final_url: pw.finalUrl,
              status: 200,
              title,
              block_reason: null,
              container_count: stats.container_count,
              h3_count: stats.h3_count,
              anchor_with_h3_count: stats.anchor_with_h3_count,
              html_snippet: compressHtmlSnippet(pw.html),
            },
          };
        } catch {
          // If Playwright is not ready (browser missing), fall back to the original blocked error.
          throw new GoogleSearchError('blocked', blockReason);
        }
      }
      throw new GoogleSearchError('blocked', blockReason);
    }

    const title = extractTitle(html);
    const { results, stats } = await extractGoogleResultsWithStats(html, query);

    return {
      results,
      debug: {
        request_url: requestUrl,
        final_url: response.url,
        status: response.status,
        title,
        block_reason: null,
        container_count: stats.container_count,
        h3_count: stats.h3_count,
        anchor_with_h3_count: stats.anchor_with_h3_count,
        html_snippet: compressHtmlSnippet(html),
      },
    };
  } catch (error) {
    // This error is expected in production-like environments where Google blocks scraping.
    // Avoid spamming logs for "blocked" errors — callers can decide how to handle them.
    if (!(error instanceof GoogleSearchError && error.code === 'blocked')) {
      console.error('Google search error:', error);
    }
    throw error;
  }
}

export async function duckDuckGoSearchDetailed(query: string): Promise<{
  results: SearchResultItem[];
  debug: DuckDuckGoSearchDebugInfo;
}> {
  const requestUrl = buildDuckDuckGoSearchUrl(query);

  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  // Light jitter + retries to reduce 202/429 bursts.
  // DDG sometimes returns 202 for bot-like traffic; a short backoff often fixes it.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Jitter between attempts, but keep first attempt fast.
    if (attempt > 0) {
      const backoffMs = 600 * 2 ** (attempt - 1) + Math.round(Math.random() * 350);
      await sleep(backoffMs);
    } else {
      await sleep(250 + Math.round(Math.random() * 250));
    }

    try {
      const dispatcher = await getSearchProxyDispatcher();
      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'GET',
        headers,
        ...(dispatcher ? { dispatcher } : {}),
      };
      const response = await fetch(requestUrl, fetchInit);
      if (!response.ok) {
        if (response.status === 429) {
          if (attempt < 2) continue;
          throw new DuckDuckGoSearchError('blocked', 'DuckDuckGo blocking: Too Many Requests (429)');
        }
        throw new DuckDuckGoSearchError('request_failed', `DuckDuckGo search failed with status ${response.status}`);
      }

      // DDG sometimes returns 202 + a shell page without results for bot-like traffic.
      if (response.status === 202) {
        if (isPlaywrightEnabled()) {
          try {
            const pw = await fetchHtmlWithPlaywright(requestUrl);
            const results = await extractDuckDuckGoResults(pw.html, query);
            return {
              results,
              debug: {
                request_url: requestUrl,
                final_url: pw.finalUrl,
                status: 200,
                title: extractTitle(pw.html),
                block_reason: null,
                result_count: results.length,
                html_snippet: compressHtmlSnippet(pw.html),
              },
            };
          } catch (e) {
            console.warn('DuckDuckGo Playwright fallback failed:', e);
          }
        }
        if (attempt < 2) continue;
        throw new DuckDuckGoSearchError('blocked', 'DuckDuckGo blocked the request (202)');
      }

      const html = await response.text();
      const title = extractTitle(html);
      const lower = html.toLowerCase();
      const blockReason =
        lower.includes('access denied') || lower.includes('blocked') || lower.includes('captcha')
          ? 'DuckDuckGo blocked the request'
          : null;
      if (blockReason) {
        if (attempt < 2) continue;
        throw new DuckDuckGoSearchError('blocked', blockReason);
      }

      const results = await extractDuckDuckGoResults(html, query);

      return {
        results,
        debug: {
          request_url: requestUrl,
          final_url: response.url,
          status: response.status,
          title,
          block_reason: null,
          result_count: results.length,
          html_snippet: compressHtmlSnippet(html),
        },
      };
    } catch (error) {
      // Only log non-blocking unexpected failures; blocking can be common and handled upstream.
      if (!(error instanceof DuckDuckGoSearchError && error.code === 'blocked')) {
        console.error('DuckDuckGo search error:', error);
      }
      // Retry only on DDG blocking; rethrow otherwise.
      if (error instanceof DuckDuckGoSearchError && error.code === 'blocked' && attempt < 2) {
        continue;
      }

      // Last chance: Playwright fallback for 202/blocked pages
      if (isPlaywrightEnabled() && error instanceof DuckDuckGoSearchError && error.code === 'blocked') {
        try {
          const pw = await fetchHtmlWithPlaywright(requestUrl);
          const results = await extractDuckDuckGoResults(pw.html, query);
          return {
            results,
            debug: {
              request_url: requestUrl,
              final_url: pw.finalUrl,
              status: 200,
              title: extractTitle(pw.html),
              block_reason: null,
              result_count: results.length,
              html_snippet: compressHtmlSnippet(pw.html),
            },
          };
        } catch (e) {
          console.warn('DuckDuckGo Playwright fallback failed (last chance):', e);
        }
      }

      throw error;
    }
  }

  // Should be unreachable because loop either returns or throws.
  throw new DuckDuckGoSearchError('request_failed', 'DuckDuckGo search failed (unexpected)');
}
