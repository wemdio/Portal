
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import type { Dispatcher } from 'undici';
import type { Browser } from 'playwright';

import { SEARCH_CONFIG } from '@/lib/config';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function isPlaywrightEnabled() {
  return SEARCH_CONFIG.PLAYWRIGHT.ENABLED;
}

function playwrightTimeoutMs() {
  // Default a bit higher because Playwright is used as a fallback path (blocked/202),
  // and slow proxies / first browser launch can exceed 25s.
  return SEARCH_CONFIG.PLAYWRIGHT.TIMEOUT_MS;
}

function playwrightHeadless() {
  return SEARCH_CONFIG.PLAYWRIGHT.HEADLESS;
}

function playwrightReuseBrowser() {
  return SEARCH_CONFIG.PLAYWRIGHT.REUSE_BROWSER;
}

function playwrightObserveMs() {
  const raw = Number(SEARCH_CONFIG.PLAYWRIGHT.OBSERVE_MS ?? 0);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
}

const SEARCH_PROXY_DEBUG = Boolean(SEARCH_CONFIG.PROXY_DEBUG);

function normalizeProxyUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  // People often set HOST:PORT without scheme; both undici ProxyAgent and Playwright expect a URL.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  return `http://${s}`;
}

function redactProxyUrl(raw: string): string {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    // Best-effort fallback: strip credentials like user:pass@ if present
    return normalized.replace(/\/\/[^@/]+@/g, '//').replace(/\/$/, '');
  }
}

function toPlaywrightProxy(raw: string): { server: string; username?: string; password?: string } | undefined {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return undefined;
  try {
    const u = new URL(normalized);
    const username = u.username || undefined;
    const password = u.password || undefined;
    // Playwright expects creds as separate fields; keep server without credentials.
    u.username = '';
    u.password = '';
    const server = u.toString().replace(/\/$/, '');
    return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  } catch {
    // If URL parsing fails, fall back to plain server; creds won't be applied.
    return { server: normalized.replace(/\/$/, '') };
  }
}

function parseProxyList(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  // Preferred format: JSON array: ["http://user:pass@ip:port", "..."]
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((v) => normalizeProxyUrl(String(v ?? ''))).filter(Boolean);
      }
    } catch {
      // fall through to split parsing
    }
  }
  // Fallback: comma/semicolon/whitespace separated
  return s
    .split(/[,\n;\t ]+/g)
    .map((v) => normalizeProxyUrl(String(v ?? '')))
    .filter(Boolean);
}

function getSearchProxyUrls(): string[] {
  const listRaw = (process.env.SEARCH_PROXY_URLS ?? '').trim();
  const list = parseProxyList(listRaw);
  if (list.length) return list;
  const singleRaw = (process.env.SEARCH_PROXY_URL?.trim() || process.env.HH_PROXY_URL?.trim()) ?? '';
  const single = normalizeProxyUrl(singleRaw);
  return single ? [single] : [];
}

let proxyRoundRobin = 0;

function pickSearchProxyUrl(seed: number): string {
  const proxies = getSearchProxyUrls();
  if (!proxies.length) return '';
  // Deterministic-enough rotation per attempt + some round-robin between calls.
  proxyRoundRobin = (proxyRoundRobin + 1) % Number.MAX_SAFE_INTEGER;
  const idx = Math.abs(seed + proxyRoundRobin) % proxies.length;
  return proxies[idx] ?? '';
}

const SEARCH_PROXY_DISPATCHERS = new Map<string, Dispatcher>();

async function getSearchProxyDispatcher(proxyUrl: string): Promise<Dispatcher | undefined> {
  const key = proxyUrl.trim();
  if (!key) return undefined;
  const existing = SEARCH_PROXY_DISPATCHERS.get(key);
  if (existing) return existing;

  try {
    // Lazy import to avoid loading undici internals in Jest environment
    const mod = await import('undici');
    const dispatcher = new mod.ProxyAgent(key) as unknown as Dispatcher;
    SEARCH_PROXY_DISPATCHERS.set(key, dispatcher);
    return dispatcher;
  } catch {
    return undefined;
  }
}

let playwrightBrowserPromise: Promise<unknown> | null = null;

async function fetchHtmlWithPlaywright(url: string, proxyUrlOverride?: string): Promise<{ html: string; finalUrl: string }> {
  if (!isPlaywrightEnabled()) {
    throw new Error('Playwright is disabled (SEARCH_PLAYWRIGHT_ENABLED!=1)');
  }

  // Lazy import so tests/build don’t eagerly load Playwright.
  const pw = await import('playwright');
  const proxyUrl = proxyUrlOverride ? normalizeProxyUrl(proxyUrlOverride) : '';
  const pwProxy = proxyUrl ? toPlaywrightProxy(proxyUrl) : undefined;
  if (SEARCH_PROXY_DEBUG) {
    console.info('playwright.launch', {
      proxy: proxyUrl ? redactProxyUrl(proxyUrl) : null,
      has_auth: Boolean(pwProxy?.username || pwProxy?.password),
    });
  }
  const userAgent = getRandomUserAgent();
  const timeoutMs = playwrightTimeoutMs();
  const observeMs = playwrightObserveMs();

  const launch = async () =>
    pw.chromium.launch({
      headless: playwrightHeadless(),
      ...(pwProxy ? { proxy: pwProxy } : {}),
      // When observing (headful debugging), slow down a bit so navigation is visible.
      ...(observeMs > 0 && !playwrightHeadless() ? { slowMo: 50 } : {}),
    });

  let browser: Browser;
  try {
    const maybeBrowser = playwrightReuseBrowser()
      ? await (playwrightBrowserPromise ?? (playwrightBrowserPromise = launch()))
      : await launch();
    browser = maybeBrowser as Browser;
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
    // Optional: keep the window open longer for local debugging/observation.
    if (observeMs > 0 && !playwrightHeadless()) {
      await page.waitForTimeout(observeMs);
    }
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } catch (e) {
    // If navigation fails (e.g. proxy/connectivity), keep the window open in dev
    // so the operator can see the error page and browser state.
    if (observeMs > 0 && !playwrightHeadless()) {
      await page.waitForTimeout(observeMs).catch(() => {});
    }
    throw e;
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

export type SearchProvider = 'google' | 'duckduckgo' | 'bing' | 'mojeek';

export function buildGoogleSearchUrl(
  query: string,
  opts?: { numResults?: number; hl?: string; gl?: string; start?: number },
): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.max(10, Math.min(100, opts?.numResults ?? 10))));
  url.searchParams.set('hl', opts?.hl ?? 'ru');
  url.searchParams.set('gl', opts?.gl ?? 'ru');
  if (opts?.start != null) {
    url.searchParams.set('start', String(Math.max(0, Math.floor(opts.start))));
  }
  return url.toString();
}

export function buildDuckDuckGoSearchUrl(query: string): string {
  // Use "lite" endpoint: stable HTML and typically returns 200 for GET.
  // The "html" endpoint often responds with 202 and no results for server-side scraping.
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  return url.toString();
}

export function buildBingSearchUrl(
  query: string,
  opts?: { count?: number; first?: number; setlang?: string; cc?: string },
): string {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.max(5, Math.min(50, opts?.count ?? 10))));
  url.searchParams.set('first', String(Math.max(1, Math.floor(opts?.first ?? 1))));
  // `setlang` controls UI language; `cc` influences region.
  url.searchParams.set('setlang', opts?.setlang ?? 'ru-ru');
  url.searchParams.set('cc', opts?.cc ?? 'RU');
  return url.toString();
}

export function buildMojeekSearchUrl(query: string): string {
  const url = new URL('https://www.mojeek.com/search');
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

export class BingSearchError extends Error {
  code: 'blocked' | 'request_failed';

  constructor(code: 'blocked' | 'request_failed', message: string) {
    super(message);
    this.name = 'BingSearchError';
    this.code = code;
  }
}

export function isBingBlockedError(error: unknown): error is BingSearchError {
  return error instanceof BingSearchError && error.code === 'blocked';
}

export class MojeekSearchError extends Error {
  code: 'blocked' | 'request_failed';

  constructor(code: 'blocked' | 'request_failed', message: string) {
    super(message);
    this.name = 'MojeekSearchError';
    this.code = code;
  }
}

export function isMojeekBlockedError(error: unknown): error is MojeekSearchError {
  return error instanceof MojeekSearchError && error.code === 'blocked';
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
    host.includes('duckduckgo.com') ||
    host.includes('bing.com') ||
    host.includes('mojeek.com')
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
  proxy: { kind: 'playwright' | 'undici' | 'none'; server: string | null };
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
  proxy: { kind: 'playwright' | 'undici' | 'none'; server: string | null };
  result_count: number;
  html_snippet: string;
};

type BingSearchDebugInfo = {
  request_url: string;
  final_url: string;
  status: number;
  title: string | null;
  block_reason: string | null;
  proxy: { kind: 'playwright' | 'undici' | 'none'; server: string | null };
  result_count: number;
  html_snippet: string;
};

type MojeekSearchDebugInfo = {
  request_url: string;
  final_url: string;
  status: number;
  title: string | null;
  block_reason: string | null;
  proxy: { kind: 'playwright' | 'undici' | 'none'; server: string | null };
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

function decodeBingUParam(uParam: string): string | null {
  // Bing redirects often look like: /ck/a?...&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8&...
  // Where `u` is base64-ish, sometimes url-safe, often prefixed with `a1`.
  const raw = String(uParam || '').trim();
  if (!raw) return null;
  const stripped = raw.replace(/^a1/i, '');
  const normalized = stripped.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  } catch {
    // ignore
  }
  return null;
}

function extractBingRedirect(href: string): string {
  try {
    const parsed = new URL(href, 'https://www.bing.com');
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('bing.com')) return href;
    if (parsed.pathname.startsWith('/ck/a')) {
      const u = parsed.searchParams.get('u');
      const decoded = u ? decodeBingUParam(u) : null;
      if (decoded) return decoded;
    }
  } catch {
    // ignore
  }
  return href;
}

export async function extractBingResults(html: string, query: string): Promise<SearchResultItem[]> {
  const cheerio = await getCheerio();
  if (!cheerio) {
    return extractBingResultsFallback(html, query);
  }
  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  $('li.b_algo, li.b_ans, div.b_algo').each((_, el) => {
    if (results.length >= 100) return;
    const $el = $(el);
    const a = $el.find('h2 a[href], h3 a[href], a[href]').first();
    const title = a.text().trim();
    let href = a.attr('href') || '';
    if (!title || !href) return;
    href = extractBingRedirect(href);

    try {
      const validLink = normalizeUrl(href);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) return;
      const key = validLink.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const snippet =
        $el.find('.b_caption p, .b_paractl p, p').first().text().trim() ||
        $el.find('.b_snippet').first().text().trim() ||
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

function extractBingResultsFallback(html: string, query: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();
  // Very tolerant: look for algo blocks with an h2/h3 anchor.
  const blockRegex = /<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][\s\S]*?<\/li>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    if (results.length >= 100) break;
    const block = blockMatch[0];
    const anchorMatch = block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchorMatch) continue;
    const rawHref = anchorMatch[1] || '';
    const title = stripHtml(anchorMatch[2] || '');
    if (!rawHref || !title) continue;

    try {
      const cleaned = extractBingRedirect(rawHref);
      const validLink = normalizeUrl(cleaned);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) continue;
      const key = validLink.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1] || '') : '';

      results.push({
        query,
        title,
        link: validLink,
        snippet,
        position: results.length + 1,
      });
    } catch {
      // ignore
    }
  }
  return results;
}

export async function extractMojeekResults(html: string, query: string): Promise<SearchResultItem[]> {
  const cheerio = await getCheerio();
  if (!cheerio) return extractMojeekResultsFallback(html, query);
  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();

  $('li.result, div.result, .results li, .result').each((_, el) => {
    if (results.length >= 100) return;
    const $el = $(el);
    const a = $el.find('a[href]').first();
    const title = a.text().trim();
    const href = a.attr('href') || '';
    if (!title || !href) return;

    try {
      const validLink = normalizeUrl(href);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) return;
      const key = validLink.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const snippet =
        $el.find('.snippet, p, .result__snippet, .desc').first().text().trim() ||
        '';

      results.push({
        query,
        title,
        link: validLink,
        snippet: snippet.replace(/\s+/g, ' ').trim(),
        position: results.length + 1,
      });
    } catch {
      // ignore
    }
  });

  return results;
}

function extractMojeekResultsFallback(html: string, query: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    if (results.length >= 100) break;
    const rawHref = match[1] || '';
    const title = stripHtml(match[2] || '');
    if (!rawHref || !title) continue;
    try {
      const validLink = normalizeUrl(rawHref);
      const hostname = new URL(validLink).hostname;
      if (isSearchEngineHost(hostname)) continue;
      const key = validLink.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ query, title, link: validLink, snippet: '', position: results.length + 1 });
    } catch {
      // ignore
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

export async function bingSearch(query: string): Promise<SearchResultItem[]> {
  const detailed = await bingSearchDetailed(query);
  return detailed.results;
}

export async function mojeekSearch(query: string): Promise<SearchResultItem[]> {
  const detailed = await mojeekSearchDetailed(query);
  return detailed.results;
}

async function googleSearchDetailedByUrl(query: string, requestUrl: string): Promise<{
  results: SearchResultItem[];
  debug: GoogleSearchDebugInfo;
}> {
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
    // Default path: use Playwright (more resilient to enablejs/consent/captcha pages).
    // Fallback path: direct fetch + HTML parsing (faster, but blocked more often).
    if (isPlaywrightEnabled()) {
      try {
        const proxyUrl = pickSearchProxyUrl(0);
        const pw = await fetchHtmlWithPlaywright(requestUrl, proxyUrl);
        const blockedByUrl = detectGoogleBlockReasonByUrl(pw.finalUrl);
        const blockReason = blockedByUrl ?? detectGoogleBlockReason(pw.html);
        if (blockReason) throw new GoogleSearchError('blocked', blockReason);

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
            proxy: { kind: proxyUrl ? 'playwright' : 'none', server: proxyUrl ? redactProxyUrl(proxyUrl) : null },
            container_count: stats.container_count,
            h3_count: stats.h3_count,
            anchor_with_h3_count: stats.anchor_with_h3_count,
            html_snippet: compressHtmlSnippet(pw.html),
          },
        };
      } catch (e) {
        // If Playwright returns a real "blocked" signal, don't waste time on fetch fallback.
        // Otherwise, fall back to fetch (e.g. Playwright browser missing / launch failed).
        if (e instanceof GoogleSearchError && e.code === 'blocked') throw e;
      }
    }

    const proxyUrl = pickSearchProxyUrl(10);
    const dispatcher = await getSearchProxyDispatcher(proxyUrl);
    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      method: 'GET',
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    };
    if (SEARCH_PROXY_DEBUG) {
      console.info('google.fetch', { proxy: proxyUrl ? redactProxyUrl(proxyUrl) : null, via: dispatcher ? 'undici' : 'none' });
    }
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
          const pw = await fetchHtmlWithPlaywright(requestUrl, proxyUrl);
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
              proxy: { kind: proxyUrl ? 'playwright' : 'none', server: proxyUrl ? redactProxyUrl(proxyUrl) : null },
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
        proxy: { kind: dispatcher ? 'undici' : 'none', server: dispatcher ? redactProxyUrl(proxyUrl) : null },
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

export async function googleSearchDetailed(query: string, numResults = 10): Promise<{
  results: SearchResultItem[];
  debug: GoogleSearchDebugInfo;
}> {
  const target = Math.max(10, Math.min(100, Math.floor(numResults || 10)));
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(target / pageSize));

  const combined: SearchResultItem[] = [];
  const seen = new Set<string>();
  let lastDebug: GoogleSearchDebugInfo | null = null;

  for (let page = 0; page < pages; page += 1) {
    const start = page * pageSize;
    const requestUrl = buildGoogleSearchUrl(query, { numResults: pageSize, hl: 'ru', gl: 'ru', start });
    try {
      const out = await googleSearchDetailedByUrl(query, requestUrl);
      lastDebug = out.debug;
      for (const r of out.results) {
        const key = r.link.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        combined.push({ ...r, position: combined.length + 1 });
        if (combined.length >= target) break;
      }
      if (combined.length >= target) break;
      // If a page yields nothing, stop early (likely block/empty).
      if (out.results.length === 0) break;
    } catch (e) {
      // If we already collected something, return partial results (max-yield mode).
      if (combined.length > 0 && isGoogleBlockedError(e)) {
        break;
      }
      throw e;
    }
  }

  if (!lastDebug) {
    // Should be unreachable unless buildGoogleSearchUrl throws (it shouldn't).
    throw new GoogleSearchError('request_failed', 'Google search failed (no debug)');
  }

  return { results: combined, debug: lastDebug };
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
    'Referer': 'https://duckduckgo.com/',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  // Default path: Playwright first (more likely to bypass 202 shell pages).
  // Fallback path: direct fetch with retries/backoff.
  if (isPlaywrightEnabled()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const backoffMs = 650 * 2 ** (attempt - 1) + Math.round(Math.random() * 650);
        await sleep(backoffMs);
      } else {
        await sleep(250 + Math.round(Math.random() * 350));
      }

      try {
        const proxyUrl = pickSearchProxyUrl(attempt);
        const pw = await fetchHtmlWithPlaywright(requestUrl, proxyUrl);
        const html = pw.html;
        const title = extractTitle(html);
        const lower = html.toLowerCase();
        const blockReason =
          lower.includes('access denied') || lower.includes('blocked') || lower.includes('captcha')
            ? 'DuckDuckGo blocked the request'
            : null;

        const results = await extractDuckDuckGoResults(html, query);
        if (blockReason && results.length === 0) {
          if (attempt < 2) continue;
          throw new DuckDuckGoSearchError('blocked', blockReason);
        }

        return {
          results,
          debug: {
            request_url: requestUrl,
            final_url: pw.finalUrl,
            status: 200,
            title,
            block_reason: null,
            proxy: { kind: proxyUrl ? 'playwright' : 'none', server: proxyUrl ? redactProxyUrl(proxyUrl) : null },
            result_count: results.length,
            html_snippet: compressHtmlSnippet(html),
          },
        };
      } catch (e) {
        // If Playwright indicates a real "blocked" condition, surface it as-is.
        // Otherwise (e.g. missing browser), fall back to fetch implementation below.
        if (e instanceof DuckDuckGoSearchError && e.code === 'blocked') throw e;
        if (attempt >= 2) break;
      }
    }
  }

  // Light jitter + retries to reduce 202/429 bursts.
  // DDG sometimes returns 202 for bot-like traffic; a short backoff often fixes it.
  for (let attempt = 0; attempt < 5; attempt++) {
    // Jitter between attempts, but keep first attempt fast.
    if (attempt > 0) {
      const backoffMs = 900 * 2 ** (attempt - 1) + Math.round(Math.random() * 900);
      await sleep(backoffMs);
    } else {
      await sleep(400 + Math.round(Math.random() * 450));
    }

    try {
      const proxyUrl = pickSearchProxyUrl(attempt);
      const dispatcher = await getSearchProxyDispatcher(proxyUrl);
      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'GET',
        headers,
        ...(dispatcher ? { dispatcher } : {}),
      };
      if (SEARCH_PROXY_DEBUG) {
        console.info('ddg.fetch', { proxy: proxyUrl ? redactProxyUrl(proxyUrl) : null, via: dispatcher ? 'undici' : 'none', attempt });
      }
      const response = await fetch(requestUrl, fetchInit);
      if (!response.ok) {
        if (response.status === 429) {
          if (attempt < 4) continue;
          throw new DuckDuckGoSearchError('blocked', 'DuckDuckGo blocking: Too Many Requests (429)');
        }
        throw new DuckDuckGoSearchError('request_failed', `DuckDuckGo search failed with status ${response.status}`);
      }

      // DDG sometimes returns 202 + a shell page without results for bot-like traffic.
      if (response.status === 202) {
        const html = await response.text();
        const title = extractTitle(html);
        const lower = html.toLowerCase();
        const blockReason =
          lower.includes('access denied') || lower.includes('blocked') || lower.includes('captcha')
            ? 'DuckDuckGo blocked the request (202)'
            : null;

        // Some 202 responses still contain results. Try parsing first.
        const parsed = await extractDuckDuckGoResults(html, query);
        if (!blockReason && parsed.length > 0) {
          return {
            results: parsed,
            debug: {
              request_url: requestUrl,
              final_url: response.url,
              status: 202,
              title,
              block_reason: null,
              proxy: { kind: dispatcher ? 'undici' : 'none', server: dispatcher ? redactProxyUrl(proxyUrl) : null },
              result_count: parsed.length,
              html_snippet: compressHtmlSnippet(html),
            },
          };
        }

        if (isPlaywrightEnabled()) {
          try {
            const pw = await fetchHtmlWithPlaywright(requestUrl, proxyUrl);
            const results = await extractDuckDuckGoResults(pw.html, query);
            return {
              results,
              debug: {
                request_url: requestUrl,
                final_url: pw.finalUrl,
                status: 200,
                title: extractTitle(pw.html),
                block_reason: null,
                proxy: { kind: proxyUrl ? 'playwright' : 'none', server: proxyUrl ? redactProxyUrl(proxyUrl) : null },
                result_count: results.length,
                html_snippet: compressHtmlSnippet(pw.html),
              },
            };
          } catch (e) {
            console.warn('DuckDuckGo Playwright fallback failed:', e);
          }
        }
        if (attempt < 4) continue;
        throw new DuckDuckGoSearchError('blocked', blockReason ?? 'DuckDuckGo blocked the request (202)');
      }

      const html = await response.text();
      const title = extractTitle(html);
      const lower = html.toLowerCase();
      const blockReason =
        lower.includes('access denied') || lower.includes('blocked') || lower.includes('captcha')
          ? 'DuckDuckGo blocked the request'
          : null;
      if (blockReason) {
        if (attempt < 4) continue;
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
          proxy: { kind: dispatcher ? 'undici' : 'none', server: dispatcher ? redactProxyUrl(proxyUrl) : null },
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
      if (error instanceof DuckDuckGoSearchError && error.code === 'blocked' && attempt < 4) {
        continue;
      }

      // Last chance: Playwright fallback for 202/blocked pages
      if (isPlaywrightEnabled() && error instanceof DuckDuckGoSearchError && error.code === 'blocked') {
        try {
          const proxyUrl = pickSearchProxyUrl(attempt + 1000);
          const pw = await fetchHtmlWithPlaywright(requestUrl, proxyUrl);
          const results = await extractDuckDuckGoResults(pw.html, query);
          return {
            results,
            debug: {
              request_url: requestUrl,
              final_url: pw.finalUrl,
              status: 200,
              title: extractTitle(pw.html),
              block_reason: null,
              proxy: { kind: proxyUrl ? 'playwright' : 'none', server: proxyUrl ? redactProxyUrl(proxyUrl) : null },
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

function detectBingBlockReason(html: string, finalUrl?: string): string | null {
  const lower = html.toLowerCase();
  if (finalUrl) {
    try {
      const u = new URL(finalUrl);
      if (u.hostname.toLowerCase().includes('bing.com') && u.pathname.toLowerCase().includes('/sorry')) {
        return 'Bing blocked the request (sorry redirect)';
      }
    } catch {
      // ignore
    }
  }
  if (lower.includes('unusual traffic') || lower.includes('automated queries')) return 'Bing blocked the request (unusual traffic)';
  if (lower.includes('captcha') || lower.includes('verify you are human')) return 'Bing blocked the request (captcha)';
  if (lower.includes('access denied')) return 'Bing blocked the request (access denied)';
  return null;
}

export async function bingSearchDetailed(
  query: string,
  opts?: { maxPages?: number; pageSize?: number; maxResults?: number },
): Promise<{ results: SearchResultItem[]; debug: BingSearchDebugInfo }> {
  const maxPages = Math.max(1, Math.min(8, Math.floor(opts?.maxPages ?? 3)));
  const pageSize = Math.max(5, Math.min(50, Math.floor(opts?.pageSize ?? 10)));
  const maxResults = Math.max(1, Math.min(200, Math.floor(opts?.maxResults ?? 50)));

  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  const collected: SearchResultItem[] = [];
  const seen = new Set<string>();
  let lastDebug: BingSearchDebugInfo | null = null;

  for (let page = 0; page < maxPages; page++) {
    // Jitter to avoid bursty traffic; aim for stability over speed.
    await sleep(900 + Math.round(Math.random() * 1600));

    const requestUrl = buildBingSearchUrl(query, { count: pageSize, first: 1 + page * pageSize, setlang: 'ru-ru', cc: 'RU' });
    try {
      const proxyUrl = pickSearchProxyUrl(page);
      const dispatcher = await getSearchProxyDispatcher(proxyUrl);
      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'GET',
        headers,
        ...(dispatcher ? { dispatcher } : {}),
      };
      if (SEARCH_PROXY_DEBUG) {
        console.info('bing.fetch', { proxy: proxyUrl ? redactProxyUrl(proxyUrl) : null, via: dispatcher ? 'undici' : 'none', page });
      }
      const response = await fetch(requestUrl, fetchInit);
      if (!response.ok) {
        if (response.status === 429) throw new BingSearchError('blocked', 'Bing blocking: Too Many Requests (429)');
        throw new BingSearchError('request_failed', `Bing search failed with status ${response.status}`);
      }

      const html = await response.text();
      const title = extractTitle(html);
      const blockReason = detectBingBlockReason(html, response.url);
      if (blockReason) throw new BingSearchError('blocked', blockReason);

      const parsed = await extractBingResults(html, query);
      for (const r of parsed) {
        const key = r.link.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({ ...r, position: collected.length + 1 });
        if (collected.length >= maxResults) break;
      }

      lastDebug = {
        request_url: requestUrl,
        final_url: response.url,
        status: response.status,
        title,
        block_reason: null,
        proxy: { kind: dispatcher ? 'undici' : 'none', server: dispatcher ? redactProxyUrl(proxyUrl) : null },
        result_count: collected.length,
        html_snippet: compressHtmlSnippet(html),
      };

      if (parsed.length === 0) {
        // If a page yields nothing, don’t hammer. Stop early.
        break;
      }
      if (collected.length >= maxResults) break;
    } catch (e) {
      if (e instanceof BingSearchError && e.code === 'blocked') {
        // If we already got something, return what we have.
        if (collected.length > 0 && lastDebug) return { results: collected, debug: lastDebug };
      }
      throw e;
    }
  }

  return {
    results: collected,
    debug:
      lastDebug ??
      ({
        request_url: buildBingSearchUrl(query, { count: pageSize, first: 1, setlang: 'ru-ru', cc: 'RU' }),
        final_url: buildBingSearchUrl(query, { count: pageSize, first: 1, setlang: 'ru-ru', cc: 'RU' }),
        status: 200,
        title: null,
        block_reason: null,
        proxy: { kind: 'none', server: null },
        result_count: collected.length,
        html_snippet: '',
      } satisfies BingSearchDebugInfo),
  };
}

function detectMojeekBlockReason(html: string, finalUrl?: string): string | null {
  const lower = html.toLowerCase();
  if (finalUrl) {
    try {
      const u = new URL(finalUrl);
      if (u.hostname.toLowerCase().includes('mojeek.com') && u.pathname.toLowerCase().includes('/sorry')) {
        return 'Mojeek blocked the request (sorry redirect)';
      }
    } catch {
      // ignore
    }
  }
  if (lower.includes('access denied')) return 'Mojeek blocked the request (access denied)';
  if (lower.includes('captcha') || lower.includes('verify')) return 'Mojeek blocked the request (captcha)';
  return null;
}

export async function mojeekSearchDetailed(
  query: string,
  opts?: { maxRetries?: number },
): Promise<{ results: SearchResultItem[]; debug: MojeekSearchDebugInfo }> {
  const requestUrl = buildMojeekSearchUrl(query);
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };
  const maxRetries = Math.max(1, Math.min(5, Math.floor(opts?.maxRetries ?? 3)));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 1200 * 2 ** (attempt - 1) + Math.round(Math.random() * 900);
      await sleep(backoffMs);
    } else {
      await sleep(450 + Math.round(Math.random() * 650));
    }

    const proxyUrl = pickSearchProxyUrl(10_000 + attempt);
    try {
      const dispatcher = await getSearchProxyDispatcher(proxyUrl);
      const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'GET',
        headers,
        ...(dispatcher ? { dispatcher } : {}),
      };
      if (SEARCH_PROXY_DEBUG) {
        console.info('mojeek.fetch', { proxy: proxyUrl ? redactProxyUrl(proxyUrl) : null, via: dispatcher ? 'undici' : 'none', attempt });
      }

      const response = await fetch(requestUrl, fetchInit);
      if (!response.ok) {
        if (response.status === 429) {
          if (attempt < maxRetries - 1) continue;
          throw new MojeekSearchError('blocked', 'Mojeek blocking: Too Many Requests (429)');
        }
        throw new MojeekSearchError('request_failed', `Mojeek search failed with status ${response.status}`);
      }

      const html = await response.text();
      const title = extractTitle(html);
      const blockReason = detectMojeekBlockReason(html, response.url);
      if (blockReason) {
        if (attempt < maxRetries - 1) continue;
        throw new MojeekSearchError('blocked', blockReason);
      }

      const results = await extractMojeekResults(html, query);
      return {
        results,
        debug: {
          request_url: requestUrl,
          final_url: response.url,
          status: response.status,
          title,
          block_reason: null,
          proxy: { kind: dispatcher ? 'undici' : 'none', server: dispatcher ? redactProxyUrl(proxyUrl) : null },
          result_count: results.length,
          html_snippet: compressHtmlSnippet(html),
        },
      };
    } catch (error) {
      if (error instanceof MojeekSearchError && error.code === 'blocked' && attempt < maxRetries - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new MojeekSearchError('request_failed', 'Mojeek search failed (unexpected)');
}
