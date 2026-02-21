import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { buildAboutCandidates, DEFAULT_MAX_ABOUT_CANDIDATES } from '@/lib/enrich/aboutCandidates';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import { extractEmailsFromHtml } from '@/lib/enrich/emailExtractor';
import type { Browser } from 'playwright';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_TEXT_LENGTH = 3000;
const FETCH_RETRIES = 1;
const FETCH_RETRY_DELAY_MS = 300;
const MIN_TEXT_LENGTH = 30;
const MAX_ABOUT_CANDIDATES = Number(
  process.env.WEBSITE_ENRICHMENT_MAX_ABOUT_CANDIDATES ?? String(DEFAULT_MAX_ABOUT_CANDIDATES),
);
const MIN_MAIN_TEXT_TO_SKIP_ABOUT = Number(
  process.env.WEBSITE_ENRICHMENT_MIN_MAIN_TEXT_TO_SKIP_ABOUT ?? '220',
);

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
const META_DESCRIPTION_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:description"]',
  'meta[name="twitter:description"]',
];
const TITLE_SELECTORS = ['title', 'meta[property="og:title"]', 'meta[name="twitter:title"]'];
const BRAND_META_SELECTORS = [
  'meta[property="og:site_name"]',
  'meta[name="application-name"]',
  'meta[name="apple-mobile-web-app-title"]',
] as const;
const BRAND_TITLE_BAD_WORDS = /(главная|home|о компании|о нас|контакты|contacts|about( us)?|company|страница)/i;
const CONTACT_PATHS = [
  '/contact',
  '/contact/',
  '/contacts',
  '/contacts/',
  '/kontakty',
  '/kontakty/',
  '/kontakt',
  '/kontakt/',
  '/контакты',
  '/контакты/',
  '/obratnaya-svyaz',
  '/obratnaya-svyaz/',
  '/feedback',
  '/feedback/',
  '/support',
  '/support/',
];
const CONTACT_HREF_PATTERN =
  /\/(contact|contacts|kontakty|kontakt|kontakti|obratnaya[-_]?svyaz|feedback|support|контакты)(\/|$|\?|#)/i;
const CONTACT_TEXT_PATTERN =
  /\b(contact|contacts|контакты|обратн(ая|ой)\s+связ(ь|и)|написать|связаться|телефон|email|почта|support)\b/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let playwrightBrowserPromise: Promise<Browser> | null = null;

async function getPlaywrightBrowser(): Promise<Browser | null> {
  try {
    const pw = await import('playwright');
    playwrightBrowserPromise ??= pw.chromium.launch({ headless: true });
    return await playwrightBrowserPromise;
  } catch {
    return null;
  }
}

async function fetchHtmlWithPlaywright(
  url: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<string | null> {
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  const browser = await getPlaywrightBrowser();
  if (!browser) return null;
  if (signal?.aborted) return null;

  const context = await browser.newContext({
    userAgent: BROWSER_USER_AGENT,
    viewport: { width: 1365, height: 768 },
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  // Speed up: don't load heavy assets
  await page.route('**/*', async (route) => {
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

  const abortListener = () => {
    try {
      void page.close();
    } catch {
      // ignore
    }
  };
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // Give client-side rendering a moment (contacts/emails often injected)
    await page.waitForTimeout(900 + Math.round(Math.random() * 900));
    const html = await page.content();
    return html && html.length > 120 ? html : null;
  } catch {
    return null;
  } finally {
    signal?.removeEventListener('abort', abortListener);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

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

export { normalizeUrl } from '@/lib/enrich/urlUtils';

function normalizeBrandCandidate(value: string) {
  return value
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyJunkBrand(value: string) {
  const s = value.trim();
  if (!s) return true;
  if (/^(null|undefined|n\/a)$/i.test(s)) return true;
  // hex colors like #fff or #ffffff
  if (/^#?[0-9a-f]{3,8}$/i.test(s)) return true;
  // URLs / domains are not brand names here
  if (/^https?:\/\//i.test(s)) return true;
  return false;
}

function splitSeoTitleToBrand(title: string): string | null {
  const cleaned = normalizeBrandCandidate(title);
  if (!cleaned) return null;

  // Pattern: "Something | Brand"
  const pipeParts = cleaned.split(' | ').map((s) => s.trim()).filter((s) => s.length >= 2);
  if (pipeParts.length >= 2) {
    const last = pipeParts[pipeParts.length - 1];
    if (last && last.length <= 80 && !BRAND_TITLE_BAD_WORDS.test(last)) return last;
  }

  // Pattern: "Brand — Something"
  const dashParts = cleaned.split(/\s+[—–]\s+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  if (dashParts.length >= 2) {
    const first = dashParts[0];
    if (first && first.length <= 80 && !BRAND_TITLE_BAD_WORDS.test(first)) return first;
  }

  // If it's already short and not generic, accept.
  if (cleaned.length <= 80 && !BRAND_TITLE_BAD_WORDS.test(cleaned)) return cleaned;
  return null;
}

function extractBrandFromJsonLd($: cheerio.CheerioAPI): string | null {
  const scripts = $('script[type="application/ld+json"]');
  for (const el of scripts.toArray()) {
    const raw = ($(el).text() ?? '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const queue: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      while (queue.length) {
        const rawNode = queue.shift();
        if (!rawNode || typeof rawNode !== 'object') continue;
        const node = rawNode as Record<string, unknown>;
        const type = node['@type'];
        const types = Array.isArray(type) ? type : type ? [type] : [];
        const looksOrg = types.some((t: unknown) =>
          typeof t === 'string' ? /(Organization|LocalBusiness|Corporation|ProfessionalService)/i.test(t) : false,
        );
        const nameRaw = node['name'];
        if (looksOrg && typeof nameRaw === 'string') {
          const name = normalizeBrandCandidate(nameRaw);
          if (name && name.length >= 2 && name.length <= 120 && !BRAND_TITLE_BAD_WORDS.test(name)) return name;
        }
        // common nesting
        const nested = [node['publisher'], node['author'], node['organization'], node['brand']].filter(Boolean);
        for (const n of nested) queue.push(n);
        const graph = node['@graph'];
        if (Array.isArray(graph)) {
          for (const g of graph) queue.push(g);
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }
  return null;
}

function extractBrandFromHeading($: cheerio.CheerioAPI): string | null {
  const h1 = normalizeBrandCandidate($('h1').first().text() ?? '');
  if (!h1) return null;
  // Common RU headings: "О компании Взлёт Медиа"
  const cleaned = h1
    .replace(/^(о\s+компании|о\s+нас|about(\s+us)?|company)\s+/i, '')
    .replace(/[—–-]\s*$/, '')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length < 2 || cleaned.length > 120) return null;
  if (BRAND_TITLE_BAD_WORDS.test(cleaned)) return null;
  if (isLikelyJunkBrand(cleaned)) return null;
  // Avoid returning full marketing slogans
  if (/(рейтинг|топ|лучши|обзор|каталог|список|реестр)/i.test(cleaned)) return null;
  return cleaned;
}

function extractBrandFromCopyrightText($: cheerio.CheerioAPI): string | null {
  const cleanLegalTail = (value: string) => {
    return normalizeBrandCandidate(value)
      // strip requisites
      .replace(/[,;]?\s*\b(ИНН|ОГРН|ОГРНИП|КПП)\b[:\s]*\d[\d\s-]{4,}/gi, '')
      // strip trailing dot/comma
      .replace(/[.,;:\s]+$/g, '')
      .trim()
      .slice(0, 160);
  };

  const validate = (value: string) => {
    const s = value.trim();
    if (!s) return null;
    if (s.length < 2 || s.length > 160) return null;
    if (BRAND_TITLE_BAD_WORDS.test(s)) return null;
    if (isLikelyJunkBrand(s)) return null;
    if (/(рейтинг|топ|лучши|обзор|каталог|список|реестр)/i.test(s)) return null;
    return s;
  };

  // Try footer-like nodes first (more likely to contain the canonical brand)
  const candidates: string[] = [];
  const pushText = (sel: string) => {
    const t = normalizeBrandCandidate($(sel).text() ?? '');
    if (t) candidates.push(t);
  };

  // Prefer explicit strong/b text inside the element that contains © (common for legal entities)
  const richCandidates: string[] = [];
  const pushStrongFrom = (sel: string) => {
    $(sel)
      .filter((_, el) => normalizeBrandCandidate($(el).text() ?? '').includes('©'))
      .each((_, el) => {
        const strongText = normalizeBrandCandidate($(el).find('strong, b').first().text() ?? '');
        if (strongText) richCandidates.push(strongText);
      });
  };

  pushStrongFrom('[class*="copyright" i]');
  pushStrongFrom('footer');
  pushStrongFrom('[class*="footer" i]');

  for (const raw of richCandidates) {
    const cleaned = cleanLegalTail(raw);
    const ok = validate(cleaned);
    if (ok) return ok;
  }

  pushText('footer');
  pushText('[class*="copyright" i]');
  pushText('[class*="footer" i] [class*="copyright" i]');
  pushText('[class*="footer" i]');

  // Add a small body sample as a fallback (avoid scanning all text)
  const bodySample = normalizeBrandCandidate($('body').text().slice(0, 4000));
  if (bodySample) candidates.push(bodySample);

  for (const text of candidates) {
    // Examples:
    // "© 1999 — 2026 VZLЁT MEDIA"
    // "© 2010-2026 COMPANYNAME"
    const m =
      text.match(/©\s*\d{4}\s*(?:[—–-]\s*\d{4})?\s*([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\s.&'’"_-]{2,})/u) ??
      null;
    const raw = m?.[1]?.trim() ?? '';
    if (!raw) continue;

    // Clean trailing punctuation / cookie blabla
    const cleaned = cleanLegalTail(
      raw
      .replace(/\s{2,}/g, ' ')
      .replace(/[|•·].*$/, '')
      .trim(),
    );

    const ok = validate(cleaned);
    if (ok) return ok;
  }

  return null;
}

function extractBrandFromLogoAssets($: cheerio.CheerioAPI): string | null {
  const urls: string[] = [];
  const pushUrl = (raw: string | undefined | null) => {
    const s = String(raw ?? '').trim();
    if (!s) return;
    urls.push(s);
  };

  // Meta images often point at a logo on corporate sites.
  pushUrl($('meta[property="og:image"]').attr('content'));
  pushUrl($('meta[name="twitter:image"]').attr('content'));
  pushUrl($('link[rel="icon"]').attr('href'));
  pushUrl($('link[rel="shortcut icon"]').attr('href'));
  pushUrl($('link[rel="apple-touch-icon"]').attr('href'));

  // Tilda common pattern: <a href="/"><img class="tn-atom__img t-img ..." src|data-original=".../BRAND.svg"></a>
  // Treat this as a strong "logo" signal even if the filename doesn't contain "logo".
  $('a[href="/"] img[src], a[href="/"] img[data-original]').each((_, el) => {
    if (urls.length >= 14) return;
    const img = $(el);
    const cls = (img.attr('class') ?? '').toLowerCase();
    const isTildaImg = cls.includes('tn-atom__img') || cls.includes('t-img');
    if (!isTildaImg) return;
    const src = (img.attr('src') ?? '').trim();
    const dataOriginal = (img.attr('data-original') ?? '').trim();
    pushUrl(dataOriginal || src);
  });

  // Heuristic: logo-like <img> candidates
  $('img[src]').each((_, el) => {
    if (urls.length >= 14) return;
    const src = ($(el).attr('src') ?? '').trim();
    const cls = ($(el).attr('class') ?? '').toLowerCase();
    const id = ($(el).attr('id') ?? '').toLowerCase();
    const dataOriginal = ($(el).attr('data-original') ?? '').trim(); // some lazy-loaders
    const looksLogo =
      /logo|logotype|brand|header/i.test(src) ||
      cls.includes('tn-atom__img') || // Tilda often uses this class for logo as well
      cls.includes('logo') ||
      id.includes('logo') ||
      /logo|logotype/i.test(dataOriginal);
    if (!looksLogo) return;
    pushUrl(dataOriginal || src);
  });

  const stopTokens = new Set(
    [
      'logo',
      'logotype',
      'brand',
      'icon',
      'favicon',
      'header',
      'footer',
      'img',
      'image',
      'pic',
      'photo',
      'tilda',
      'cdn',
      'static',
    ].map((s) => s.toLowerCase()),
  );

  const extractFromUrl = (u: string) => {
    const raw = u.split('#')[0]?.split('?')[0] ?? u;
    const last = raw.split('/').filter(Boolean).pop() ?? '';
    if (!last) return null;
    const decoded = normalizeBrandCandidate(decodeURIComponent(last));
    if (!decoded) return null;
    // Strip file extension
    const noExt = decoded.replace(/\.(png|jpe?g|webp|gif|svg|ico)$/i, '');
    if (!noExt) return null;

    // Remove common suffix/prefix "logo"
    const cleaned = noExt
      .replace(/(^|[_\-\s])logo(type)?($|[_\-\s])/gi, '$1')
      .replace(/[_\-\s]{2,}/g, ' ')
      .trim();
    if (!cleaned) return null;

    // Split by separators; keep original casing for the remaining tokens.
    const parts = cleaned
      .split(/[\s_\-]+/g)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !stopTokens.has(p.toLowerCase()));

    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0]!.slice(0, 120);

    const joined = parts.join(' ').slice(0, 120);
    return joined;
  };

  for (const u of urls) {
    const candidate = extractFromUrl(u);
    if (!candidate) continue;
    if (candidate.length < 2 || candidate.length > 120) continue;
    if (BRAND_TITLE_BAD_WORDS.test(candidate)) continue;
    if (isLikelyJunkBrand(candidate)) continue;
    if (/(рейтинг|топ|лучши|обзор|каталог|список|реестр|ваканс|новост|блог|статья)/i.test(candidate)) continue;
    return candidate;
  }

  return null;
}

export function extractBrandNameFromHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 1) JSON-LD Organization name
  const fromJsonLd = extractBrandFromJsonLd($);
  if (fromJsonLd) return fromJsonLd;

  // 2) Meta selectors
  for (const selector of BRAND_META_SELECTORS) {
    const value = $(selector).attr('content') ?? '';
    const candidate = normalizeBrandCandidate(value);
    if (
      candidate &&
      candidate.length >= 2 &&
      candidate.length <= 120 &&
      !BRAND_TITLE_BAD_WORDS.test(candidate) &&
      !isLikelyJunkBrand(candidate)
    ) {
      return candidate;
    }
  }

  // 3) Logo assets (Tilda/corporate sites often encode brand in filename)
  const fromLogo = extractBrandFromLogoAssets($);
  if (fromLogo) return fromLogo;

  // 4) h1 fallback (useful for pages like /company, /about)
  const fromH1 = extractBrandFromHeading($);
  if (fromH1) return fromH1;

  // 5) Footer copyright (often the only canonical brand)
  const fromCopyright = extractBrandFromCopyrightText($);
  if (fromCopyright) return fromCopyright;

  // 6) Title / og:title as a last resort (but split SEO titles)
  const title = TITLE_SELECTORS
    .map((selector) => $(selector).attr('content') ?? $(selector).text())
    .map((value) => normalizeBrandCandidate(value ?? ''))
    .find((value) => value.length > 0);
  if (title) {
    const candidate = splitSeoTitleToBrand(title);
    if (candidate) return candidate;
  }

  return null;
}

/**
 * Clean extracted text: remove web artifacts, stray symbols, fix formatting.
 */
export function sanitizeText(text: string): string {
  let s = text;

  // 1. Remove zero-width and invisible Unicode characters
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

function normalizeForDedupe(url: string): string {
  return url.replace(/[#?].*$/, '').replace(/\/+$/, '');
}

export function discoverContactLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const results: string[] = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return;

    const linkText = ($(el).text() ?? '').trim();
    const hrefMatches = CONTACT_HREF_PATTERN.test(href);
    const textMatches = CONTACT_TEXT_PATTERN.test(linkText);
    if (!hrefMatches && !textMatches) return;

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    if (!absoluteUrl.startsWith(origin)) return;
    const normalized = normalizeForDedupe(absoluteUrl);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(absoluteUrl);
  });

  return results;
}

function buildContactCandidates(baseUrl: string, discovered: string[]): string[] {
  const origin = new URL(baseUrl).origin;
  const staticCandidates = CONTACT_PATHS.map((p) => `${origin}${p}`);
  const seen = new Set<string>();
  const all = [...discovered, ...staticCandidates];
  const results: string[] = [];
  for (const u of all) {
    const normalized = normalizeForDedupe(u);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(u);
  }
  return results;
}

export async function fetchWebsiteEmails(
  rawUrl: string,
  options?: { timeout?: number; signal?: AbortSignal; maxPages?: number },
): Promise<{ emails: string[]; checked_urls: string[]; brand_name: string | null }> {
  const url = normalizeUrl(rawUrl);
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  const maxPages = Math.max(1, Math.min(12, options?.maxPages ?? 6));

  const checked: string[] = [];
  const found = new Set<string>();
  let brandName: string | null = null;

  // 1) Fetch main page HTML to discover contact links + mailto in header/footer.
  const main = await fetchHtmlWithRetry(url, { timeout, signal, allowHttpErrors: true });
  if (main?.html) {
    checked.push(url);
    for (const e of extractEmailsFromHtml(main.html)) found.add(e);
    brandName = extractBrandNameFromHtml(main.html) ?? brandName;
    const discovered = discoverContactLinks(main.html, url);
    const candidates = buildContactCandidates(url, discovered);

    // Prefer discovered links first; cap by maxPages
    for (const candidate of candidates.slice(0, maxPages)) {
      if (signal?.aborted) break;
      const normalized = normalizeForDedupe(candidate);
      if (checked.some((c) => normalizeForDedupe(c) === normalized)) continue;
      const html = await fetchHtmlWithRetry(candidate, { timeout, signal, allowHttpErrors: true });
      checked.push(candidate);
      if (html?.html) {
        for (const e of extractEmailsFromHtml(html.html)) found.add(e);
        brandName = extractBrandNameFromHtml(html.html) ?? brandName;
        if (found.size > 0) break;
      }
    }
  } else {
    // Even if main failed, still try static contact paths.
    const candidates = buildContactCandidates(url, []);
    for (const candidate of candidates.slice(0, maxPages)) {
      if (signal?.aborted) break;
      const html = await fetchHtmlWithRetry(candidate, { timeout, signal, allowHttpErrors: true });
      checked.push(candidate);
      if (html?.html) {
        for (const e of extractEmailsFromHtml(html.html)) found.add(e);
        brandName = extractBrandNameFromHtml(html.html) ?? brandName;
        if (found.size > 0) break;
      }
    }
  }

  // Playwright fallback: if nothing was found, try rendering 1-2 key pages.
  // This helps for sites that inject contacts via JS or show minimal HTML to bots.
  if (found.size === 0) {
    const tryPw = async (candidateUrl: string) => {
      if (signal?.aborted) return;
      const normalized = normalizeForDedupe(candidateUrl);
      if (checked.some((c) => normalizeForDedupe(c) === normalized)) return;
      const html = await fetchHtmlWithPlaywright(candidateUrl, { timeout, signal });
      checked.push(candidateUrl);
      if (!html) return;
      for (const e of extractEmailsFromHtml(html)) found.add(e);
      brandName = extractBrandNameFromHtml(html) ?? brandName;
    };

    try {
      await tryPw(url);
      if (found.size === 0) {
        const origin = new URL(url).origin;
        // contacts / company pages first
        const pwCandidates = [
          `${origin}/contacts/`,
          `${origin}/контакты/`,
          `${origin}/contact/`,
          `${origin}/company/`,
          `${origin}/o-kompanii/`,
          `${origin}/о-компании/`,
        ];
        for (const c of pwCandidates.slice(0, 3)) {
          if (found.size > 0) break;
          await tryPw(c);
        }
      }
    } catch {
      // ignore
    }
  }

  // If we still couldn't detect the brand, try 1-2 "about/company" pages (cheap, high yield).
  if (!brandName) {
    try {
      const origin = new URL(url).origin;
      const priorityPaths = ['/company', '/o-kompanii', '/о-компании', '/about-company', '/about', '/about-us'];
      const priority = priorityPaths.map((p) => `${origin}${p}`);
      const aboutCandidates = Array.from(new Set([...priority, ...getAboutCandidates(origin)])).slice(0, 8);
      for (const candidate of aboutCandidates) {
        if (signal?.aborted) break;
        const normalized = normalizeForDedupe(candidate);
        if (checked.some((c) => normalizeForDedupe(c) === normalized)) continue;
        const html = await fetchHtmlWithRetry(candidate, { timeout, signal, allowHttpErrors: true });
        checked.push(candidate);
        if (!html?.html) continue;
        brandName = extractBrandNameFromHtml(html.html) ?? brandName;
        if (brandName) break;
      }
    } catch {
      // ignore
    }
  }

  return { emails: Array.from(found), checked_urls: checked, brand_name: brandName };
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

  // If main page already contains enough text, avoid extra about-page crawling.
  if (mainText.length >= MIN_MAIN_TEXT_TO_SKIP_ABOUT) {
    if (mainText.length > MAX_TEXT_LENGTH) {
      return mainText.slice(0, MAX_TEXT_LENGTH).trimEnd() + '…';
    }
    return mainText;
  }

  /* ── 2. Discover about-page links from main page HTML ── */
  const discoveredLinks = mainHtml ? discoverAboutLinks(mainHtml.html, url) : [];

  /* ── 3. Build about-page candidate list: discovered links first, then static paths ── */
  const staticCandidates = [
    ...getAboutCandidates(origin),
    ...(tryWithWww ? getAboutCandidates(wwwOrigin) : []),
    ...(origin.startsWith('https://') ? getAboutCandidates(httpOrigin) : []),
  ];

  const allCandidates = buildAboutCandidates({
    mainUrl: url,
    discoveredLinks,
    staticCandidates,
    maxCandidates: MAX_ABOUT_CANDIDATES,
  });

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
