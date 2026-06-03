import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

const RU_MONTH_PREFIXES: Array<[string, string]> = [
  ['январ', '01'],
  ['феврал', '02'],
  ['март', '03'],
  ['апрел', '04'],
  ['май', '05'], ['мая', '05'], ['мае', '05'],
  ['июн', '06'],
  ['июл', '07'],
  ['август', '08'],
  ['сентябр', '09'],
  ['октябр', '10'],
  ['ноябр', '11'],
  ['декабр', '12'],
];

function parseIsoDate(s: string): string | null {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseRuDate(s: string): string | null {
  const m = s.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const monthRaw = m[2];
  const year = m[3];
  for (const [prefix, num] of RU_MONTH_PREFIXES) {
    if (monthRaw.startsWith(prefix)) {
      return `${year}-${num}-${day}`;
    }
  }
  return null;
}

const EN_MONTH_PREFIXES: Array<[string, string]> = [
  ['jan', '01'], ['feb', '02'], ['mar', '03'], ['apr', '04'],
  ['may', '05'], ['jun', '06'], ['jul', '07'], ['aug', '08'],
  ['sep', '09'], ['oct', '10'], ['nov', '11'], ['dec', '12'],
];

function parseEnDate(s: string): string | null {
  const m = s.toLowerCase().match(/([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const monthRaw = m[1];
  const day = m[2].padStart(2, '0');
  const year = m[3];
  for (const [prefix, num] of EN_MONTH_PREFIXES) {
    if (monthRaw.startsWith(prefix)) return `${year}-${num}-${day}`;
  }
  return null;
}

function parseDotDate(s: string): string | null {
  const m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3];
  if (parseInt(month) > 12 || parseInt(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

const DATE_TEXT_SELECTOR = [
  '[class*="post-date"]', '[class*="entry-date"]',
  '[class*="article-date"]', '[class*="publish-date"]',
  '[class*="date-published"]', '[class*="blog-date"]',
  '[class*="news-date"]', '[class*="post-meta"]',
].join(', ');

const POST_CONTAINER_SELECTOR = [
  'article',
  '[class*="post"]',
  '[class*="article"]',
  '[class*="news-item"]',
  '[class*="blog-item"]',
  '[class*="entry"]',
  '[class*="feed"] li',
].join(', ');

const TITLE_SELECTOR = [
  'h1',
  'h2',
  'h3',
  '[class*="title"]',
  '[class*="heading"]',
  'a[rel="bookmark"]',
].join(', ');

const BODY_SELECTOR = [
  '[class*="excerpt"]',
  '[class*="summary"]',
  '[class*="description"]',
  '[class*="content"]',
  'p',
].join(', ');

/**
 * Selectors that identify the BODY of a single blog/news post page (not a
 * listing card). Used by extractFullPostText to pull the complete post text.
 */
const ARTICLE_BODY_SELECTOR = [
  '[class*="post-content"]',
  '[class*="post__content"]',
  '[class*="post-body"]',
  '[class*="post__text"]',
  '[class*="entry-content"]',
  '[class*="entry__content"]',
  '[class*="article-content"]',
  '[class*="article__content"]',
  '[class*="article-body"]',
  '[class*="article__body"]',
  '[class*="article__text"]',
  '[class*="single-post"]',
  '[class*="blog-detail"]',
  '[class*="news-detail"]',
  '[class*="detail__text"]',
  '[class*="detail-text"]',
  '[itemprop="articleBody"]',
].join(', ');

/** Elements inside a post body that are chrome/noise, not prose. */
const ARTICLE_NOISE_SELECTOR = [
  'script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'button',
  '[class*="share"]', '[class*="social"]', '[class*="related"]', '[class*="comment"]',
  '[class*="subscribe"]', '[class*="breadcrumb"]', '[class*="tags"]', '[class*="author"]',
  '[class*="sidebar"]', '[class*="newsletter"]', '[class*="banner"]', '[class*="advert"]',
].join(', ');

/** A real post body must reach this length to count as "full" (else fall back to excerpt). */
const MIN_FULL_POST_BODY = 200;
/** Upper bound on stored full-post text — keeps spreadsheet cells bounded. */
const FULL_POST_MAX = 4000;

/** Listing helper URLs that are NOT individual posts. */
const NON_POST_PATH = /\/(page|tag|tags|category|categories|rubric|rubriki|topic|topics|author|authors|search|feed|rss|archive|sitemap)(\/|$)/i;
/** A blog/news content root followed by a slug segment ⇒ an individual post. */
const CONTENT_ROOT_WITH_SLUG = /\/(blog|news|novosti|press|articles?|stati|statya|posts?|journal|insights?|publikacii|media)\/[^/?#]+/i;

const SOCIAL_HOST_PATTERNS = [
  /(^|\.)t\.me$/i,
  /(^|\.)telegram\.me$/i,
  /(^|\.)vk\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
];

const SOCIAL_SKIP_PATH = /\/(share|sharer|intent|login|signup|privacy|terms)\b/i;

function cleanText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function truncateText(value: string, max = 700): string {
  const cleaned = cleanText(value);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

function findDateInText(text: string): string | null {
  return parseIsoDate(text) ?? parseRuDate(text) ?? parseEnDate(text) ?? parseDotDate(text);
}

function isReasonablePostText(text: string): boolean {
  if (text.length < 12) return false;
  const lowered = text.toLowerCase();
  if (/cookie|privacy policy|terms of use|all rights reserved/i.test(lowered)) return false;
  return true;
}

function isDateAcceptable(iso: string): boolean {
  // Cheap structural check first: a malformed ISO date ("2024-13-45") slips
  // through the regex parsers because they don't enforce real-calendar limits.
  // new Date(iso) will yield NaN for an impossible date.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Verify the round-trip — `new Date("2024-13-45")` is normalized to a
  // valid date in Chromium, so we need to ensure the components match.
  const y = parsed.getUTCFullYear();
  const m = parsed.getUTCMonth() + 1;
  const d = parsed.getUTCDate();
  const reIso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (reIso !== iso) return false;

  const today = new Date();
  // Reject anything more than 7 days in the future — that's a typo or a
  // misparsed locale (e.g. dd.mm.yyyy read as mm.dd.yyyy).
  const futureCutoffMs = today.getTime() + 7 * 24 * 3600 * 1000;
  if (parsed.getTime() > futureCutoffMs) return false;

  // Reject anything older than 10 years — almost always a stale archive
  // widget, a static "Опубликовано в 2014" footer, or a misparsed
  // copyright year. We want the LATEST post, so multi-year-old candidates
  // are noise that crowds out a legitimate recent post.
  const pastCutoffMs = today.getTime() - 10 * 365 * 24 * 3600 * 1000;
  if (parsed.getTime() < pastCutoffMs) return false;

  return true;
}

function extractDateFromElement($: cheerio.CheerioAPI, el: AnyNode): string | null {
  const node = $(el);
  const timeDate = node.find('time[datetime]').first().attr('datetime') ?? '';
  const timeIso = parseIsoDate(timeDate);
  if (timeIso) return timeIso;

  const dateText = node.find(DATE_TEXT_SELECTOR).first().text();
  const dateFromMeta = findDateInText(dateText);
  if (dateFromMeta) return dateFromMeta;

  return findDateInText(node.text());
}

function extractPostTextFromElement($: cheerio.CheerioAPI, el: AnyNode): string {
  const node = $(el).clone();
  node.find('script, style, noscript, svg, nav, footer, form, button, time, [class*="date"], [class*="meta"]').remove();

  const title = cleanText(node.find(TITLE_SELECTOR).first().text());
  const bodyParts: string[] = [];
  node.find(BODY_SELECTOR).slice(0, 3).each((_, bodyEl) => {
    const text = cleanText($(bodyEl).text());
    if (text && text !== title && !bodyParts.includes(text)) bodyParts.push(text);
  });

  const combined = cleanText([title, ...bodyParts].filter(Boolean).join(' — '));
  if (isReasonablePostText(combined)) return truncateText(combined);

  return truncateText(node.text());
}

function extractMetaPreview($: cheerio.CheerioAPI): string | undefined {
  const title = cleanText(
    $('meta[property="og:title"]').attr('content') ??
    $('meta[name="twitter:title"]').attr('content') ??
    $('title').text() ??
    '',
  );
  const description = cleanText(
    $('meta[property="og:description"]').attr('content') ??
    $('meta[name="twitter:description"]').attr('content') ??
    $('meta[name="description"]').attr('content') ??
    '',
  );
  const combined = cleanText([title, description].filter(Boolean).join(' — '));
  return isReasonablePostText(combined) ? truncateText(combined) : undefined;
}

export function discoverBlogOrSocialUrls(html: string, baseUrl: string, limit = 4): string[] {
  if (!html) return [];

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const sameDomain: string[] = [];
  const social: string[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, el) => {
    const rawHref = $(el).attr('href') ?? '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('?')) return;

    let url: URL;
    try {
      url = new URL(rawHref, base);
    } catch {
      return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (SOCIAL_SKIP_PATH.test(url.pathname)) return;

    url.hash = '';
    const normalized = url.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);

    let path: string;
    try {
      path = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      path = url.pathname.toLowerCase();
    }
    const text = $(el).text().toLowerCase();
    const looksLikeContent =
      /\/(blog|news|articles?|posts?|press|journal|insights?)\b/i.test(path) ||
      /\b(blog|news|articles?|posts?|press|journal|insights?)\b/i.test(text);
    if (url.host === base.host && looksLikeContent) {
      sameDomain.push(normalized);
      return;
    }

    const isSocial = SOCIAL_HOST_PATTERNS.some((re) => re.test(url.hostname));
    if (!isSocial) return;
    if (/linkedin\.com$/i.test(url.hostname) && !/\/company\//i.test(url.pathname)) return;
    social.push(normalized);
  });

  return [...sameDomain, ...social].slice(0, limit);
}

export function extractBlogLastPost(html: string): string | undefined {
  if (!html) return undefined;
  const $ = cheerio.load(html);
  const datedCandidates: Array<{ date: string; text: string }> = [];
  const fallbackCandidates: string[] = [];

  $(POST_CONTAINER_SELECTOR).each((_, el) => {
    const text = extractPostTextFromElement($, el);
    const date = extractDateFromElement($, el);
    if (!isReasonablePostText(text) && date && isDateAcceptable(date)) {
      datedCandidates.push({ date, text: date });
      return;
    }
    if (!isReasonablePostText(text)) return;

    if (date && isDateAcceptable(date)) {
      datedCandidates.push({ date, text });
    } else {
      fallbackCandidates.push(text);
    }
  });

  if (datedCandidates.length > 0) {
    return datedCandidates.sort((a, b) => b.date.localeCompare(a.date))[0].text;
  }

  const pageTitle = cleanText($('article h1, article h2, h1, h2').first().text());
  if (isReasonablePostText(pageTitle)) return truncateText(pageTitle);

  const metaPreview = extractMetaPreview($);
  if (metaPreview) return metaPreview;

  return fallbackCandidates[0];
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function extractArticleBodyText($: cheerio.CheerioAPI, el: AnyNode): string {
  const node = $(el).clone();
  node.find(ARTICLE_NOISE_SELECTOR).remove();

  const blocks: string[] = [];
  node.find('p, li, h2, h3, h4, blockquote, pre').each((_, blockEl) => {
    const text = cleanText($(blockEl).text());
    if (text.length >= 2 && !blocks.includes(text)) blocks.push(text);
  });

  const joined = blocks.join('\n\n');
  if (joined.length >= 40) return joined;
  return cleanText(node.text());
}

/**
 * Extract the full text of a single blog/news post page (title + body).
 *
 * Targets explicit article-body containers first, then a lone <article>, then a
 * lone <main>. Returns undefined when the page has no dominant single-post body
 * (e.g. a listing of many short cards), so callers can fall back to an excerpt.
 */
export function extractFullPostText(html: string, max = FULL_POST_MAX): string | undefined {
  if (!html) return undefined;
  const $ = cheerio.load(html);

  const title = cleanText(
    $('article h1').first().text() ||
    $('h1').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    $('[class*="post-title"], [class*="entry-title"], [class*="article-title"]').first().text() ||
    '',
  );

  let bodyText = '';
  const bodyContainers = $(ARTICLE_BODY_SELECTOR);
  if (bodyContainers.length > 0) {
    bodyContainers.each((_, el) => {
      const text = extractArticleBodyText($, el);
      if (text.length > bodyText.length) bodyText = text;
    });
  }
  if (bodyText.length < MIN_FULL_POST_BODY) {
    const articles = $('article');
    if (articles.length === 1) {
      const only = articles.get(0);
      if (only) bodyText = extractArticleBodyText($, only);
    }
  }
  if (bodyText.length < MIN_FULL_POST_BODY) {
    const mains = $('main');
    if (mains.length === 1) {
      const only = mains.get(0);
      if (only) bodyText = extractArticleBodyText($, only);
    }
  }

  if (bodyText.length < MIN_FULL_POST_BODY) return undefined;

  const combined = (title && !bodyText.startsWith(title) ? `${title}\n\n${bodyText}` : bodyText).trim();
  if (!isReasonablePostText(combined)) return undefined;
  if (combined.length <= max) return combined;
  return `${combined.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Find the URL of the most recent post on a blog/news listing page.
 *
 * Only same-host links that live under the company's blog/news section are
 * considered — pagination, category, tag, author and external links are
 * excluded — so we follow into the company's own latest article rather than a
 * random link. Sorted by detected post date (newest first), then DOM order.
 */
export function findLatestPostUrl(html: string, listingUrl: string): string | null {
  if (!html) return null;
  let base: URL;
  try {
    base = new URL(listingUrl);
  } catch {
    return null;
  }

  const $ = cheerio.load(html);
  let listingPath: string;
  try {
    listingPath = stripTrailingSlash(decodeURIComponent(base.pathname).toLowerCase());
  } catch {
    listingPath = stripTrailingSlash(base.pathname.toLowerCase());
  }

  interface Candidate { url: string; date: string | null; order: number; }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let order = 0;

  const looksLikePost = (path: string): boolean => {
    const p = stripTrailingSlash(path);
    if (!p || p === '/' || p === listingPath) return false;
    if (NON_POST_PATH.test(p)) return false;
    if (listingPath && listingPath !== '/' && p.startsWith(`${listingPath}/`)) return true;
    if (/\/\d{4}\/\d{2}\//.test(p)) return true;
    if (CONTENT_ROOT_WITH_SLUG.test(p)) return true;
    return false;
  };

  const consider = (rawHref: string | undefined, date: string | null) => {
    const href = (rawHref ?? '').trim();
    if (!href || /^(#|javascript:|mailto:|tel:|\?)/i.test(href)) return;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.host !== base.host) return;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      path = url.pathname.toLowerCase();
    }
    if (!looksLikePost(path)) return;
    url.hash = '';
    const normalized = url.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ url: normalized, date, order: order++ });
  };

  $(POST_CONTAINER_SELECTOR).each((_, el) => {
    const node = $(el);
    const date = extractDateFromElement($, el);
    const href =
      node.find('a[rel="bookmark"]').first().attr('href') ||
      node.find('h1 a[href], h2 a[href], h3 a[href]').first().attr('href') ||
      node.find('[class*="title"] a[href], [class*="heading"] a[href]').first().attr('href') ||
      node.find('a[href]').first().attr('href');
    consider(href, date);
  });

  if (candidates.length === 0) {
    $('a[href]').each((_, el) => {
      const node = $(el);
      const date = findDateInText(node.closest('li, article, div').first().text());
      consider(node.attr('href'), date);
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.date && b.date) return a.date === b.date ? a.order - b.order : b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.order - b.order;
  });

  return candidates[0].url;
}
