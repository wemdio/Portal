import * as cheerio from 'cheerio';

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
  const today = new Date();
  const cutoffMs = today.getTime() + 7 * 24 * 3600 * 1000;
  const cutoff = new Date(cutoffMs);
  const cutoffIso = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  return iso <= cutoffIso;
}

function extractDateFromElement($: cheerio.CheerioAPI, el: cheerio.Element): string | null {
  const node = $(el);
  const timeDate = node.find('time[datetime]').first().attr('datetime') ?? '';
  const timeIso = parseIsoDate(timeDate);
  if (timeIso) return timeIso;

  const dateText = node.find(DATE_TEXT_SELECTOR).first().text();
  const dateFromMeta = findDateInText(dateText);
  if (dateFromMeta) return dateFromMeta;

  return findDateInText(node.text());
}

function extractPostTextFromElement($: cheerio.CheerioAPI, el: cheerio.Element): string {
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
