/**
 * Social-posts extractor.
 *
 * Принимает массив нормализованных URL'ов соцсетей компании (как их находит
 * `extractSocialMedia`) и возвращает массив последних N постов с каждой
 * поддерживаемой сети — текстом + опциональной датой публикации.
 *
 * Поддерживаются ТОЛЬКО публичные web-источники без авторизации:
 *   - Telegram: t.me/s/<channel>      — лучший источник, чистая статика
 *   - VK:       m.vk.com/<id>          — мобильная версия отдаёт статичный HTML
 *   - OK:       m.ok.ru/group/<id>     — мобильная версия групп
 *   - Dzen:     dzen.ru/<channel>      — есть SSR ленты
 *
 * Намеренно НЕ поддерживаются:
 *   - Instagram / Facebook — заблокированы в РФ + требуют auth
 *   - YouTube / RuTube / TikTok — видео-фокус, постов в нашем смысле нет
 *   - GitHub / Behance / Dribbble / Medium / Threads — не B2B-каналы анонсов
 *
 * Возвращает массив `SocialPost` (network/url/text/date) длиной ≤
 * `maxPostsPerNetwork × количество_поддерживаемых_сетей_в_input`.
 * Дальше LLM-event-детектор анализирует эти посты и пишет 4 сигнала.
 */

import * as cheerio from 'cheerio';
import { fetchHtmlWithRetry } from '@/lib/enrich/websiteParser';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_POSTS = 10;
const MAX_POST_TEXT_LENGTH = 2_000;

export interface SocialPost {
  /** Family of the social network the post came from. */
  network: 'telegram' | 'vk' | 'ok' | 'dzen';
  /** Source page URL (channel / group / blog, not the post itself). */
  url: string;
  /** Plain-text body of the post — HTML stripped, runs of whitespace collapsed. */
  text: string;
  /** ISO date string (YYYY-MM-DD) when we could parse it. */
  date?: string;
}

export interface ExtractSocialPostsOptions {
  /** HTTP fetch timeout per network. Default 8 s. */
  timeout?: number;
  /** Cap on posts returned per network. Default 10. */
  maxPostsPerNetwork?: number;
  /** External abort signal — checked between fetches. */
  signal?: AbortSignal;
}

/**
 * Route a single social URL to its per-network parser and return parsed posts.
 * Returns [] on any failure (URL not supported, fetch failed, no posts found).
 * Never throws.
 */
async function fetchPostsForOneUrl(
  url: string,
  options: Required<Pick<ExtractSocialPostsOptions, 'timeout' | 'maxPostsPerNetwork'>> & {
    signal?: AbortSignal;
  },
): Promise<SocialPost[]> {
  try {
    if (/^https?:\/\/(?:www\.)?t\.me\//i.test(url)) {
      return await fetchTelegramPosts(url, options);
    }
    if (/^https?:\/\/(?:m\.|www\.)?vk\.com\//i.test(url)) {
      return await fetchVkPosts(url, options);
    }
    if (/^https?:\/\/(?:m\.|www\.)?(?:ok\.ru|odnoklassniki\.ru)\//i.test(url)) {
      return await fetchOkPosts(url, options);
    }
    if (/^https?:\/\/(?:www\.)?dzen\.ru\//i.test(url)) {
      return await fetchDzenPosts(url, options);
    }
    // URL is from an unsupported network (FB / IG / YT / TikTok / ...).
    return [];
  } catch {
    return [];
  }
}

export async function extractSocialPosts(
  socialUrls: string[],
  options?: ExtractSocialPostsOptions,
): Promise<SocialPost[]> {
  if (!socialUrls || socialUrls.length === 0) return [];

  const merged = {
    timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
    maxPostsPerNetwork: options?.maxPostsPerNetwork ?? DEFAULT_MAX_POSTS,
    signal: options?.signal,
  };

  // Fetch all networks in parallel — they're independent and the slowest one
  // dominates wall-clock when serial. Concurrency = number of social URLs the
  // company has, which is typically 2-5; no extra throttling needed.
  const results = await Promise.allSettled(
    socialUrls.map((url) => fetchPostsForOneUrl(url, merged)),
  );

  const out: SocialPost[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(...r.value);
  }
  return out;
}

// ─── Telegram (public channel via t.me/s/<channel>) ─────────────────────────
//
// Telegram exposes a static HTML mirror of every public channel at
// `t.me/s/<handle>` with the last ~20 posts inlined as
// `<div class="tgme_widget_message_text">` blocks and a sibling `<time>` tag
// carrying the ISO datetime. This is the cleanest data source we have.
async function fetchTelegramPosts(
  rawUrl: string,
  options: { timeout: number; maxPostsPerNetwork: number; signal?: AbortSignal },
): Promise<SocialPost[]> {
  // Canonicalise t.me/<channel> → t.me/s/<channel>. The `s/` prefix is what
  // returns the SSR view; the bare URL returns a JS-only stub.
  const m = rawUrl.match(/^https?:\/\/(?:www\.)?t\.me\/(?:s\/)?(\+?[A-Za-z0-9_]+)/i);
  if (!m) return [];
  const handle = m[1];
  if (handle.startsWith('+')) return []; // private channel — no public view
  const previewUrl = `https://t.me/s/${handle}`;

  const res = await fetchHtmlWithRetry(previewUrl, {
    timeout: options.timeout,
    signal: options.signal,
    allowHttpErrors: false,
  });
  if (!res || !res.html) return [];

  const $ = cheerio.load(res.html);
  const posts: SocialPost[] = [];

  $('.tgme_widget_message').each((_, el) => {
    if (posts.length >= options.maxPostsPerNetwork) return false;
    const $el = $(el);
    const textNode = $el.find('.tgme_widget_message_text').first();
    const text = cleanText(textNode.text());
    if (!text || text.length < 10) return; // skip empty / 1-emoji posts
    const time = $el.find('time[datetime]').first().attr('datetime') ?? '';
    const date = parseIsoDate(time);
    posts.push({
      network: 'telegram',
      url: previewUrl,
      text: text.slice(0, MAX_POST_TEXT_LENGTH),
      ...(date ? { date } : {}),
    });
  });

  return posts;
}

// ─── VK (mobile public-group page) ──────────────────────────────────────────
//
// m.vk.com/<id> returns a static HTML feed of the group's wall (10-15 posts).
// Posts live in `<div class="wall_item">` with the body inside
// `<div class="pi_text">`. The date sits in `<a class="wi_date">` as a
// human string like "16 апреля в 15:42" — we parse common Russian phrasings
// and fall back to undefined when unsure.
async function fetchVkPosts(
  rawUrl: string,
  options: { timeout: number; maxPostsPerNetwork: number; signal?: AbortSignal },
): Promise<SocialPost[]> {
  const m = rawUrl.match(/^https?:\/\/(?:m\.|www\.)?vk\.com\/([A-Za-z0-9_.]+)/i);
  if (!m) return [];
  const handle = m[1];
  if (/^(?:share|away|search|feed|login)\b/i.test(handle)) return []; // utility paths
  const mobileUrl = `https://m.vk.com/${handle}`;

  const res = await fetchHtmlWithRetry(mobileUrl, {
    timeout: options.timeout,
    signal: options.signal,
    allowHttpErrors: false,
  });
  if (!res || !res.html) return [];

  const $ = cheerio.load(res.html);
  const posts: SocialPost[] = [];

  $('.wall_item, .post').each((_, el) => {
    if (posts.length >= options.maxPostsPerNetwork) return false;
    const $el = $(el);
    const textNode = $el.find('.pi_text, .wall_post_text, .post__text').first();
    const text = cleanText(textNode.text());
    if (!text || text.length < 10) return;
    const dateText = $el.find('.wi_date, .post__date, time').first().text();
    const date = parseRuRelativeDate(dateText);
    posts.push({
      network: 'vk',
      url: mobileUrl,
      text: text.slice(0, MAX_POST_TEXT_LENGTH),
      ...(date ? { date } : {}),
    });
  });

  return posts;
}

// ─── Odnoklassniki (mobile group page) ──────────────────────────────────────
//
// OK's mobile group page is at m.ok.ru/group/<id> and returns a feed similar
// to VK in shape. Posts live in `<div class="mfeed_i">` with body text in
// `<span class="mtext_w">`. Date text is the same Russian-relative form.
async function fetchOkPosts(
  rawUrl: string,
  options: { timeout: number; maxPostsPerNetwork: number; signal?: AbortSignal },
): Promise<SocialPost[]> {
  const m = rawUrl.match(/^https?:\/\/(?:m\.|www\.)?(?:ok\.ru|odnoklassniki\.ru)\/([A-Za-z0-9_./]+)/i);
  if (!m) return [];
  const path = m[1];
  if (/^(?:share|live|search|feed|dk|offer)\b/i.test(path)) return [];
  const mobileUrl = `https://m.ok.ru/${path}`;

  const res = await fetchHtmlWithRetry(mobileUrl, {
    timeout: options.timeout,
    signal: options.signal,
    allowHttpErrors: false,
  });
  if (!res || !res.html) return [];

  const $ = cheerio.load(res.html);
  const posts: SocialPost[] = [];

  $('.mfeed_i, .feed-w, [data-l*="feed"]').each((_, el) => {
    if (posts.length >= options.maxPostsPerNetwork) return false;
    const $el = $(el);
    const textNode = $el.find('.mtext_w, .text-block, .feed-text').first();
    const text = cleanText(textNode.text());
    if (!text || text.length < 10) return;
    const dateText = $el.find('.mts_date, .date, time').first().text();
    const date = parseRuRelativeDate(dateText);
    posts.push({
      network: 'ok',
      url: mobileUrl,
      text: text.slice(0, MAX_POST_TEXT_LENGTH),
      ...(date ? { date } : {}),
    });
  });

  return posts;
}

// ─── Dzen (channel page) ────────────────────────────────────────────────────
//
// dzen.ru/<channel> is SSR-rendered with a card list. Each card is a
// `<div class="card-feed__item">` (selectors vary by deploy — we keep a
// permissive list). The card title + lede live in `[class*="card-feed__title"]`
// and `[class*="card-feed__excerpt"]` respectively.
async function fetchDzenPosts(
  rawUrl: string,
  options: { timeout: number; maxPostsPerNetwork: number; signal?: AbortSignal },
): Promise<SocialPost[]> {
  const res = await fetchHtmlWithRetry(rawUrl, {
    timeout: options.timeout,
    signal: options.signal,
    allowHttpErrors: false,
  });
  if (!res || !res.html) return [];

  const $ = cheerio.load(res.html);
  const posts: SocialPost[] = [];

  $('[class*="card-feed__item"], [class*="card-component"], article').each((_, el) => {
    if (posts.length >= options.maxPostsPerNetwork) return false;
    const $el = $(el);
    const title = cleanText($el.find('[class*="title"], h2, h3').first().text());
    const excerpt = cleanText($el.find('[class*="excerpt"], [class*="annotation"], p').first().text());
    const text = [title, excerpt].filter(Boolean).join(' — ');
    if (!text || text.length < 10) return;
    const time = $el.find('time[datetime]').first().attr('datetime') ?? '';
    const date = parseIsoDate(time);
    posts.push({
      network: 'dzen',
      url: rawUrl,
      text: text.slice(0, MAX_POST_TEXT_LENGTH),
      ...(date ? { date } : {}),
    });
  });

  return posts;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function parseIsoDate(s: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

// Russian relative date parser ("16 апреля в 15:42", "сегодня в 12:30",
// "вчера в 18:00", "29 ноя"). Returns ISO YYYY-MM-DD when we can pin a year
// — defaults to current year for "DD месяц" without explicit year, and the
// previous year if that places the post in the future (the post can't be in
// the future, so it must be last year's same date).
const RU_MONTHS: Record<string, string> = {
  'янв': '01', 'фев': '02', 'мар': '03', 'апр': '04', 'мая': '05',
  'май': '05', 'июн': '06', 'июл': '07', 'авг': '08', 'сен': '09',
  'окт': '10', 'ноя': '11', 'дек': '12',
};

function parseRuRelativeDate(raw: string): string | undefined {
  if (!raw) return undefined;
  const text = raw.toLowerCase().trim();
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  if (/сегодня/i.test(text)) return todayIso;
  if (/вчера/i.test(text)) {
    const d = new Date(today.getTime() - 86_400_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // "16 апреля" / "16 апр" / "16 апр 2024"
  const m = text.match(/(\d{1,2})\s+([а-яё]{3,8})(?:\s+(\d{4}))?/);
  if (!m) return undefined;
  const day = pad(parseInt(m[1], 10));
  const monPrefix = m[2].slice(0, 3);
  const mm = RU_MONTHS[monPrefix];
  if (!mm) return undefined;
  let year = m[3] ? parseInt(m[3], 10) : today.getFullYear();
  // If the parsed date is in the future, the post is from last year.
  const candidate = `${year}-${mm}-${day}`;
  if (candidate > todayIso) year -= 1;
  return `${year}-${mm}-${day}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
