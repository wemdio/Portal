import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_TEXT_LENGTH = 3000;
const FETCH_RETRIES = 1;
const FETCH_RETRY_DELAY_MS = 300;
const MIN_TEXT_LENGTH = 30;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ABOUT_PATHS = ['/about', '/about-us', '/aboutus', '/o-nas', '/company', '/о-компании'];
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
 * Extract readable text from an HTML string using cheerio.
 * Strips scripts, styles, nav, footer, etc.
 */
export function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, noscript, iframe, svg, link, meta, header, footer, nav').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  $('form, .cookie-banner, .cookie-consent, #cookie-banner, #cookie-consent').remove();

  // Prefer main content areas if available
  let textSource = $('main, article, [role="main"]');
  if (textSource.length === 0) {
    textSource = $('body');
  }

  // Get text, collapsing whitespace
  const raw = textSource.text();
  const cleaned = raw
    .replace(/[\t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
 * Build a list of candidate "about" page URLs for a given base URL.
 */
export function getAboutCandidates(baseUrl: string): string[] {
  const parsed = new URL(baseUrl);
  // Only use the origin (strip path, query, hash)
  const origin = parsed.origin;
  return ABOUT_PATHS.map((path) => `${origin}${path}`);
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

  // Fetch the main page
  const mainHtml = await fetchHtmlWithRetry(url, { timeout, signal, allowHttpErrors: true });
  let mainText = mainHtml ? extractTextFromHtml(mainHtml.html) : '';
  let hadAnyHtml = Boolean(mainHtml);
  if (!mainText && tryWithWww) {
    const wwwHtml = await fetchHtmlWithRetry(`${wwwOrigin}`, {
      timeout,
      signal,
      allowHttpErrors: true,
    });
    if (wwwHtml) {
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
      mainText = extractTextFromHtml(httpHtml.html);
      hadAnyHtml = true;
    }
  }

  // Try about pages
  const candidates = getAboutCandidates(url);
  const wwwCandidates = tryWithWww ? getAboutCandidates(wwwOrigin) : [];
  const httpCandidates = origin.startsWith('https://') ? getAboutCandidates(httpOrigin) : [];
  let aboutText = '';

  for (const candidate of [...candidates, ...wwwCandidates, ...httpCandidates]) {
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

  // Combine: prefer about if longer, otherwise main + about
  let combined: string;
  if (aboutText.length > 0 && mainText.length > 0) {
    combined = `--- Главная ---\n${mainText}\n\n--- О компании ---\n${aboutText}`;
  } else if (aboutText.length > 0) {
    combined = aboutText;
  } else if (mainText.length > 0) {
    combined = mainText;
  } else if (hadAnyHtml) {
    combined = 'Страница доступна, но требует JavaScript или блокирует парсер.';
  } else {
    throw new Error('Не удалось получить HTML с сайта');
  }

  // Truncate to max length
  if (combined.length > MAX_TEXT_LENGTH) {
    return combined.slice(0, MAX_TEXT_LENGTH).trimEnd() + '…';
  }

  return combined;
}
