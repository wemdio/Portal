/**
 * Professional-grade email scraper for bulk email extraction from websites.
 *
 * Crawls multiple page types (main, contacts, about, team, privacy/imprint),
 * uses advanced deobfuscation, JSON-LD parsing, data-attribute scanning,
 * and smart junk filtering.
 *
 * This is a standalone module — does NOT modify existing enrichment code.
 */

import iconv from 'iconv-lite';
import { normalizeUrl } from '@/lib/enrich/urlUtils';

// ── Configuration ──────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_RETRIES = 1;
const FETCH_RETRY_DELAY_MS = 400;
const DEFAULT_MAX_PAGES = 12;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Proxy pool (round-robin) ───────────────────────────────────
//
// Тот же формат PROXY_URLS, что и websiteParser.ts, hhParser.ts и др. —
// JSON-массив строк ["http://user:pass@ip:port", ...] или "url1,url2,url3".
// До 2026-07-21 email-скрапер шёл напрямую с IP воркера — на 800+ сайтах
// это заметно, потому что портал же уже покупает residential-прокси
// (5 IP на момент внедрения) и text/INN-режим ими пользуется, а email —
// нет. Fix: ротируем 5 IP через тот же undici.ProxyAgent-паттерн.
type Dispatcher = import('undici').Dispatcher;

let _proxyUrls: string[] | null = null;
function getProxyUrls(): string[] {
  if (_proxyUrls) return _proxyUrls;
  try {
    const raw = (process.env.PROXY_URLS ?? '').trim();
    if (raw.startsWith('[')) {
      _proxyUrls = (JSON.parse(raw) as string[]).map((s) => s.trim()).filter(Boolean);
    } else {
      _proxyUrls = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    _proxyUrls = [];
  }
  return _proxyUrls;
}

let _proxyRR = 0;
function pickProxyUrl(): string {
  const urls = getProxyUrls();
  if (!urls.length) return '';
  _proxyRR = (_proxyRR + 1) % urls.length;
  return urls[_proxyRR];
}

const _proxyDispatchers = new Map<string, Dispatcher>();
async function getProxyDispatcher(): Promise<Dispatcher | undefined> {
  const url = pickProxyUrl();
  if (!url) return undefined;
  const existing = _proxyDispatchers.get(url);
  if (existing) return existing;
  try {
    const mod = await import('undici');
    const d = new mod.ProxyAgent(url) as unknown as Dispatcher;
    _proxyDispatchers.set(url, d);
    return d;
  } catch {
    return undefined;
  }
}

// ── Contact / About / Team page paths ──────────────────────────

const CONTACT_PATHS = [
  '/contacts', '/contact', '/contact-us', '/contactus',
  '/kontakty', '/kontakt', '/kontakti',
  '/контакты', '/контакт',
  '/obratnaya-svyaz', '/feedback',
  '/support',
];

const ABOUT_PATHS = [
  '/about', '/about-us', '/about-company', '/aboutus',
  '/o-nas', '/o-kompanii', '/company', '/company/about',
  '/о-компании', '/о-нас',
  '/kompaniya', '/info',
];

const TEAM_PATHS = [
  '/team', '/our-team', '/staff', '/people', '/employees',
  '/komanda', '/команда', '/наша-команда', '/sotrudniki',
];

const LEGAL_PATHS = [
  '/imprint', '/impressum', '/legal', '/privacy', '/datenschutz',
];

// Russian B2B sites often keep company emails on pages with bank/payment requisites
// or delivery terms (юр. отдел, согласование договоров), not on /contacts.
const BUSINESS_PATHS = [
  '/rekvizity', '/реквизиты', '/requisites',
  '/oplata', '/payment', '/payments', '/pay',
  '/dostavka', '/delivery', '/shipping',
  '/dogovor', '/договор',
];

const ALL_STATIC_PATHS = [
  ...CONTACT_PATHS,
  ...ABOUT_PATHS,
  ...TEAM_PATHS,
  ...LEGAL_PATHS,
  ...BUSINESS_PATHS,
];

// ── Link discovery patterns ────────────────────────────────────

const LINK_HREF_PATTERN =
  /\/(contact|contacts|kontakty|kontakt|kontakti|about|about[_-]?us|o[_-]?nas|o[_-]?kompanii|team|our[_-]?team|staff|people|komanda|imprint|impressum|legal|feedback|support|контакты|о-компании|о-нас|команда|наша-команда)(\/|$|\?|#)/i;

const LINK_TEXT_PATTERN =
  /\b(contact|contacts|контакты|about(\s+us)?|о\s*компании|о\s*нас|команда|team|staff|наша\s+команда|сотрудники|связаться|написать|обратн(ая|ой)\s+связ(ь|и)|email|почта|impressum|imprint)\b/i;

// ── Email validation ───────────────────────────────────────────

const EMAIL_REGEX = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const STRICT_EMAIL_REGEX = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

// ── Junk email filters ─────────────────────────────────────────

const JUNK_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'mailer_daemon', 'postmaster', 'hostmaster',
  'abuse', 'root', 'webmaster', 'daemon', 'bounce', 'devnull',
  'null', 'unsubscribe', 'subscribe',
]);

const JUNK_DOMAIN_PATTERNS = [
  /^example\.(com|org|net)$/,
  /^test\.(com|org|net)$/,
  /^localhost$/,
  /^(mail|email)\.(example|test)\./,
  /sentry\.io$/,
  /wixpress\.com$/,
  /cloudflare\.com$/,
  /googleapis\.com$/,
  /gstatic\.com$/,
  /wpengine\.com$/,
  /wordpress\.(com|org)$/,
  /gravatar\.com$/,
  /schema\.org$/,
  /w3\.org$/,
  /jquery\.com$/,
  /bootstrap(cdn)?\.com$/,
  /googletagmanager\.com$/,
  /google-analytics\.com$/,
  /facebook\.com$/,
  /twitter\.com$/,
  /instagram\.com$/,
  /linkedin\.com$/,
  /youtube\.com$/,
];

const IMAGE_EXT_IN_LOCAL = /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|tiff?)$/i;

// ── HTML entity decoding for emails ────────────────────────────

export function decodeHtmlEntitiesInEmail(text: string): string {
  return text
    .replace(/&#64;/g, '@')
    .replace(/&#x40;/gi, '@')
    .replace(/&#46;/g, '.')
    .replace(/&#x2e;/gi, '.')
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.');
}

// ── Cloudflare Email Protection ────────────────────────────────
//
// Сайты за Cloudflare часто прячут email через feature "Email Address
// Obfuscation": в HTML вместо адреса рендерится
//   <a class="__cf_email__" data-cfemail="abcdef1234..."
//      href="/cdn-cgi/l/email-protection">[email&#160;protected]</a>
// hex-строка это email XOR-нутый одним байтом. Формат: первый байт — ключ,
// каждый следующий байт — символ email XOR ключа.

const CFEMAIL_REGEX = /data-cfemail=["']([0-9a-fA-F]+)["']/gi;

export function decodeCloudflareEmail(hex: string): string | null {
  if (!hex || hex.length < 4 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16) ^ key;
      // сразу отсеиваем управляющие символы — чаще всего это неверная hex-строка,
      // не email; иначе получим мусор вида "x@y"
      if (byte < 0x20 || byte === 0x7f) return null;
      out += String.fromCharCode(byte);
    }
    if (!out.includes('@') || !out.includes('.')) return null;
    return out;
  } catch {
    return null;
  }
}

// ── Deobfuscation ──────────────────────────────────────────────

function deobfuscateText(text: string): string {
  return text
    // Bracket variants: [at] [dot]
    .replace(/\s*\[\s*at\s*]\s*/gi, '@')
    .replace(/\s*\[\s*dot\s*]\s*/gi, '.')
    // Parenthesis variants: (at) (dot)
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    // Curly bracket variants: {at} {dot}
    .replace(/\s*\{\s*at\s*\}\s*/gi, '@')
    .replace(/\s*\{\s*dot\s*\}\s*/gi, '.')
    // Dash variants: -at- -dot-
    .replace(/-at-/gi, '@')
    .replace(/-dot-/gi, '.')
    // Angle bracket variants: <at> <dot>
    .replace(/<at>/gi, '@')
    .replace(/<dot>/gi, '.')
    // Space variants: " at " " dot " (with word boundaries)
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    // HTML entities
    .replace(/&#64;/g, '@')
    .replace(/&#x40;/gi, '@')
    .replace(/&#46;/g, '.')
    .replace(/&#x2e;/gi, '.')
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.');
}

// ── Core extraction functions ──────────────────────────────────

function normalizeEmail(raw: string): string | null {
  const decoded = decodeHtmlEntitiesInEmail(raw);
  const email = decoded.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254) return null;
  if (!email.includes('@')) return null;
  if (!STRICT_EMAIL_REGEX.test(email)) return null;
  // Reject emails starting/ending with dots or having double dots
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  if (domain.split('.').pop()!.length < 2) return null;
  return email;
}

/**
 * Extract emails from plain text with advanced deobfuscation.
 */
export function extractEmailsAdvanced(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const deobfuscated = deobfuscateText(text);
  const matches = deobfuscated.match(EMAIL_REGEX) ?? [];
  for (const m of matches) {
    const email = normalizeEmail(m);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    results.push(email);
  }
  return results;
}

/**
 * Extract emails from JSON-LD structured data (Schema.org).
 */
export function extractJsonLdEmails(html: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]) as Record<string, unknown>;
      collectJsonLdEmails(data, seen, results);
    } catch {
      // Invalid JSON — skip
    }
  }
  return results;
}

function collectJsonLdEmails(
  obj: unknown,
  seen: Set<string>,
  results: string[],
  depth = 0,
): void {
  if (depth > 5 || !obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectJsonLdEmails(item, seen, results, depth + 1);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Direct email field
  if (typeof record.email === 'string') {
    const email = normalizeEmail(record.email);
    if (email && !seen.has(email)) {
      seen.add(email);
      results.push(email);
    }
  }

  // contactPoint (single or array)
  if (record.contactPoint) {
    collectJsonLdEmails(record.contactPoint, seen, results, depth + 1);
  }

  // member / employee
  if (record.member) collectJsonLdEmails(record.member, seen, results, depth + 1);
  if (record.employee) collectJsonLdEmails(record.employee, seen, results, depth + 1);

  // @graph (array of entities)
  if (Array.isArray(record['@graph'])) {
    collectJsonLdEmails(record['@graph'], seen, results, depth + 1);
  }
}

/**
 * Extract emails from raw HTML using all available methods:
 * 1. JSON-LD structured data
 * 2. mailto: links (including encoded)
 * 3. data-email / data-mail attributes
 * 4. Visible text (with deobfuscation)
 */
export function extractEmailsFromHtmlAdvanced(html: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const addEmail = (raw: string) => {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) return;
    seen.add(email);
    results.push(email);
  };

  // 1. JSON-LD
  for (const e of extractJsonLdEmails(html)) addEmail(e);

  // 2. mailto: links (handle encoded entities)
  const mailtoRegex = /href=["']mailto:([^"'?\s>]+)[^"'>]*["']/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRegex.exec(html)) !== null) {
    addEmail(decodeHtmlEntitiesInEmail(decodeURIComponent(m[1] ?? '')));
  }

  // 3. data-email / data-mail / data-e attributes
  const dataEmailRegex = /data-(?:email|mail|e)=["']([^"']+)["']/gi;
  while ((m = dataEmailRegex.exec(html)) !== null) {
    addEmail(m[1] ?? '');
  }

  // 3b. Cloudflare Email Protection: <a data-cfemail="hex..."> ...
  CFEMAIL_REGEX.lastIndex = 0;
  while ((m = CFEMAIL_REGEX.exec(html)) !== null) {
    const decoded = decodeCloudflareEmail(m[1] ?? '');
    if (decoded) addEmail(decoded);
  }

  // 4. Strip scripts/styles, then extract from visible text
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  for (const e of extractEmailsAdvanced(stripped)) addEmail(e);

  return results;
}

// ── Company name extraction from page ──────────────────────────

const BASIC_HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&laquo;': '«',
  '&raquo;': '»',
};

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => BASIC_HTML_ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Кандидат-название компании со страницы: og:site_name (чистый бренд) →
 * <title> (шумный, но почти всегда есть). Сырое — финальная чистка отдельно
 * (AI cleanCompanyNames: обрежет после -|/,:, снимет ООО/«» и т.п.).
 */
export function extractSiteName(html: string): string | null {
  const candidates: string[] = [];

  const ogTag = html.match(/<meta[^>]*\bproperty=["']og:site_name["'][^>]*>/i)?.[0];
  const ogContent = ogTag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  if (ogContent) candidates.push(ogContent);

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) candidates.push(title);

  for (const raw of candidates) {
    const v = decodeBasicEntities(raw).replace(/\s+/g, ' ').trim();
    if (v.length >= 2 && v.length <= 200) return v;
  }
  return null;
}

// ── Junk email filtering ───────────────────────────────────────

/**
 * Filter out junk/system/placeholder emails.
 */
export function filterJunkEmails(emails: string[]): string[] {
  return emails.filter((email) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return false;

    // Too long local part
    if (local.length > 64) return false;

    // Known junk local parts
    if (JUNK_LOCAL_PARTS.has(local.toLowerCase())) return false;

    // Image extensions in local part (e.g. banner.png@images.com)
    if (IMAGE_EXT_IN_LOCAL.test(local)) return false;

    // Junk domains
    for (const pattern of JUNK_DOMAIN_PATTERNS) {
      if (pattern.test(domain.toLowerCase())) return false;
    }

    return true;
  });
}

// ── HTML fetching with encoding support ────────────────────────

function extractCharsetFromMeta(html: string): string | null {
  const metaCharset = html.match(/<meta[^>]+charset=["']?([^"'>\s]+)/i);
  if (metaCharset?.[1]) return metaCharset[1].trim().toLowerCase();
  const metaContentType = html.match(
    /<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([^"'>\s]+)/i,
  );
  if (metaContentType?.[1]) return metaContentType[1].trim().toLowerCase();
  return null;
}

function looksLikeBrokenUtf8(text: string): boolean {
  const sample = text.slice(0, 2000);
  const bad = (sample.match(/�/g) ?? []).length;
  return bad >= 8 || sample.includes('����');
}

function decodeHtml(body: ArrayBuffer, contentType: string | null): string {
  const buffer = Buffer.from(body);
  const headerMatch = contentType?.match(/charset=([^;]+)/i);
  const headerCharset = headerMatch ? headerMatch[1].trim().toLowerCase() : null;

  const tryDecode = (charset: string) =>
    iconv.encodingExists(charset) ? iconv.decode(buffer, charset) : '';

  if (headerCharset) {
    const decoded = tryDecode(headerCharset);
    if (decoded) return decoded;
  }

  const decoded = new TextDecoder('utf-8').decode(buffer);
  const metaCharset = extractCharsetFromMeta(decoded);
  if (metaCharset && metaCharset !== 'utf-8' && metaCharset !== 'utf8') {
    const metaDecoded = tryDecode(metaCharset);
    if (metaDecoded) return metaDecoded;
  }

  if (!looksLikeBrokenUtf8(decoded)) return decoded;

  // Russian encoding fallbacks
  const cp1251 = tryDecode('windows-1251');
  if (cp1251) return cp1251;
  const koi8 = tryDecode('koi8-r');
  if (koi8) return koi8;

  return decoded;
}

function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml') || ct.startsWith('text/plain');
}

async function fetchPage(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<string | null> {
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  // Hard outer cap: даже если внутренний fetch() зависнет (видели на проде
  // 2026-06-19, undici assert(!this.paused) — body-stream после ассерта
  // может никогда не resolve'иться), эта race гарантирует возврат в
  // bounded time. Цена — потенциально утёкший in-progress сокет, который
  // отвалится сам по своему таймауту; зато processInPool слот свободен.
  // worker'ы Node-process'а параллельно ловят сам ассерт через
  // installUndiciAssertGuard() в app/worker/baseConstructor.ts.
  return await Promise.race([
    fetchPageInner(url, { timeout, signal: options?.signal }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout + 5_000)),
  ]);
}

async function fetchPageInner(
  url: string,
  options: { timeout: number; signal?: AbortSignal },
): Promise<string | null> {
  const { timeout } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const baseHeaders = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  } as const;

  const dispatcher = await getProxyDispatcher();

  const doFetch = async (opts: RequestInit & { dispatcher?: Dispatcher }) => {
    const res = await fetch(url, opts);
    if (res.status >= 400) return null;
    const contentType = res.headers.get('content-type');
    if (!isHtmlLikeContentType(contentType)) return null;
    const body = await res.arrayBuffer();
    return decodeHtml(body, contentType);
  };

  try {
    const fetchOpts: RequestInit & { dispatcher?: Dispatcher } = {
      method: 'GET',
      headers: baseHeaders,
      signal: controller.signal,
      redirect: 'follow',
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;

    try {
      return await doFetch(fetchOpts);
    } catch (err) {
      // Один retry без прокси при сетевой ошибке через прокси. Если 1 из 5
      // резидентных IP протух/дал 502 — не роняем сайт целиком, пробуем
      // напрямую. Общий FETCH_RETRIES снаружи ловит остальные транзиенты.
      if (!dispatcher || externalSignal?.aborted || controller.signal.aborted) {
        return null;
      }
      void err;
      const directOpts: RequestInit = {
        method: 'GET',
        headers: baseHeaders,
        signal: controller.signal,
        redirect: 'follow',
      };
      try {
        return await doFetch(directOpts);
      } catch {
        return null;
      }
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function fetchPageWithRetry(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<string | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    const html = await fetchPage(url, options);
    if (html) return html;
    if (options?.signal?.aborted) return null;
    if (attempt < FETCH_RETRIES) await sleep(FETCH_RETRY_DELAY_MS * (attempt + 1));
  }
  return null;
}

// ── Link discovery from HTML ───────────────────────────────────

async function discoverEmailPageLinks(html: string, baseUrl: string): Promise<string[]> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const results: string[] = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;

    const linkText = ($(el).text() ?? '').trim();
    if (!LINK_HREF_PATTERN.test(href) && !LINK_TEXT_PATTERN.test(linkText)) return;

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    if (!absoluteUrl.startsWith(origin)) return;
    const normalized = absoluteUrl.replace(/[#?].*$/, '').replace(/\/+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(absoluteUrl);
  });

  return results;
}

// ── Main scraper function ──────────────────────────────────────

export type ScrapeEmailsResult = {
  emails: string[];
  allEmailsRaw: string[];
  checkedUrls: string[];
  pagesScanned: number;
  /** Кандидат-название компании с главной страницы (og:site_name / <title>).
   *  Сырое — финальная чистка делается отдельно (AI cleanCompanyNames). */
  siteName: string | null;
};

/**
 * Scrape emails from a website by crawling main page + contact/about/team pages.
 *
 * Key improvements over basic scrapers:
 * - Crawls ALL candidate pages (doesn't stop at first email)
 * - Advanced deobfuscation (10+ patterns)
 * - JSON-LD / Schema.org parsing
 * - data-attribute scanning
 * - Smart junk filtering
 * - Encoding handling (UTF-8, Windows-1251, KOI8-R)
 */
export async function scrapeEmails(
  rawUrl: string,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    maxPages?: number;
    /**
     * When true, scraping returns as soon as ≥1 email survives the
     * `filterJunkEmails` filter. Skips the rest of the candidate
     * page crawl. Used by base-constructor's `find_emails` step where
     * one usable address per company is enough — saves up to 4 extra
     * page fetches × per dead/slow host × 4000+ rows.
     *
     * Default false: callers (e.g. websiteEnrichmentWorker, bugor /
     * eventOutreach findEmails) want as many addresses as they can
     * get and don't mind crawling more pages.
     */
    stopAtFirstUsableEmail?: boolean;
  },
): Promise<ScrapeEmailsResult> {
  const url = normalizeUrl(rawUrl);
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  const maxPages = Math.max(1, Math.min(20, options?.maxPages ?? DEFAULT_MAX_PAGES));
  const stopAtFirstUsableEmail = options?.stopAtFirstUsableEmail === true;
  const origin = new URL(url).origin;
  const tryWithWww = !/^https?:\/\/www\./i.test(url);
  const wwwOrigin = tryWithWww ? origin.replace(/^https?:\/\//i, (m) => `${m}www.`) : null;

  const allEmails = new Set<string>();
  const checkedUrls: string[] = [];
  const checkedNormalized = new Set<string>();

  // Helper: have we collected at least one email that survives the
  // junk filter? Cheap enough to call between pages — filterJunkEmails
  // is pure regex on a small set. Used for early-exit when caller
  // opted in via stopAtFirstUsableEmail.
  const hasUsableEmail = (): boolean =>
    stopAtFirstUsableEmail &&
    allEmails.size > 0 &&
    filterJunkEmails(Array.from(allEmails)).length > 0;

  const normalizeForDedupe = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '');

  const processPage = (html: string) => {
    for (const e of extractEmailsFromHtmlAdvanced(html)) allEmails.add(e);
  };

  const tryFetch = async (pageUrl: string): Promise<string | null> => {
    const normalized = normalizeForDedupe(pageUrl);
    if (checkedNormalized.has(normalized)) return null;
    if (checkedUrls.length >= maxPages) return null;
    if (signal?.aborted) return null;

    checkedNormalized.add(normalized);
    checkedUrls.push(pageUrl);
    return fetchPageWithRetry(pageUrl, { timeout, signal });
  };

  // 1. Fetch main page
  let mainHtml = await tryFetch(url);
  if (!mainHtml && tryWithWww && wwwOrigin) {
    mainHtml = await tryFetch(wwwOrigin);
  }

  // Название компании берём с главной (og:site_name / <title>) — бесплатно,
  // страница уже загружена. Используется как фоллбек когда нет имени из ФНС.
  const siteName = mainHtml ? extractSiteName(mainHtml) : null;

  // Discover internal links from main page
  let discoveredLinks: string[] = [];
  if (mainHtml) {
    processPage(mainHtml);
    // Early-exit: if the main page already gave us a usable address,
    // skip the link discovery + candidate crawl. Saves up to 4 extra
    // fetches per company. The typical healthy B2B site has its
    // contact email on the homepage or in the header, so this lands
    // on most rows. Opt-in per caller via stopAtFirstUsableEmail.
    if (hasUsableEmail()) {
      const allEmailsRawEarly = Array.from(allEmails);
      return {
        emails: filterJunkEmails(allEmailsRawEarly),
        allEmailsRaw: allEmailsRawEarly,
        checkedUrls,
        pagesScanned: checkedUrls.length,
        siteName,
      };
    }
    discoveredLinks = await discoverEmailPageLinks(mainHtml, url);
  }

  // 2. Build candidate pages: discovered links first, then static paths
  const candidateUrls: string[] = [];
  const candidateSeen = new Set<string>();

  const addCandidate = (u: string) => {
    const norm = normalizeForDedupe(u);
    if (candidateSeen.has(norm)) return;
    candidateSeen.add(norm);
    candidateUrls.push(u);
  };

  // Discovered links from page have highest priority
  for (const link of discoveredLinks) addCandidate(link);

  // Static paths for primary origin
  for (const path of ALL_STATIC_PATHS) addCandidate(`${origin}${path}`);

  // Static paths for www variant
  if (wwwOrigin) {
    for (const path of ALL_STATIC_PATHS) addCandidate(`${wwwOrigin}${path}`);
  }

  // 3. Crawl candidate pages (all of them, up to maxPages). Break early
  // after each successful page if caller asked for stopAtFirstUsableEmail
  // and we already have a clean address — same rationale as the post-
  // main-page check above. Bail on first satisfied iteration.
  for (const candidate of candidateUrls) {
    if (signal?.aborted) break;
    if (checkedUrls.length >= maxPages) break;
    const html = await tryFetch(candidate);
    if (html) processPage(html);
    if (hasUsableEmail()) break;
  }

  // 4. Filter and return
  const allEmailsRaw = Array.from(allEmails);
  const filtered = filterJunkEmails(allEmailsRaw);

  return {
    emails: filtered,
    allEmailsRaw,
    checkedUrls,
    pagesScanned: checkedUrls.length,
    siteName,
  };
}
