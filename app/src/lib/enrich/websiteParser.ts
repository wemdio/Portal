import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import iconv from 'iconv-lite';
import { getDomain } from 'tldts';
import { buildAboutCandidates, DEFAULT_MAX_ABOUT_CANDIDATES } from '@/lib/enrich/aboutCandidates';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import { extractEmailsFromHtml } from '@/lib/enrich/emailExtractor';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
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

import { getNonPriorityProxyDispatcher, getProxyDispatcher } from '@/lib/enrich/proxyPool';

type Dispatcher = import('undici').Dispatcher;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Пул прокси вынесен в proxyPool.ts (21.09.2026): тот же код понадобился
// почтовому скраперу для ретрая 403 через RU-адрес. Поведение не менялось.

/**
 * Язык запроса — ОПЦИЯ со старым значением по умолчанию. Русский дефолт стоит
 * потому, что все нынешние вызывающие читают .ru-сайты: ИНН-парсер, конструктор
 * баз, enrich-воркер, движок вертикалей v2, staff-инструменты, поисковый
 * парсер. Тот же приём и та же строка EN уже работают в почтовом скрапере
 * (enrich/emailScraper.ts, локаль джобы конструктора).
 */
const DEFAULT_ACCEPT_LANGUAGE = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

/**
 * Accept-Language английского сайта — для тех, кто передаёт `acceptLanguage`
 * явно. Сам парсер эту строку не выбирает никогда: дефолт выше прежний.
 *
 * Та же строка, что у почтового скрапера при locale='en'
 * (EN_ACCEPT_LANGUAGE в enrich/emailScraper.ts) и у чтения сайта клиента в
 * английском кабинете (ENG_WEBSITE_ROUTE в hypothesisEngine/stages/io.ts). У тех
 * двух пока свои копии литерала; читатель этой константы — шаг описаний
 * конструктора при locale='en' (tools/processingSteps.ts, stepEnrich), чтобы
 * одна EN-джоба читала сайт одним языком на обоих шагах.
 */
export const WEBSITE_ACCEPT_LANGUAGE_EN = 'en-US,en';

/**
 * Язык СЛУЖЕБНОГО текста, который fetchAndExtract вставляет в результат сам:
 * подписи склейки «о компании + главная» и заглушка «HTML есть, а текста нет».
 *
 * Дефолт — русский, байт-в-байт прежние строки. Его читают не только люди:
 * siteProfile движка ищет в тексте сайта оборот «требует JavaScript», чтобы
 * отличить тонкий сайт, — поэтому русские строки не меняются и английские им
 * не замена, а вариант по запросу вызывающего.
 *
 * Английский вариант нужен тому, чей результат уезжает англоязычному клиенту
 * как данные: колонка описания EN-джобы конструктора (stepEnrich) доезжает до
 * превью базы английского кабинета, и русская подпись там — русский текст у
 * ENG-клиента.
 */
export type WebsiteTextLanguage = 'ru' | 'en';

const EXTRACT_TEXT_LABELS: Record<WebsiteTextLanguage, { about: string; home: string; noText: string }> = {
  ru: {
    about: '--- О компании ---',
    home: '--- Главная ---',
    noText: 'Страница доступна, но требует JavaScript или блокирует парсер.',
  },
  en: {
    about: '--- About ---',
    home: '--- Home page ---',
    noText: 'The page responded, but it needs JavaScript or blocks the parser.',
  },
};

/**
 * Заглушка английского варианта: «страница ответила, текста нет». Экспорт — для
 * вызывающего, которому такая строка не нужна в данных (stepEnrich при
 * locale='en' оставляет ячейку описания пустой). Сравнивать с ней можно
 * напрямую: sanitizeText эту строку не меняет, а MAX_TEXT_LENGTH она не
 * достигает.
 */
export const WEBSITE_NO_TEXT_STUB_EN = EXTRACT_TEXT_LABELS.en.noText;

/**
 * Порядок маршрутов в лестнице попыток fetchHtmlWithRetry.
 *
 *  - 'priority-first' — ДЕФОЛТ и сегодняшний маршрут всех вызывающих:
 *    приоритетная (российская) группа на первой попытке, fallback на повторе.
 *    Трогать его нельзя: инцидент 28.07.2026 — 9 из 12 нод общего пула HK/EU,
 *    .ru-сайты отдавали им 403/геоблок, success rate ИНН-парсера 27%
 *    (подробности в proxyPool.ts).
 *  - 'direct-first' — для англоязычных сайтов: первая попытка напрямую с
 *    нашего сервера (американский адрес), повтор — нода ВНЕ приоритетной
 *    группы; RU-группа не участвует. Включается только из английского кабинета
 *    (hypothesisEngine/stages/io.ts, market 'us').
 */
export type WebsiteFetchRouteOrder = 'priority-first' | 'direct-first';

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

async function closePlaywrightBrowser(): Promise<void> {
  if (!playwrightBrowserPromise) return;
  try {
    const browser = await playwrightBrowserPromise;
    playwrightBrowserPromise = null;
    await browser.close();
  } catch { /* ignore */ }
}

for (const signal of ['exit', 'SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void closePlaywrightBrowser(); });
}

export async function fetchHtmlWithPlaywright(
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

export { extractNormalizedUrls, normalizeUrl } from '@/lib/enrich/urlUtils';

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
 * Опции разбора HTML → текст (extractTextFromHtml и цепочки чтения
 * fetchAndExtract / fetchSinglePage, которые передают их каждому разбору).
 */
export interface ExtractTextOptions {
  /**
   * Разбор, который не принимает вёрстку конструкторов сайтов за мусор.
   *
   * Прежний разбор чистит «шум» по ПОДСТРОКЕ класса, и на трёх массовых
   * конструкторах под чистку уходит сама страница, а текстом остаётся <title>
   * (замер 2026-10-16 на 41 сайте B2B-услуг из США: 9 сайтов с ≥ 800 символов
   * видимого текста получили 11–179 символов):
   *  - `[class*="widget"]` (задуман для виджетов сайдбара WordPress) снимает
   *    каждый элемент Elementor (`elementor-widget*`) и каждую ячейку
   *    HubSpot CMS (`widget-span widget-type-cell`, `hs_cos_wrapper_widget`);
   *  - `[class*="overlay"]` / `popup` / `modal` снимает сам <body> на
   *    Squarespace 7.1 (классы шаблона `header-overlay-alignment-center`,
   *    `tweak-portfolio-grid-overlay-*` стоят на <body> всегда);
   *  - корень текста `main, article, [role="main"]` без <main> берёт сетку
   *    карточек блога или кейсов (<article>), а вложенный `main > article`
   *    считает дважды.
   *
   * С опцией меняются ровно эти три правила (layoutNoiseCleanup и
   * layoutTextRoot ниже); остальное — снятие script/style/header/footer/nav,
   * форм, cookie-баннеров, запасной текст из <title> и описания короче
   * MIN_TEXT_LENGTH — то же самое.
   *
   * Не передана — прежний разбор байт в байт: его читают RU-движки, конструктор
   * баз, enrich-воркер, dfyb, ИНН-парсер и почтовый скрапер, и их сайты этим
   * замером не проверены. Включает опцию чтение сайта английского рынка
   * (ENG_WEBSITE_ROUTE в hypothesisEngine/stages/io.ts).
   */
  layoutAware?: boolean;
}

/** Сама страница: её не снимает ни один фильтр «шума» по подстроке класса. */
const LAYOUT_PAGE_ROOTS = 'html, body, main, [role="main"]';
const LAYOUT_MAIN_SELECTOR = 'main, [role="main"]';
/** Доля текста <body>, начиная с которой <main> (или единственный <article>) — корень текста. */
const LAYOUT_ROOT_MIN_SHARE = 0.5;

/**
 * Класс виджета сайдбара WordPress — ТОКЕН класса, а не подстрока:
 * `widget`, `widget-area`, `widget_*` (`widget_text`, `widget_block`…).
 * `elementor-widget*`, `widget-span`, `widget-type-*`, `hs_cos_wrapper_widget`
 * — вёрстка страницы, не виджет.
 */
function isSidebarWidgetClassToken(token: string): boolean {
  return token === 'widget' || token === 'widget-area' || token.startsWith('widget_');
}

/**
 * Элементы, внутри которых лежит <main>/[role=main]: предки каждого из них.
 *
 * Один проход вверх от каждого <main> с остановкой на предке, который уже в
 * наборе (выше него все уже там) — линейно по документу. Проверка «содержит
 * ли элемент <main>» поиском вниз (`$(el).find(…)`) на каждый элемент «шума»
 * квадратична: вложенные совпадения обходят одно поддерево снова и снова, а
 * cheerio-select внутри `.find()` ещё и квадратичен по числу детей. Разбор
 * синхронный, его не прерывает ни срок стадии, ни сторож простоя, ни пульс
 * воркера: страница в 86 КБ (200 вложенных `share` вокруг 20 000 `<br>`)
 * держала цикл событий HE-воркера 18 с на чтение, 223 КБ — 9,5 мин.
 *
 * Считать заново перед КАЖДЫМ фильтром: <main>, снятый прошлым фильтром, уже
 * не держит своих предков.
 */
function layoutMainHolders($: cheerio.CheerioAPI): Set<AnyNode> {
  const holders = new Set<AnyNode>();
  $(LAYOUT_MAIN_SELECTOR).each((_, el) => {
    for (let p: AnyNode | null = el.parent; p && !holders.has(p); p = p.parent) holders.add(p);
  });
  return holders;
}

/** Снять «шум», кроме самой страницы и того, что её содержит (см. layoutMainHolders). */
function removeLayoutNoise(
  $: cheerio.CheerioAPI,
  selector: string,
  isNoise: (el: AnyNode) => boolean = () => true,
): void {
  const holdsMain = layoutMainHolders($);
  $(selector)
    .not(LAYOUT_PAGE_ROOTS)
    .filter((_, el) => !holdsMain.has(el) && isNoise(el))
    .remove();
}

/** Прежний разбор (без layoutAware): «шум» по подстроке класса, корень — все main/article. */
function legacyTextSource($: cheerio.CheerioAPI) {
  // Remove social sharing / widget blocks
  $('[class*="share"], [class*="social"], [class*="widget"], [id*="sidebar"]').remove();
  // Remove popup / modal overlays
  $('[class*="popup"], [class*="modal"], [class*="overlay"], [class*="backdrop"]').remove();
  // Remove breadcrumbs
  $('[class*="breadcrumb"], [aria-label="breadcrumb"], nav, .pagination').remove();

  // Prefer main content areas if available
  const mainContent = $('main, article, [role="main"]');
  return mainContent.length === 0 ? $('body') : mainContent;
}

/** Разбор layoutAware: правила 1–2 (layoutNoiseCleanup), затем правило 3 (layoutTextRoot). */
function layoutTextSource($: cheerio.CheerioAPI) {
  layoutNoiseCleanup($);
  return layoutTextRoot($);
}

/** Правила 1–2 layoutAware: те же группы «шума», что у прежнего разбора, без самой страницы. */
function layoutNoiseCleanup($: cheerio.CheerioAPI): void {
  // Social sharing / sidebar
  removeLayoutNoise($, '[class*="share"], [class*="social"], [id*="sidebar"]');
  // Sidebar widgets — by class token, not substring
  removeLayoutNoise($, '[class]', (el) => ($(el).attr('class') ?? '').split(/\s+/).some(isSidebarWidgetClassToken));
  // Popup / modal overlays
  removeLayoutNoise($, '[class*="popup"], [class*="modal"], [class*="overlay"], [class*="backdrop"]');
  // Breadcrumbs
  removeLayoutNoise($, '[class*="breadcrumb"], [aria-label="breadcrumb"], .pagination');
}

/**
 * Элементы селектора, у которых нет предка из того же селектора: вложенный
 * текст не дважды. Линейно: «есть ли совпадение выше» запоминается на каждом
 * пройденном предке, и путь вверх идёт только до первого уже известного —
 * `$(el).parents(selector)` на каждое совпадение стоил бы совпадения × глубину
 * (сетка в 100 000 карточек на глубине 1 000).
 */
function outermostOf($: cheerio.CheerioAPI, selector: string) {
  const matched = $(selector);
  if (matched.length <= 1) return matched;
  const isMatch = new Set<AnyNode>(matched.toArray());
  /** Узел сам из селектора или лежит внутри такого. */
  const insideMatch = new Map<AnyNode, boolean>();
  const hasMatchAbove = (el: AnyNode): boolean => {
    const path: AnyNode[] = [];
    let known = false;
    for (let p: AnyNode | null = el.parent; p; p = p.parent) {
      const memo = insideMatch.get(p);
      if (memo !== undefined) {
        known = memo;
        break;
      }
      path.push(p);
    }
    for (let i = path.length - 1; i >= 0; i--) {
      known = known || isMatch.has(path[i]);
      insideMatch.set(path[i], known);
    }
    return known;
  };
  return matched.filter((_, el) => !hasMatchAbove(el));
}

/**
 * Правило 3 layoutAware — корень текста там, где страница на самом деле:
 * внешний <main>/[role=main], если в нём не меньше половины текста <body>;
 * без <main> — единственный внешний <article> с той же долей (страница-статья);
 * иначе <body> целиком. Сетка карточек — несколько <article> — корнем не
 * становится никогда.
 */
function layoutTextRoot($: cheerio.CheerioAPI) {
  const body = $('body');
  const minChars = sanitizeText(body.text()).length * LAYOUT_ROOT_MIN_SHARE;
  const mains = outermostOf($, LAYOUT_MAIN_SELECTOR);
  if (mains.length > 0) {
    return sanitizeText(mains.text()).length >= minChars ? mains : body;
  }
  const articles = outermostOf($, 'article');
  if (articles.length === 1 && sanitizeText(articles.text()).length >= minChars) return articles;
  return body;
}

/**
 * Extract readable text from an HTML string using cheerio.
 * Strips scripts, styles, nav, footer, etc.
 * `options.layoutAware` — см. ExtractTextOptions; без него — прежний разбор.
 */
export function extractTextFromHtml(html: string, options?: ExtractTextOptions): string {
  if (options?.layoutAware === true) {
    try {
      return extractTextFromLoadedHtml(html, true);
    } catch (err) {
      // Разбор с учётом вёрстки читает весь <body> рекурсивно: на разметке
      // глубже ~2 000 уровней стек кончается. Тогда — прежний разбор, который
      // берёт только main/article, а не отказ всего чтения сайта.
      if (!(err instanceof RangeError)) throw err;
    }
  }
  return extractTextFromLoadedHtml(html, false);
}

function extractTextFromLoadedHtml(html: string, layoutAware: boolean): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, noscript, iframe, svg, link, meta, header, footer, nav').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  $('form, .cookie-banner, .cookie-consent, #cookie-banner, #cookie-consent').remove();

  const textSource = layoutAware ? layoutTextSource($) : legacyTextSource($);

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

/**
 * Защита чтения от SSRF — ОПЦИЯ `guard` (fetchHtmlWithRetry, fetchAndExtract,
 * fetchSinglePage). Дефолта нет: без неё запрос идёт прежним путём —
 * redirect: 'follow', адрес проверяет разве что сам вызывающий до первого
 * запроса. Передают её движок гипотез (hypothesisEngine/stages/io.ts) и
 * EN-джобы конструктора баз (tools/processingSteps.ts: сюда — шаг описаний,
 * почтовый обход — через scrapeEmails, который берёт fetchFollowingGuarded и
 * readBodyCapped отсюда); реализация — createPublicWebsiteGuard и
 * createUsWebsiteFetchGuard в enrich/publicAddress.ts.
 *
 * С guard редиректы ведутся вручную: перед КАЖДЫМ запросом — первым и каждым
 * шагом редиректа — адрес проверяет checkUrl; шагов не больше maxRedirects;
 * схема редиректа только http/https, а https → http — только при
 * allowHttpDowngrade. Проверки и все шаги идут под тем же сроком попытки
 * (`timeout`), что и раньше покрывал запрос вместе с редиректами и телом.
 * Отказ — исход 'refused': страница не читается, и попытку не повторяем —
 * другой маршрут адрес не изменит.
 */
export interface WebsiteFetchGuard {
  /** Бросает WebsiteAddressRefusedError — адрес запрещён, запрос не уходит. */
  checkUrl: (url: URL) => Promise<void>;
  maxRedirects: number;
  allowHttpDowngrade: boolean;
  /** ENG evidence opt-in: keep an advertised HTTP redirect on HTTPS; never send HTTP. */
  preferHttpsRedirects?: boolean;
  /** Прямой маршрут (прокси не выбран) идёт через этот диспетчер. */
  directDispatcher?: Dispatcher;
}

/** Адрес запроса или шага редиректа отклонён защитой чтения (WebsiteFetchGuard). */
export class WebsiteAddressRefusedError extends Error {
  /** Дискриминант: instanceof ложен, если в процессе окажется две копии модуля. */
  readonly websiteAddressRefused = true as const;

  constructor(reason: string) {
    super(`адрес отклонён: ${reason}`);
    this.name = 'WebsiteAddressRefusedError';
  }
}

function isWebsiteAddressRefused(e: unknown): e is WebsiteAddressRefusedError {
  if (e instanceof WebsiteAddressRefusedError) return true;
  return (
    typeof e === 'object' && e !== null && (e as { websiteAddressRefused?: unknown }).websiteAddressRefused === true
  );
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Исход одной попытки чтения. Старые обёртки (fetchHtml, fetchHtmlWithRetry)
 * сводят всё, кроме 'html', к null — ровно как раньше; различать исходы нужно
 * строгому чтению одной страницы (fetchSinglePage):
 *  - 'unusable' — сервер ответил, но это не страница: статус отфильтрован или
 *    тип ответа не HTML;
 *  - 'refused' — адрес отклонён защитой чтения (guard);
 *  - 'failed' — ответа не было: сеть, срок попытки, TLS;
 *  - 'aborted' — внешняя отмена.
 */
type HtmlFetchOutcome =
  | { kind: 'html'; html: string; status: number; url: string }
  | { kind: 'unusable'; status: number }
  | { kind: 'refused' }
  | { kind: 'failed' }
  | { kind: 'aborted' };

type FetchHtmlOptions = {
  timeout?: number;
  signal?: AbortSignal;
  allowHttpErrors?: boolean;
  preferPriority?: boolean;
  /** Заголовок Accept-Language; не передан — русский DEFAULT_ACCEPT_LANGUAGE. */
  acceptLanguage?: string;
  /** undefined keeps the legacy proxy selection; null explicitly fetches directly. */
  dispatcher?: Dispatcher | null;
  /** Защита чтения; не передана — redirect: 'follow', как до неё. */
  guard?: WebsiteFetchGuard;
  /** Потолок тела в байтах; не передан — тело читается целиком, как до него. */
  maxBytes?: number;
};

/** Промис проверки под сигналом попытки: DNS-резолв сам не прерывается. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Адрес шага редиректа — ровно так, как его строит follow-режим fetch (undici,
 * responseLocationURL). Значение заголовка приходит строкой байтов (latin1), и
 * если в нём есть символ вне печатного ASCII (код < 0x20 или > 0x7E — например,
 * сырой UTF-8 «Location: /главная/» самописных PHP и CMS), undici сначала
 * перечитывает эти байты как UTF-8 (normalizeBinaryStringToUtf8) и только потом
 * разбирает адрес относительно адреса, ответившего редиректом. Без этого шага
 * new URL кодировал каждый байт по отдельности (/%C3%90%C2%B3…), и ручной
 * редирект вёл на несуществующую страницу там, где follow-режим открывал
 * нужную, — у обоих рынков. Байты, которые не складываются в UTF-8, undici
 * заменяет на U+FFFD и не откатывается к сырому значению; здесь так же.
 */
function guardedRedirectTarget(location: string, current: URL): URL {
  let value = location;
  for (let i = 0; i < location.length; i += 1) {
    const code = location.charCodeAt(i);
    if (code > 0x7e || code < 0x20) {
      value = Buffer.from(location, 'latin1').toString('utf8');
      break;
    }
  }
  return new URL(value, current);
}

/** Адрес ответа без фрагмента — как Response.url в follow-режиме (фрагмент на сервер не уходит). */
function guardedResponseUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

/**
 * Ручные редиректы под защитой чтения; возвращает ответ и адрес последнего шага.
 * fetchOpts — с redirect: 'manual'; тот же объект (маршрут, signal) идёт в
 * каждый шаг. Экспорт — для почтового обхода (enrich/emailScraper.ts).
 */
export async function fetchFollowingGuarded(
  url: string,
  fetchOpts: RequestInit,
  guard: WebsiteFetchGuard,
  signal: AbortSignal,
): Promise<{ res: Response; url: string }> {
  let current = new URL(url);
  for (let hops = 0; ; hops += 1) {
    await untilAborted(guard.checkUrl(current), signal);
    const res = await fetch(current.href, fetchOpts);
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
    if (!location) return { res, url: guardedResponseUrl(current) };
    await res.body?.cancel();
    if (hops >= guard.maxRedirects) {
      throw new WebsiteAddressRefusedError(`больше ${guard.maxRedirects} редиректов`);
    }
    let next: URL;
    try {
      next = guardedRedirectTarget(location, current);
    } catch {
      throw new WebsiteAddressRefusedError('редирект на невалидный адрес');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new WebsiteAddressRefusedError(`редирект на схему ${next.protocol}`);
    }
    if (!guard.allowHttpDowngrade && current.protocol === 'https:' && next.protocol === 'http:') {
      if (!guard.preferHttpsRedirects) {
        throw new WebsiteAddressRefusedError(`редирект https → http (${next.host})`);
      }
      // Same advertised destination, HTTPS only. The next iteration applies
      // the unchanged address/DNS/port guard before any connection is made.
      next.protocol = 'https:';
    }
    current = next;
  }
}

/**
 * Тело не больше maxBytes: читаем потоком и обрываем на потолке. Для текста
 * страницы (≤ MAX_TEXT_LENGTH символов) первых мегабайт хватает с запасом, а
 * быстрый хост больше не может залить в воркер сотни мегабайт — до этой опции
 * тело ограничивал только срок попытки. Экспорт — для почтового обхода
 * (enrich/emailScraper.ts).
 */
export async function readBodyCapped(res: Response, maxBytes: number, url: string): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      await reader.cancel().catch(() => {});
      console.warn(`[fetchHtml] ${url} — тело больше ${maxBytes} байт, разбираем первые ${maxBytes}`);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

async function fetchHtmlOutcome(url: string, options?: FetchHtmlOptions): Promise<HtmlFetchOutcome> {
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const externalSignal = options?.signal;
  // AbortSignal does not replay an abort event to listeners attached after it
  // fired. A watchdog can hand a fallback request an already-aborted signal,
  // so stop here instead of starting another fetch that cannot be cancelled.
  if (externalSignal?.aborted) {
    clearTimeout(timer);
    return { kind: 'aborted' };
  }
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const guard = options?.guard;

  try {
    // По умолчанию — приоритетная группа (RU). Retry-обёртка передаёт
    // preferPriority=false на второй попытке, чтобы уйти в fallback.
    const dispatcher = options?.dispatcher !== undefined
      ? options.dispatcher
      : await getProxyDispatcher(options?.preferPriority !== false);
    if (controller.signal.aborted) return externalSignal?.aborted ? { kind: 'aborted' } : { kind: 'failed' };
    const fetchOpts: RequestInit & { dispatcher?: Dispatcher } = {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': options?.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
      },
      signal: controller.signal,
      redirect: guard ? 'manual' : 'follow',
    };
    // С защитой чтения прямой маршрут идёт через её диспетчер: он проверяет
    // адрес ещё раз в момент соединения.
    const route = dispatcher ?? guard?.directDispatcher;
    if (route) (fetchOpts as Record<string, unknown>).dispatcher = route;

    let res: Response;
    let finalUrl: string;
    if (guard) {
      ({ res, url: finalUrl } = await fetchFollowingGuarded(url, fetchOpts, guard, controller.signal));
    } else {
      res = await fetch(url, fetchOpts);
      finalUrl = res.url || url;
    }

    const contentType = res.headers.get('content-type');
    if ((!options?.allowHttpErrors && res.status >= 400) || res.status >= 500 || !isHtmlLikeContentType(contentType)) {
      await res.body?.cancel();
      return { kind: 'unusable', status: res.status };
    }

    const body = options?.maxBytes ? await readBodyCapped(res, options.maxBytes, url) : await res.arrayBuffer();
    const html = decodeHtml(body, contentType);
    return { kind: 'html', html, status: res.status, url: finalUrl };
  } catch (err) {
    // An adaptive retry cancels its losing route; this is not a website error.
    if (externalSignal?.aborted) return { kind: 'aborted' };
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const refusal = isWebsiteAddressRefused(err) ? err : isWebsiteAddressRefused(e.cause) ? e.cause : null;
    if (refusal) {
      console.warn(`[fetchHtml] ${url} — ${refusal.message}`);
      return { kind: 'refused' };
    }
    const causeCode = e.cause?.code ?? '';
    const causeMsg = e.cause?.message ?? '';
    const reason = causeCode || causeMsg || e.message || 'unknown';
    console.warn(`[fetchHtml] ${url} — ${reason}`);
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function fetchHtml(url: string, options?: FetchHtmlOptions): Promise<{ html: string; status: number } | null> {
  const outcome = await fetchHtmlOutcome(url, options);
  return outcome.kind === 'html' ? { html: outcome.html, status: outcome.status } : null;
}

type FetchHtmlWithRetryOptions = {
  timeout?: number;
  signal?: AbortSignal;
  allowHttpErrors?: boolean;
  retries?: number;
  /**
   * undefined сохраняет стандартный маршрут priority → fallback.
   * false принудительно использует fallback на всех попытках; true — priority.
   */
  preferPriority?: boolean;
  /** Заголовок Accept-Language; не передан — русский DEFAULT_ACCEPT_LANGUAGE. */
  acceptLanguage?: string;
  /** Порядок маршрутов; не передан — 'priority-first', сегодняшняя лестница. */
  routeOrder?: WebsiteFetchRouteOrder;
  /** Защита чтения (WebsiteFetchGuard); не передана — redirect: 'follow'. */
  guard?: WebsiteFetchGuard;
  /** Потолок тела в байтах; не передан — тело читается целиком. */
  maxBytes?: number;
};

export async function fetchHtmlWithRetry(
  url: string,
  options?: FetchHtmlWithRetryOptions,
): Promise<{ html: string; status: number } | null> {
  // Повтор — на любом исходе, кроме HTML, как и раньше. Исключение одно:
  // адрес, отклонённый защитой чтения, — он бывает только с опцией guard.
  const outcome = await fetchHtmlOutcomeWithRetry(url, options, (o) => o.kind !== 'refused');
  return outcome.kind === 'html' ? { html: outcome.html, status: outcome.status } : null;
}

async function fetchHtmlOutcomeWithRetry(
  url: string,
  options: FetchHtmlWithRetryOptions | undefined,
  retryable: (outcome: HtmlFetchOutcome) => boolean,
): Promise<HtmlFetchOutcome> {
  const retries = Math.max(0, Math.floor(options?.retries ?? FETCH_RETRIES));
  // Явный preferPriority вызывающего сильнее порядка: он и был, и остаётся
  // способом прибить все попытки к одной группе.
  const directFirst = options?.routeOrder === 'direct-first' && options?.preferPriority === undefined;
  let outcome: HtmlFetchOutcome = { kind: 'failed' };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Первая попытка — приоритетный пул (RU). Retry — уходим в fallback:
    // если RU-прокси упал/дал 403 на .ru-сайте, второй раз через тот же
    // RU-прокси обычно ничего не даст; шанс через HK/EU выше нуля.
    //
    // 'direct-first' (англоязычный сайт): первая попытка напрямую — сервер
    // стоит в Нью-Йорке; повтор — нода вне приоритетной группы
    // (pickNonPriorityProxyUrl), без живой такой ноды — снова напрямую. С
    // защитой чтения прямой маршрут идёт через её диспетчер (fetchHtmlOutcome).
    // RU-группы здесь нет: замер 23.10.2026 на боевом воркере — из 40
    // читаемых англоязычных сайтов RU-прокси открыли 9, а 15 из 79 «недоступных»
    // крупных сайтов (CareFirst, Wellmark, LexisNexis…) отвечали напрямую и
    // отказывали обеим группам прокси (403, обрыв соединения, таймаут).
    const preferPriority = options?.preferPriority ?? attempt === 0;
    const dispatcher = directFirst
      ? (attempt === 0 ? null : (await getNonPriorityProxyDispatcher()) ?? null)
      : undefined;
    outcome = await fetchHtmlOutcome(url, {
      ...options,
      preferPriority,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    if (outcome.kind === 'html') return outcome;
    if (options?.signal?.aborted) return { kind: 'aborted' };
    if (!retryable(outcome)) return outcome;
    if (attempt < retries) {
      await sleep(FETCH_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return outcome;
}

/**
 * Search-only opt-in. Keep the RU-first attempt, then race direct access with
 * a different proxy group within ONE retry window. A fast error must not beat
 * a slower successful response. Cancel the loser and reuse the winning route
 * for this origin during this crawl only (never across users/jobs/sites).
 */
function createAdaptiveHtmlFetcher(options: { timeout: number; signal?: AbortSignal }) {
  const routesByOrigin = new Map<string, { priority: Dispatcher | null; preferred: Dispatcher | null }>();
  const usable = (result: Awaited<ReturnType<typeof fetchHtml>>) =>
    Boolean(result?.html.trim() && result.status < 400);

  return async (url: string): Promise<Awaited<ReturnType<typeof fetchHtml>>> => {
    if (options.signal?.aborted) return null;
    const origin = new URL(url).origin;
    let state = routesByOrigin.get(origin);
    if (!state) {
      const priority = (await getProxyDispatcher()) ?? null;
      state = { priority, preferred: priority };
      routesByOrigin.set(origin, state);
    }
    const preferred = state.preferred;
    const first = await fetchHtml(url, { ...options, allowHttpErrors: true, dispatcher: preferred });
    if (options.signal?.aborted) return null;
    if (usable(first)) {
      return first;
    }
    // A missing page is not a broken route. Do not repeat guessed /about etc.
    if (first && [404, 410].includes(first.status)) return first;

    const otherProxy = (await getNonPriorityProxyDispatcher()) ?? (await getProxyDispatcher(false));
    const routes = [...new Set<Dispatcher | null>([
      null, state.priority, ...(otherProxy ? [otherProxy] : []),
    ])].filter((route) => route !== preferred).slice(0, 2);
    // With no alternative configured, retain a second attempt on the same route.
    if (routes.length === 0) routes.push(preferred);
    if (options.signal?.aborted) return null;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const results: Array<Awaited<ReturnType<typeof fetchHtml>>> = [];
    try {
      const winner = await Promise.any(routes.map(async (dispatcher, index) => {
        const result = await fetchHtml(url, {
          ...options, signal: controller.signal, allowHttpErrors: true, dispatcher,
        });
        results[index] = result;
        if (!usable(result)) throw new Error('No usable HTML on this route');
        return { result, dispatcher };
      }));
      if (options.signal?.aborted) return null;
      state.preferred = winner.dispatcher;
      return winner.result;
    } catch {
      // Keep any readable error-page HTML, as the legacy allowHttpErrors path did.
      return options.signal?.aborted ? null : first ?? results.find((result) => result) ?? null;
    } finally {
      controller.abort();
      options.signal?.removeEventListener('abort', onAbort);
    }
  };
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
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    maxPages?: number;
    /** Search parser only; other consumers retain the existing proxy/retry policy. */
    adaptiveRoutes?: boolean;
  },
): Promise<{ emails: string[]; checked_urls: string[]; brand_name: string | null }> {
  const url = normalizeUrl(rawUrl);
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  const maxPages = Math.max(1, Math.min(12, options?.maxPages ?? 6));
  const fetchPage = options?.adaptiveRoutes
    ? createAdaptiveHtmlFetcher({ timeout, signal })
    : (pageUrl: string) => fetchHtmlWithRetry(pageUrl, { timeout, signal, allowHttpErrors: true });

  const checked: string[] = [];
  const found = new Set<string>();
  let brandName: string | null = null;

  // 1) Fetch main page HTML to discover contact links + mailto in header/footer.
  const main = await fetchPage(url);
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
      const html = await fetchPage(candidate);
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
      const html = await fetchPage(candidate);
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
        const html = await fetchPage(candidate);
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
/** Same sufficiency rule as fetchAndExtract; short pages still need its fallbacks. */
export function reusableMainPageDescription(html: string): string {
  const text = extractTextFromHtml(html);
  return text.length >= MIN_MAIN_TEXT_TO_SKIP_ABOUT ? text.slice(0, MAX_TEXT_LENGTH) : '';
}

/**
 * Ни один адрес origin'а не отдал HTML: ни главная (со своим ретраем), ни www,
 * ни http-вариант, ни кандидаты «о компании».
 *
 * Строгое чтение одной страницы (fetchSinglePage) бросает его же, когда сам
 * адрес не ответил ни на одной попытке (сеть, срок попытки): запасных адресов
 * у строгого чтения нет, и для вызывающего это тот же факт «хост молчит».
 *
 * Класс, а не текст, потому что вызывающему нужно отличать два РАЗНЫХ факта:
 * «хост молчит вообще» (перебирать остальные пути того же origin'а бессмысленно
 * — каждый пойдёт тем же полным кругом) и «страница отдалась, но пустая или на
 * JS» (это свойство одной страницы, соседние могут ответить).
 *
 * Адрес класс НЕ несёт: единственный консьюмер (`hypothesisEngine/stages/io`)
 * подставляет в текст свой нормализованный url, а поле, которое никто не
 * читает, следующий читатель принял бы за живое.
 *
 * Правка аддитивная: сообщение байт в байт то же, что бросал прежний
 * `new Error`, поэтому консьюмеры (`api/enrich/*`, `lib/tools/dfyb*`,
 * `processingSteps`, `websiteEnrichmentWorker`, io-слои движков) печатают и
 * пишут в БД ровно тот же текст, что и до неё.
 */
export class WebsiteNoHtmlError extends Error {
  /** Дискриминант: instanceof ложен, если в процессе окажется две копии модуля. */
  readonly websiteNoHtml = true as const;

  constructor() {
    super('Не удалось получить HTML с сайта');
    this.name = 'WebsiteNoHtmlError';
  }
}

/** Типизированная проверка «origin не отдал HTML», без разбора текста ошибки. */
export function isWebsiteNoHtmlError(e: unknown): e is WebsiteNoHtmlError {
  if (e instanceof WebsiteNoHtmlError) return true;
  return (
    typeof e === 'object' && e !== null && (e as { websiteNoHtml?: unknown }).websiteNoHtml === true
  );
}

export async function fetchAndExtract(
  rawUrl: string,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    /** Заголовок Accept-Language; не передан — русский DEFAULT_ACCEPT_LANGUAGE. */
    acceptLanguage?: string;
    /** Порядок маршрутов; не передан — 'priority-first', сегодняшняя лестница. */
    routeOrder?: WebsiteFetchRouteOrder;
    /**
     * Язык служебного текста результата (подписи склейки, заглушка «текста
     * нет»); не передан — русский, прежние строки. См. WebsiteTextLanguage.
     */
    textLanguage?: WebsiteTextLanguage;
    /** Защита чтения (WebsiteFetchGuard) для каждого запроса цепочки; не передана — как до неё. */
    guard?: WebsiteFetchGuard;
    /** Потолок тела каждого ответа цепочки в байтах; не передан — тело целиком. */
    maxBytes?: number;
    /**
     * Разбор HTML → текст с учётом вёрстки конструкторов (ExtractTextOptions)
     * для КАЖДОЙ страницы цепочки; не передан — прежний разбор.
     */
    layoutAware?: boolean;
    /** Opt-in ENG reuse: observed final URL and extracted text, before display truncation. */
    onExtractedPage?: (page: { url: string; text: string }) => void;
  },
): Promise<string> {
  const url = normalizeUrl(rawUrl);
  const labels = EXTRACT_TEXT_LABELS[options?.textLanguage === 'en' ? 'en' : 'ru'];
  const timeout = options?.timeout ?? FETCH_TIMEOUT_MS;
  const signal = options?.signal;
  // Язык, порядок групп, защиту чтения и потолок тела получает КАЖДЫЙ запрос
  // цепочки: главная, www, http-вариант и страницы «о компании» — это один и
  // тот же сайт, и читать его половиной адресов иначе смысла нет.
  const route = {
    acceptLanguage: options?.acceptLanguage,
    routeOrder: options?.routeOrder,
    guard: options?.guard,
    maxBytes: options?.maxBytes,
  };
  // Разбор — тот же для главной, www, http-варианта и «о компании»: страница
  // одного сайта, прочитанная одним правилом.
  const extractOptions: ExtractTextOptions = { layoutAware: options?.layoutAware };
  const read = async (target: string, readOptions: FetchHtmlWithRetryOptions) => {
    if (!options?.onExtractedPage) return fetchHtmlWithRetry(target, readOptions);
    const outcome = await fetchHtmlOutcomeWithRetry(target, readOptions, (value) => value.kind !== 'refused');
    if (outcome.kind !== 'html') return null;
    if (outcome.status >= 200 && outcome.status < 400) {
      options.onExtractedPage({ url: outcome.url, text: extractTextFromHtml(outcome.html, extractOptions) });
    }
    return { html: outcome.html, status: outcome.status };
  };
  const tryWithWww = !/^https?:\/\/www\./i.test(url);
  const origin = new URL(url).origin;
  const wwwOrigin = tryWithWww ? origin.replace(/^https?:\/\//i, (m) => `${m}www.`) : origin;
  const httpOrigin = origin.replace(/^https:\/\//i, 'http://');

  /* ── 1. Fetch the main page (needed both for text and for link discovery) ── */
  let mainHtml: { html: string; status: number } | null = null;
  let mainText = '';
  let hadAnyHtml = false;

  mainHtml = await read(url, { timeout, signal, allowHttpErrors: true, ...route });
  if (mainHtml) {
    mainText = extractTextFromHtml(mainHtml.html, extractOptions);
    hadAnyHtml = true;
  }
  if (!mainText && tryWithWww) {
    const wwwHtml = await read(`${wwwOrigin}`, {
      timeout,
      signal,
      allowHttpErrors: true,
      ...route,
    });
    if (wwwHtml) {
      mainHtml = wwwHtml;
      mainText = extractTextFromHtml(wwwHtml.html, extractOptions);
      hadAnyHtml = true;
    }
  }
  if (!mainText && origin.startsWith('https://')) {
    const httpHtml = await read(`${httpOrigin}`, {
      timeout,
      signal,
      allowHttpErrors: true,
      ...route,
    });
    if (httpHtml) {
      mainHtml = httpHtml;
      mainText = extractTextFromHtml(httpHtml.html, extractOptions);
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
    const html = await read(candidate, { timeout, signal, ...route });
    if (html) {
      const text = extractTextFromHtml(html.html, extractOptions);
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
    combined = `${labels.about}\n${aboutText}\n\n${labels.home}\n${mainText}`;
  } else if (aboutText.length > 0) {
    combined = aboutText;
  } else if (mainText.length > 0) {
    combined = mainText;
  } else if (hadAnyHtml) {
    combined = labels.noText;
  } else {
    throw new WebsiteNoHtmlError();
  }

  // Final sanitization pass on the combined text
  combined = sanitizeText(combined);

  // Truncate to max length
  if (combined.length > MAX_TEXT_LENGTH) {
    return combined.slice(0, MAX_TEXT_LENGTH).trimEnd() + '…';
  }

  return combined;
}

/** Строго прочитанная страница: текст ровно того адреса, где закончились редиректы. */
export interface WebsitePage {
  /** Адрес последнего шага редиректа — с него и пришёл текст. */
  url: string;
  /**
   * Текст страницы (≤ MAX_TEXT_LENGTH символов + «…»). Пустая строка — HTML
   * есть, текста нет: заглушку «требует JavaScript» строгое чтение не
   * подставляет, порог полезности решает вызывающий.
   */
  text: string;
  /** Реальные ссылки страницы; только при явном companyEvidence. */
  companyEvidenceLinks?: Array<{
    url: string;
    kind: 'legal' | 'about' | 'contact' | 'locations' | 'services';
    /** Higher values point to more specific company/address evidence. */
    priority?: number;
    label?: string;
  }>;
  /** ENG evidence only: some complete source blocks did not fit the text budget. */
  companyEvidenceTextTruncated?: boolean;
}

type CompanyEvidenceLink = NonNullable<WebsitePage['companyEvidenceLinks']>[number];
const COMPANY_EVIDENCE_SECTION_SEPARATOR = '\n\n[source section]\n\n';

/** Ссылки для проверки компании: не угадываем адреса и не доверяем префиксу origin. */
function companyEvidenceLinks($: cheerio.CheerioAPI, pageUrl: string, evidenceTerms: readonly string[] = []): CompanyEvidenceLink[] {
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./, '');
  const domain = getDomain(base.hostname, { allowPrivateDomains: true });
  // Selected ENG service terms opt into targeted evidence discovery. Some
  // sites route their services through index.php?page=...; legacy callers
  // retain the original query-free link policy.
  const keepPageQueries = evidenceTerms.length > 0;
  const links: CompanyEvidenceLink[] = [];
  const seen = new Map<string, CompanyEvidenceLink>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href || href.startsWith('#')) return;
    let url: URL;
    try { url = new URL(href, base); } catch { return; }
    const sameCompanyDomain = url.hostname.replace(/^www\./, '') === host
      || !!domain && getDomain(url.hostname, { allowPrivateDomains: true }) === domain;
    if (!['http:', 'https:'].includes(url.protocol)
      || !sameCompanyDomain
      || url.port !== base.port || url.username || url.password || (!keepPageQueries && url.search) || url.hash
      || (base.protocol === 'https:' && url.protocol !== 'https:')) return;
    const path = url.pathname;
    if (/\/(?:auth|account|login|logout|sign[-_]?in|sign[-_]?up|careers?|jobs?|karriere|facebook|twitter|linkedin|instagram|youtube)(?:\/|$)/i.test(path)
      || /\.[a-z0-9]{2,5}$/i.test(path) && !/\.(?:html?|php|aspx?)$/i.test(path)) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 160);
    const purpose = `${path.replace(/[-_]+/g, ' ')} ${label}`;
    const leaf = (path.split('/').filter(Boolean).at(-1) ?? '').replace(/\.(?:html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ');
    const precisePurpose = `${leaf} ${label}`;
    const isServicePath = /\/(?:[^/]*[-_])?(?:services?|solutions?|capabilities|products?|produkte|leistungen|expertise|what[-_]we[-_]do)(?:[-_/]|$)/i.test(path);
    const isBusinessHub = /\/(?:businesses[-_]institutions|our[-_]business(?:es)?|business[-_]areas)(?:\/|$)/i.test(path)
      || /^(?:www\.)?(?:business|commercial|corporate|institutional)\./i.test(url.hostname)
        && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(path);
    let kind: CompanyEvidenceLink['kind'] | null = null;
    let priority = 0;
    if (/\b(?:registered (?:addresses?|offices?|seats?)|headquarters|head office|legal address|sitz der gesellschaft|siege social)\b/i.test(purpose)) {
      kind = 'legal'; priority = 100;
    } else if (/\b(?:impressum|imprint|legal notice|legal entit(?:y|ies)|mentions legales|aviso legal|company (?:registration|structure)|corporate structure|group structure)\b/i.test(precisePurpose)
      || /^(?:company information|company registration|company structure)$/i.test(leaf)
      || !isServicePath && /\bcorporate governance\b/i.test(precisePurpose)) {
      kind = 'legal'; priority = 95;
    } else if (/\b(?:legal|regulatory information|regulatory disclosures)\b/i.test(purpose) && !/\b(?:privacy|cookies?|terms)\b/i.test(purpose)) {
      kind = 'legal'; priority = 90;
    } else if (/\/(?:contact(?:[-_]?us)?|contacts|kontakt)(?:\/|$)/i.test(path)
      || /\b(?:contact(?: us)?|contact and enquiries|get in touch|kontakt)\b/i.test(label)) {
      kind = 'contact'; priority = 85;
    } else if (/\/(?:[a-z-]*-)?(?:locations?|offices?)(?:[-_/]|$)/i.test(path)
      || /\b(?:locations?|our offices|global offices|office locations)\b/i.test(label)) {
      kind = 'locations'; priority = 80;
    } else if (isServicePath || isBusinessHub
      || /\b(?:our services|our solutions|our capabilities|our products|our expertise|what we do|produkte|leistungen)\b/i.test(label)) {
      kind = 'services'; priority = 60;
    } else if (ABOUT_HREF_PATTERN.test(path) || ABOUT_TEXT_PATTERN.test(label)
      || /\/(?:ueber-uns|uber-uns|unternehmen|company-information)(?:\/|$)/i.test(path)
      || /(?:^|\s)(?:über uns|ueber uns|unternehmen)(?:$|\s)/i.test(label)) {
      kind = 'about'; priority = 70;
    }
    if (!kind) return;
    if (evidenceTerms.length) {
      // ENG only: rank real service links before the bounded menu is cut.
      // Otherwise a long industry/news menu hides later, specific offerings.
      const words = precisePurpose.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}]{4,}/gu) ?? [];
      const generic = new Set(['fund', 'service', 'services', 'business', 'company', 'companies', 'provider', 'providers', 'financial', 'solution', 'solutions']);
      const hits = evidenceTerms.filter((term) => !generic.has(term) && words.some((word) => word.startsWith(term))).length;
      const peripheral = /\/(?:news|articles?|blog|insights?|press|media|business[-_]expertise|careers?|jobs?|security|fraud)(?:\/|$)/i.test(path)
        || /\b(?:newsletters?|privacy|cookies?|careers?|vacancies|fraud|scams?|market insights|trending topics)\b/i.test(precisePurpose);
      const serviceLeaf = kind === 'services' && /\/(?:services?|solutions?|capabilities|products?|leistungen|produkte)\//i.test(path);
      const directService = serviceLeaf && /\/(?:services?|solutions?|capabilities|products?|leistungen|produkte)\/[^/]+\/?$/i.test(path);
      const businessOverview = kind === 'services' && /\/(?:businesses[-_]institutions|our[-_]business(?:es)?|business[-_]areas)(?:\/(?:index\.(?:html?|php|aspx?))?)?\/?$/i.test(path);
      const organizationService = serviceLeaf && /\b(?:institutional|enterprise|corporate|commercial)\b/i.test(precisePurpose);
      priority += Math.min(hits, 2) * 70 + Number(serviceLeaf) * 30 + Number(directService) * 20
        + Number(businessOverview) * 70 + Number(organizationService) * 35
        - Number(peripheral && !(serviceLeaf && hits > 0)) * 100;
    }
    const key = `${url.hostname.replace(/^www\./, '')}${url.port ? `:${url.port}` : ''}${path.replace(/\/$/, '')}${keepPageQueries ? url.search : ''}`;
    const previous = seen.get(key);
    if (previous && (previous.priority ?? 0) >= priority) return;
    const link = { url: url.href, kind, priority, ...(label ? { label } : {}) };
    if (previous) links.splice(links.indexOf(previous), 1);
    seen.set(key, link);
    links.push(link);
  });
  // Rank before limiting: an early menu must not push a later registered-address link out.
  const ranked = links.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const balanced = new Set<CompanyEvidenceLink>();
  for (const kind of ['legal', 'contact', 'locations', 'about', 'services'] as const) {
    for (const link of ranked.filter((item) => item.kind === kind).slice(0, kind === 'services' ? 16 : 4)) balanced.add(link);
  }
  for (const link of ranked) {
    if (balanced.size >= 36) break;
    balanced.add(link);
  }
  return [...balanced].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/** JSON-LD — только данные организации/адреса, без WebPage, Product, reviews и произвольных scripts. */
function companyStructuredText($: cheerio.CheerioAPI): string[] {
  const excerpts: string[] = [];
  const seen = new Set<string>();
  const scalar = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';
  const typeIs = (value: unknown, type: string) => (Array.isArray(value) ? value : [value])
    .some((item) => typeof item === 'string' && (item === type || item === `https://schema.org/${type}` || item === `http://schema.org/${type}`));
  // Explicit schema.org Organization/LocalBusiness families. A Product/Review
  // containing a customer's address is still not a company location source.
  const organizationTypes = [
    'Organization', 'Corporation', 'LocalBusiness', 'FinancialService', 'AccountingService',
    'BankOrCreditUnion', 'InsuranceAgency', 'ProfessionalService', 'LegalService', 'Attorney',
    'EmploymentAgency', 'GovernmentOrganization', 'NGO', 'EducationalOrganization',
    'MedicalOrganization', 'MedicalBusiness', 'OnlineBusiness', 'OnlineStore', 'Store',
    'RealEstateAgent', 'TravelAgency', 'LodgingBusiness', 'Hotel', 'AutomotiveBusiness',
    'HomeAndConstructionBusiness', 'EntertainmentBusiness', 'FoodEstablishment',
    'SportsActivityLocation', 'HealthAndBeautyBusiness', 'ShoppingCenter',
    'Dentist', 'MedicalClinic', 'Physician', 'Hospital', 'Pharmacy', 'VeterinaryCare',
    'Electrician', 'Plumber', 'GeneralContractor', 'HVACBusiness', 'RoofingContractor',
    'Locksmith', 'MovingCompany', 'HousePainter', 'AutoDealer', 'AutoRepair', 'AutoRental',
    'AutoBodyShop', 'AutoPartsStore', 'MotorcycleDealer', 'MotorcycleRepair', 'Restaurant',
    'CafeOrCoffeeShop', 'Bakery', 'BarOrPub', 'Brewery', 'Winery', 'Distillery',
    'GroceryStore', 'WholesaleStore', 'DepartmentStore', 'HardwareStore', 'OfficeEquipmentStore',
    'ElectronicsStore', 'FurnitureStore', 'ClothingStore', 'ComputerStore',
  ];
  const address = (value: unknown): unknown => {
    if (scalar(value)) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    if (input['@type'] && !typeIs(input['@type'], 'PostalAddress')) return undefined;
    const out: Record<string, unknown> = {};
    for (const key of ['@type', 'name', 'streetAddress', 'postOfficeBoxNumber', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']) {
      if (scalar(input[key])) out[key] = input[key];
    }
    const country = input.addressCountry;
    if (country && typeof country === 'object' && !Array.isArray(country)) {
      const countryName = (country as Record<string, unknown>).name;
      if (scalar(countryName)) out.addressCountry = { name: countryName };
    }
    return Object.keys(out).length ? out : undefined;
  };
  $('script[type="application/ld+json"]').slice(0, 16).each((_, el) => {
    const source = $(el).text();
    if (source.length > 256_000) return;
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { return; }
    const pending: unknown[] = [parsed];
    for (let index = 0; index < pending.length && index < 512; index++) {
      const value = pending[index];
      if (Array.isArray(value)) { pending.push(...value.slice(0, 512)); continue; }
      if (!value || typeof value !== 'object') continue;
      const input = value as Record<string, unknown>;
      // Only top-level/graph entities; a customer's address inside a review is not the site's office.
      if (Array.isArray(input['@graph'])) pending.push(...input['@graph'].slice(0, 512));
      let out: Record<string, unknown> | undefined;
      if (organizationTypes.some((type) => typeIs(input['@type'], type))) {
        out = {};
        for (const key of ['@type', 'name', 'legalName', 'alternateName', 'url']) {
          if (scalar(input[key])) out[key] = input[key];
        }
        const addresses = Array.isArray(input.address) ? input.address.slice(0, 12).map(address).filter(Boolean) : address(input.address);
        if (addresses && (!Array.isArray(addresses) || addresses.length)) out.address = addresses;
      } else if (typeIs(input['@type'], 'PostalAddress')) {
        out = address(input) as Record<string, unknown> | undefined;
      }
      if (!out || !Object.keys(out).length) continue;
      // Property names and values are copied from the source; do not label an address as HQ or an office.
      const text = JSON.stringify(out);
      if (!seen.has(text)) { seen.add(text); excerpts.push(text); }
    }
  });
  return excerpts;
}

const COMPANY_ADDRESS_ROLE = /\b(?:registered\s+(?:address(?:es)?|office|seat)|headquarters|head\s+office|legal\s+address|hauptsitz|geschaftssitz|geschäftssitz|sitz\s+der\s+gesellschaft|hoofdkantoor|statutaire\s+zetel|huvudkontor|hovedkontor|forretningsadresse|kotipaikka|si[eè]ge\s+social)\b/i;
const COMPANY_ADDRESS_BLOCK_LIMIT = 1400;

/** Preserve one contiguous DOM block, including its nearby entity/role heading. */
function companyAddressBlocks($: cheerio.CheerioAPI): string[] {
  const candidates: Array<{ text: string; priority: number }> = [];
  const seen = new Set<string>();
  const semantic = 'address, [itemprop="address"], [class*="address" i], [id*="address" i]';
  const mostlyNavigation = (node: cheerio.Cheerio<AnyNode>, text: string) => {
    const anchors = node.find('a');
    return anchors.length > 4 && sanitizeText(anchors.text()).length > text.length / 2;
  };
  const add = (el: AnyNode, priority: number) => {
    let node = $(el);
    let text = sanitizeText(node.text());
    if (!text || text.length > COMPANY_ADDRESS_BLOCK_LIMIT || mostlyNavigation(node, text)) return;
    // Keep the entity heading with the address when their shared wrapper is small.
    // Never concatenate remote headings or neighbouring company blocks ourselves.
    for (let depth = 0; depth < 2; depth++) {
      const parent = node.parent();
      if (!parent.length || parent.is('body, html, footer, [role="contentinfo"]')) break;
      const parentText = sanitizeText(parent.text());
      if (parentText.length > COMPANY_ADDRESS_BLOCK_LIMIT || mostlyNavigation(parent, parentText)) break;
      node = parent;
      text = parentText;
    }
    if (!seen.has(text)) { seen.add(text); candidates.push({ text, priority }); }
  };
  // An address is sometimes a heading followed by one short paragraph per
  // field inside a much larger article. Keep that contiguous sibling run;
  // never skip other content or add our own entity/country labels.
  $('p, h1, h2, h3, h4, h5, h6').each((_, el) => {
    const first = $(el);
    const heading = sanitizeText(first.text());
    if (heading.length > 220 || !COMPANY_ADDRESS_ROLE.test(heading)) return;
    const fields = [heading];
    let next = first.next();
    while (fields.length < 8 && next.is('p, address')) {
      const value = sanitizeText(next.text());
      if (!value || value.length > 180 || COMPANY_ADDRESS_ROLE.test(value)) break;
      fields.push(value);
      next = next.next();
    }
    const text = fields.join('\n\n');
    if (fields.length > 1 && text.length <= COMPANY_ADDRESS_BLOCK_LIMIT && !seen.has(text)) {
      seen.add(text); candidates.push({ text, priority: 4 });
    }
  });
  $(semantic).each((_, el) => { add(el, 2); });
  $('p, li, div, section, article, td').each((_, el) => {
    const text = sanitizeText($(el).text());
    if (text.length <= COMPANY_ADDRESS_BLOCK_LIMIT && COMPANY_ADDRESS_ROLE.test(text)) add(el, 3);
  });
  return candidates.sort((a, b) => b.priority - a.priority).map((item) => item.text);
}

/** Отдельный ENG opt-in: основной текст + зарезервированное место адресам и JSON-LD. */
function extractCompanyEvidencePage(html: string, url: string, layoutAware?: boolean, evidenceTerms?: string[]): WebsitePage {
  const $ = cheerio.load(html);
  const terms = [...new Set((evidenceTerms ?? []).slice(0, 32).flatMap((term) => typeof term === 'string'
    ? term.slice(0, 200).normalize('NFKC').toLocaleLowerCase().match(/[\p{L}]{4,}/gu) ?? [] : []))].slice(0, 32);
  const links = companyEvidenceLinks($, url, terms);
  const structured = companyStructuredText($);
  $('script, style, noscript, iframe, svg, form, .cookie-banner, .cookie-consent, #cookie-banner, #cookie-consent').remove();
  // Keep the source's address fields readable when they occupy adjacent block elements.
  $('br').replaceWith('\n');
  $('p, div, li, address, section, h1, h2, h3, h4, h5, h6').append('\n');
  $('header, nav, [role="navigation"]').remove();
  // Some sites use Bootstrap/WordPress menus without a semantic nav element.
  // Remove the link list, not its outer banner, which can contain the page title.
  removeLayoutNoise($, '.navbar-nav, .navbar-collapse, .child-pages-nav, .main-menu, #main-menu, .menu-main-menu-container, [role="menu"], [role="menubar"]', (el) => {
    const node = $(el);
    const anchors = node.find('a');
    return anchors.length >= 2 && !node.find('h1, h2, h3, h4, h5, h6, address, [itemprop="address"]').length
      && sanitizeText(anchors.text()).length >= sanitizeText(node.text()).length * 0.7;
  });
  // ENG opt-in terms only rank real, whole source paragraphs. They never add
  // catalogue facts or combine one company's service with another's address.
  const serviceParagraphs: Array<{ text: string; score: number; order: number }> = [];
  if (terms.length) $('p, li, td').each((order, el) => {
    const node = $(el);
    if (node.closest('footer, [role="contentinfo"]').length) return;
    const text = sanitizeText(node.text());
    if (text.length < 30 || text.length > 1400) return;
    const words = text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}]{4,}/gu) ?? [];
    const score = terms.filter((term) => words.some((word) => word.startsWith(term))).length;
    if (score && !serviceParagraphs.some((item) => item.text === text)) serviceParagraphs.push({ text, score, order });
  });
  const textLimit = terms.length ? 6000 : MAX_TEXT_LENGTH;
  const addresses = companyAddressBlocks($);
  const footers: string[] = [];
  outermostOf($, 'footer, [role="contentinfo"]').each((_, el) => {
    const footer = $(el);
    const text = sanitizeText(footer.text());
    if (text.length <= COMPANY_ADDRESS_BLOCK_LIMIT) { if (text) footers.push(text); return; }
    // Whole local blocks only: a country in the middle of a long footer must
    // not disappear between a head excerpt and a tail excerpt.
    footer.find('p, address, li, div').each((_, child) => {
      const block = sanitizeText($(child).text());
      if (block && block.length <= COMPANY_ADDRESS_BLOCK_LIMIT) footers.push(block);
    });
  });
  const main = sanitizeText(extractTextFromHtml($.html(), { layoutAware }));
  const parts: string[] = [];
  let length = 0;
  let truncated = false;
  const addWhole = (part: string) => {
    if (!part || parts.some((saved) => saved.includes(part))) return;
    const extra = part.length + (parts.length ? COMPANY_EVIDENCE_SECTION_SEPARATOR.length : 0);
    if (length + extra > textLimit) { truncated = true; return; }
    parts.push(part);
    length += extra;
  };
  // Keep room for complete address/structured blocks even on long homepages.
  const mainLimit = addresses.length || structured.length ? 1200 : footers.length ? 2000 : MAX_TEXT_LENGTH;
  let mainExcerpt = sliceWholeChars(main, 0, mainLimit);
  if (mainExcerpt.length < main.length) {
    mainExcerpt = sliceWholeChars(mainExcerpt, 0, mainLimit - '\n[excerpt omitted]'.length);
    const boundary = Math.max(mainExcerpt.lastIndexOf('\n'), mainExcerpt.lastIndexOf('. '));
    if (boundary > 400) mainExcerpt = mainExcerpt.slice(0, boundary + 1).trimEnd();
    mainExcerpt += '\n[excerpt omitted]';
    truncated = true;
  }
  addWhole(mainExcerpt);
  // Leave at least 1800 characters for whole address/structured source blocks.
  for (const { text } of serviceParagraphs.sort((a, b) => b.score - a.score || a.order - b.order)) {
    const extra = text.length + (parts.length ? COMPANY_EVIDENCE_SECTION_SEPARATOR.length : 0);
    if (length + extra <= textLimit - 1800) addWhole(text);
    else truncated = true;
  }
  for (const part of [...addresses, ...structured, ...new Set(footers)]) addWhole(part);
  // All evidence sections are contiguous source blocks; none is cut through an address or JSON value.
  const text = parts.join(COMPANY_EVIDENCE_SECTION_SEPARATOR);
  return { url, text: stripUnstorableJsonChars(text), companyEvidenceLinks: links, companyEvidenceTextTruncated: truncated };
}

/**
 * Повтор строгого чтения: только там, где другой маршрут может ответить иначе —
 * ответа не было, 403/429 (бот-защита, геоблок, лимит) или 5xx. Отсутствующая
 * страница (404, 410 и прочие 4xx), не-HTML и отклонённый адрес — свойство
 * самой страницы, второй запрос их не изменит.
 */
function isStrictRetryable(outcome: HtmlFetchOutcome): boolean {
  if (outcome.kind === 'failed') return true;
  return outcome.kind === 'unusable' && (outcome.status === 403 || outcome.status === 429 || outcome.status >= 500);
}

/**
 * Строгое чтение ОДНОЙ страницы — опция для тех, кому нужна именно эта
 * страница, а не «что-нибудь с этого сайта» (fetchAndExtract): подстраница
 * сайта клиента, источник доказательства из поиска.
 *
 * В отличие от fetchAndExtract: нет обхода «о компании», нет подмены главной,
 * www- и http-вариантами; ответ ≥ 400 — не страница (allowHttpErrors не
 * включается); возвращается адрес, где закончились редиректы.
 *
 * Исходы:
 *  - WebsitePage — страница с HTML (текст может быть пустым);
 *  - null — сервер ответил, но страницы нет (статус не 2xx, не-HTML), адрес
 *    отклонён защитой чтения (guard) или чтение отменено;
 *  - бросает WebsiteNoHtmlError — адрес не ответил ни на одной попытке;
 *    невалидный адрес — ошибка normalizeUrl, как у fetchAndExtract.
 * Попыток столько же, сколько у fetchHtmlWithRetry (retries + 1, по умолчанию
 * две), с той же лестницей маршрутов, но повтор — только по isStrictRetryable.
 */
export async function fetchSinglePage(
  rawUrl: string,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    retries?: number;
    /** Заголовок Accept-Language; не передан — русский DEFAULT_ACCEPT_LANGUAGE. */
    acceptLanguage?: string;
    /** Порядок маршрутов; не передан — 'priority-first'. */
    routeOrder?: WebsiteFetchRouteOrder;
    /** Защита чтения (WebsiteFetchGuard); не передана — redirect: 'follow'. */
    guard?: WebsiteFetchGuard;
    /** Потолок тела в байтах; не передан — тело целиком. */
    maxBytes?: number;
    /** Разбор HTML → текст с учётом вёрстки конструкторов (ExtractTextOptions); не передан — прежний. */
    layoutAware?: boolean;
    /** Отдельное чтение доказательств о компании для ENG; не передано — прежний текст/поля. */
    companyEvidence?: boolean;
    /** ENG-only source paragraph ranking; at most 32 bounded words, never facts. */
    companyEvidenceTerms?: string[];
  },
): Promise<WebsitePage | null> {
  const url = normalizeUrl(rawUrl);
  const outcome = await fetchHtmlOutcomeWithRetry(
    url,
    {
      timeout: options?.timeout ?? FETCH_TIMEOUT_MS,
      signal: options?.signal,
      retries: options?.retries,
      acceptLanguage: options?.acceptLanguage,
      routeOrder: options?.routeOrder,
      guard: options?.guard,
      maxBytes: options?.maxBytes,
    },
    isStrictRetryable,
  );
  if (outcome.kind === 'failed') throw new WebsiteNoHtmlError();
  // 3xx без Location (с ним редирект пройден или отклонён) — тело заглушки,
  // а не страница.
  if (outcome.kind !== 'html' || outcome.status < 200 || outcome.status >= 300) return null;
  if (options?.companyEvidence === true) {
    return extractCompanyEvidencePage(outcome.html, outcome.url, options.layoutAware, options.companyEvidenceTerms);
  }
  const text = sanitizeText(extractTextFromHtml(outcome.html, { layoutAware: options?.layoutAware }));
  return {
    url: outcome.url,
    text: text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH).trimEnd() + '…' : text,
  };
}

import {
  extractInnFromText as extractInnFromTextImpl,
  extractInnFromHtml as extractInnFromHtmlImpl,
} from '@/lib/enrich/innExtractor';

export { extractInnFromTextImpl as extractInnFromText, extractInnFromHtmlImpl as extractInnFromHtml };

const LEGAL_PATHS_PRIORITY = [
  '/contacts', '/kontakty', '/контакты',
  '/requisites', '/rekvizity', '/реквизиты',
  '/oferta', '/оферта',
  '/policy', '/privacy',
  '/legal',
];

/**
 * Fetch website pages and extract INN.
 * 1) Fetch main page raw HTML — scan both raw HTML and extracted text
 * 2) If not found — try top legal pages in parallel batches
 */
export async function fetchInnFromWebsite(
  rawUrl: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<string | null> {
  const url = normalizeUrl(rawUrl);
  // NB: do NOT use `await import('./innExtractor')` with bundler-ignore hints here —
  // the Next.js prod bundler then refuses to emit a chunk and the runtime fails with
  // `Cannot find module .../chunks/innExtractor`. Use the static import above instead.
  const extract = extractInnFromTextImpl;
  const extractInnFromHtml = extractInnFromHtmlImpl;
  const timeout = options?.timeout ?? 12_000;
  const signal = options?.signal;

  const origin = new URL(url).origin;
  const tryWithWww = !/^https?:\/\/www\./i.test(url);
  const wwwOrigin = tryWithWww ? origin.replace(/^https?:\/\//i, (m) => `${m}www.`) : null;

  // Step 1: fetch main page — search raw HTML first (catches SPA/JS-rendered INN)
  const mainHtml = await fetchHtmlWithRetry(url, {
    timeout,
    signal,
    allowHttpErrors: true,
    retries: 0,
  });
  if (mainHtml?.html) {
    const fromHtml = extractInnFromHtml(mainHtml.html);
    if (fromHtml) return fromHtml;

    const text = extractTextFromHtml(mainHtml.html);
    const fromText = extract(text);
    if (fromText) return fromText;
  }

  // Also try www variant
  if (!mainHtml && wwwOrigin) {
    const wwwHtml = await fetchHtmlWithRetry(wwwOrigin, {
      timeout,
      signal,
      allowHttpErrors: true,
      retries: 0,
    });
    if (wwwHtml?.html) {
      const fromHtml = extractInnFromHtml(wwwHtml.html);
      if (fromHtml) return fromHtml;
    }
  }

  // Step 2: try legal/requisite pages — parallel batch of 3
  const candidates = LEGAL_PATHS_PRIORITY.map((p) => `${origin}${p}`);

  for (let i = 0; i < candidates.length; i += 3) {
    if (signal?.aborted) break;

    const batch = candidates.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map((c) => fetchHtmlWithRetry(c, { timeout: 6_000, signal, retries: 0 })),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value?.html) continue;
      const fromHtml = extractInnFromHtml(r.value.html);
      if (fromHtml) return fromHtml;

      const text = extractTextFromHtml(r.value.html);
      const fromText = extract(text);
      if (fromText) return fromText;
    }
  }

  return null;
}
