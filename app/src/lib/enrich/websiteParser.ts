import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_TEXT_LENGTH = 3000;
const FETCH_RETRIES = 1;
const FETCH_RETRY_DELAY_MS = 300;
const MIN_TEXT_LENGTH = 30;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ABOUT_PATHS = [
  '/about',
  '/about-us',
  '/about-company',
  '/aboutus',
  '/o-nas',
  '/o-kompanii',
  '/company',
  '/company/about',
  '/о-компании',
  '/о-нас',
  '/kompaniya',
  '/info',
  '/who-we-are',
  '/our-story',
  '/pages/about',
  '/pages/about-us',
];
const URL_TOKEN_REGEX = /(https?:\/\/[^\s]+|[\w.-]+\.[a-z]{2,}[^\s]*)/i;
const META_DESCRIPTION_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:description"]',
  'meta[name="twitter:description"]',
];
const TITLE_SELECTORS = ['title', 'meta[property="og:title"]', 'meta[name="twitter:title"]'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isHtmlLikeContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.startsWith('text/plain') ||
    ct.includes('text/xml') ||
    ct.includes('application/xml')
  );
}

/**
 * Normalise a raw string into a valid `https://` URL.
 * Throws if the value cannot be turned into a URL.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Пустой URL');
  const tokenMatch = trimmed.match(URL_TOKEN_REGEX);
  const candidate = tokenMatch ? tokenMatch[0] : trimmed;
  const cleaned = candidate.replace(/[),.;]+$/g, '');
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Невалидный URL: ${trimmed}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Неподдерживаемый протокол: ${parsed.protocol}`);
  }

  // Basic hostname check: at least one dot
  if (!parsed.hostname.includes('.')) {
    throw new Error(`Невалидный домен: ${parsed.hostname}`);
  }

  return parsed.href;
}

/**
 * Clean extracted text: remove web artifacts, stray symbols, fix formatting.
 */
export function sanitizeText(text: string): string {
  let s = text;

  // 1. Remove zero-width and invisible Unicode characters
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u180E]/g, '');

  // 2. Normalise whitespace characters to regular equivalents
  //    Non-breaking spaces, thin/hair/en/em spaces → regular space
  s = s.replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F]/g, ' ');

  // 3. Decode common leftover HTML entities
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#\d{1,5};/g, '') // remove remaining numeric entities
    .replace(/&[a-z]+;/gi, '');  // remove remaining named entities

  // 4. Remove common decorative / UI symbols that clutter text
  s = s.replace(/[★☆▶►▷▸▹◀◁◂◃♦♢♣♠❤❥✦✧✩✪✫✬✭✮✯✰⬤⬥⬧⬨⬩⭐⭑⭒🔸🔹🔶🔷]/g, '');

  // 5. Normalise bullet-like characters to a simple dash
  s = s.replace(/[•◦▪▫●○■□▲△▼▽◆◇⬜⬛⚫⚪🔴🟢🟡🔵⭕]/g, '- ');

  // 6. Normalise dash/hyphen variants to a regular dash
  s = s.replace(/[–—―‒⁃‣⁌⁍]/g, '-');

  // 7. Normalise quote variants
  s = s.replace(/[""„‟«»‹›❝❞❛❜''‚‛]/g, '"');

  // 8. Normalise ellipsis
  s = s.replace(/…/g, '...');
  s = s.replace(/\.{4,}/g, '...');

  // 9. Collapse repeated punctuation (!!!, ???, ?!?!)
  s = s.replace(/!{2,}/g, '!');
  s = s.replace(/\?{2,}/g, '?');
  s = s.replace(/([?!])\1+/g, '$1');

  // 10. Remove stray arrow/navigation symbols
  s = s.replace(/[←→↑↓↔↕⇐⇒⇑⇓⇔⇕➔➜➡➤➥➦➧➨➩➪➫➬➭➮➯➱⟶⟵⟷⟹⟸⟺]/g, '');

  // 11. Collapse whitespace
  s = s.replace(/[\t ]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');

  // 12. Clean up each line
  s = s
    .split('\n')
    .map((line) => line.trim())
    // Remove lines that are only punctuation / symbols / very short noise
    .filter((line) => {
      if (line.length === 0) return true; // keep blank lines for paragraph separation
      // Remove lines that are only symbols, punctuation, or whitespace
      if (/^[\s\-_=|:;.,!?*#/\\<>@^~`'"()\[\]{}+&%$]+$/.test(line)) return false;
      // Remove lines shorter than 3 chars (usually UI artefacts like "X", ">", "|")
      if (line.length < 3) return false;
      return true;
    })
    .join('\n');

  // 13. Collapse 3+ blank lines → double newline
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

/**
 * Extract readable text from an HTML string using cheerio.
 * Strips scripts, styles, nav, footer, etc.
 */
export function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, noscript, iframe, svg, link, meta, header, footer, nav').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  $('form, .cookie-banner, .cookie-consent, #cookie-banner, #cookie-consent').remove();
  // Remove social sharing / widget blocks
  $('[class*="share"], [class*="social"], [class*="widget"], [id*="sidebar"]').remove();
  // Remove popup / modal overlays
  $('[class*="popup"], [class*="modal"], [class*="overlay"], [class*="backdrop"]').remove();
  // Remove breadcrumbs
  $('[class*="breadcrumb"], [aria-label="breadcrumb"], nav, .pagination').remove();

  // Prefer main content areas if available
  let textSource = $('main, article, [role="main"]');
  if (textSource.length === 0) {
    textSource = $('body');
  }

  // Get text, collapsing whitespace
  const raw = textSource.text();
  const cleaned = sanitizeText(raw);

  if (cleaned.length >= MIN_TEXT_LENGTH) return cleaned;

  const title = TITLE_SELECTORS
    .map((selector) => $(selector).attr('content') ?? $(selector).text())
    .map((value) => (value ?? '').trim())
    .find((value) => value.length > 0);
  const description = META_DESCRIPTION_SELECTORS
    .map((selector) => $(selector).attr('content') ?? '')
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  const fallback = [title, description].filter(Boolean).join('\n').trim();
  return fallback.length > cleaned.length ? fallback : cleaned;
}

/**
 * Regex patterns to identify "about"-like links by href or link text.
 */
const ABOUT_HREF_PATTERN =
  /\/(about|about[_-]?us|about[_-]?company|o[_-]?nas|o[_-]?kompanii|company|who[_-]?we[_-]?are|our[_-]?story|info|kompaniya|о-компании|о-нас)(\/|$|\?|#)/i;
const ABOUT_TEXT_PATTERN =
  /\b(about(\s+us)?|о\s*компании|о\s*нас|компания|кто\s+мы|наша\s+история|who\s+we\s+are|our\s+story|our\s+company)\b/i;

/**
 * Build a list of candidate "about" page URLs for a given base URL.
 */
export function getAboutCandidates(baseUrl: string): string[] {
  const parsed = new URL(baseUrl);
  // Only use the origin (strip path, query, hash)
  const origin = parsed.origin;
  return ABOUT_PATHS.map((path) => `${origin}${path}`);
}

/**
 * Discover "about" page links from the HTML of a fetched page.
 * Returns unique absolute URLs that look like about pages.
 */
export function discoverAboutLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const results: string[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    // Skip anchors, mailto, tel, javascript
    if (/^(#|mailto:|tel:|javascript:)/i.test(href.trim())) return;

    const linkText = $(el).text().trim();
    const hrefMatches = ABOUT_HREF_PATTERN.test(href);
    const textMatches = ABOUT_TEXT_PATTERN.test(linkText);

    if (!hrefMatches && !textMatches) return;

    // Resolve relative URLs
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    // Only follow links on the same origin
    if (!absoluteUrl.startsWith(origin)) return;

    // Deduplicate
    const normalized = absoluteUrl.replace(/[#?].*$/, '').replace(/\/+$/, '');
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(absoluteUrl);
  });

  return results;
}

/**
 * Fetch a single URL and return its HTML body as a string.
 * Returns `null` on any network / HTTP error.
 */
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
  const questionMarks = (sample.match(/\?/g) ?? []).length;
  return bad >= 8 || questionMarks >= 40 || sample.includes('����');
}

function decodeHtml(body: ArrayBuffer, contentType: string | null): string {
  const buffer = Buffer.from(body);
  const headerMatch = contentType?.match(/charset=([^;]+)/i);
  const headerCharset = headerMatch ? headerMatch[1].trim().toLowerCase() : null;

  const decodeWith = (charset: string) => (iconv.encodingExists(charset) ? iconv.decode(buffer, charset) : '');

  if (headerCharset) {
    const decoded = decodeWith(headerCharset);
    if (decoded) return decoded;
  }

  // First try UTF-8
  const decoded = new TextDecoder('utf-8').decode(buffer);
  const metaCharset = extractCharsetFromMeta(decoded);
  if (metaCharset && metaCharset !== 'utf-8' && metaCharset !== 'utf8') {
    const metaDecoded = decodeWith(metaCharset);
    if (metaDecoded) return metaDecoded;
  }

  if (!looksLikeBrokenUtf8(decoded)) {
    return decoded;
  }

  // Fallbacks for common Russian encodings
  const cp1251 = decodeWith('windows-1251');
  if (cp1251) return cp1251;
  const koi8 = decodeWith('koi8-r');
  if (koi8) return koi8;

  return decoded;
}

async function fetchHtml(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal; allowHttpErrors?: boolean },
): Promise<{ html: string; status: number } | null> {
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // If the caller provides an external signal, abort our controller when it fires
  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!options?.allowHttpErrors && res.status >= 400) return null;
    if (res.status >= 500) return null;

    const contentType = res.headers.get('content-type');
    if (!isHtmlLikeContentType(contentType)) {
      return null;
    }

    const body = await res.arrayBuffer();
    const html = decodeHtml(body, contentType);
    return { html, status: res.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function fetchHtmlWithRetry(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal; allowHttpErrors?: boolean },
): Promise<{ html: string; status: number } | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    const result = await fetchHtml(url, options);
    if (result) return result;
    if (options?.signal?.aborted) return null;
    if (attempt < FETCH_RETRIES) {
      await sleep(FETCH_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return null;
}

/**
 * Fetch the main page and about page of a website and return combined extracted text.
 * About pages are prioritised: fetched first and placed first in the output.
 */
export async function fetchAndExtract(
  rawUrl: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<string> {
  const url = normalizeUrl(rawUrl);
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  const tryWithWww = !/^https?:\/\/www\./i.test(url);
  const origin = new URL(url).origin;
  const wwwOrigin = tryWithWww ? origin.replace(/^https?:\/\//i, (m) => `${m}www.`) : origin;
  const httpOrigin = origin.replace(/^https:\/\//i, 'http://');

  /* ── 1. Fetch the main page (needed both for text and for link discovery) ── */
  let mainHtml: { html: string; status: number } | null = null;
  let mainText = '';
  let hadAnyHtml = false;

  mainHtml = await fetchHtmlWithRetry(url, { timeout, signal, allowHttpErrors: true });
  if (mainHtml) {
    mainText = extractTextFromHtml(mainHtml.html);
    hadAnyHtml = true;
  }
  if (!mainText && tryWithWww) {
    const wwwHtml = await fetchHtmlWithRetry(`${wwwOrigin}`, {
      timeout,
      signal,
      allowHttpErrors: true,
    });
    if (wwwHtml) {
      mainHtml = wwwHtml;
      mainText = extractTextFromHtml(wwwHtml.html);
      hadAnyHtml = true;
    }
  }
  if (!mainText && origin.startsWith('https://')) {
    const httpHtml = await fetchHtmlWithRetry(`${httpOrigin}`, {
      timeout,
      signal,
      allowHttpErrors: true,
    });
    if (httpHtml) {
      mainHtml = httpHtml;
      mainText = extractTextFromHtml(httpHtml.html);
      hadAnyHtml = true;
    }
  }

  /* ── 2. Discover about-page links from main page HTML ── */
  const discoveredLinks = mainHtml ? discoverAboutLinks(mainHtml.html, url) : [];

  /* ── 3. Build about-page candidate list: discovered links first, then static paths ── */
  const staticCandidates = [
    ...getAboutCandidates(origin),
    ...(tryWithWww ? getAboutCandidates(wwwOrigin) : []),
    ...(origin.startsWith('https://') ? getAboutCandidates(httpOrigin) : []),
  ];

  // Deduplicate: discovered links have priority
  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const c of [...discoveredLinks, ...staticCandidates]) {
    const key = c.replace(/\/+$/, '').replace(/^https?:\/\//i, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip candidates that are identical to the main page
    if (c.replace(/\/+$/, '') === url.replace(/\/+$/, '')) continue;
    allCandidates.push(c);
  }

  /* ── 4. Fetch about pages (priority!) ── */
  let aboutText = '';
  for (const candidate of allCandidates) {
    if (signal?.aborted) break;
    const html = await fetchHtmlWithRetry(candidate, { timeout, signal });
    if (html) {
      const text = extractTextFromHtml(html.html);
      hadAnyHtml = true;
      if (text.length >= MIN_TEXT_LENGTH) {
        aboutText = text;
        break;
      }
    }
  }

  /* ── 5. Combine: about page FIRST (priority), then main page ── */
  let combined: string;
  if (aboutText.length > 0 && mainText.length > 0) {
    // About page content has priority — placed first so it doesn't get truncated
    combined = `--- О компании ---\n${aboutText}\n\n--- Главная ---\n${mainText}`;
  } else if (aboutText.length > 0) {
    combined = aboutText;
  } else if (mainText.length > 0) {
    combined = mainText;
  } else if (hadAnyHtml) {
    combined = 'Страница доступна, но требует JavaScript или блокирует парсер.';
  } else {
    throw new Error('Не удалось получить HTML с сайта');
  }

  // Final sanitization pass on the combined text
  combined = sanitizeText(combined);

  // Truncate to max length
  if (combined.length > MAX_TEXT_LENGTH) {
    return combined.slice(0, MAX_TEXT_LENGTH).trimEnd() + '…';
  }

  return combined;
}
