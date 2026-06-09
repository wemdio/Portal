import { fetchHtmlWithRetry, fetchHtmlWithPlaywright } from '@/lib/enrich/websiteParser';
import { normalizeUrl, extractNormalizedUrls } from '@/lib/enrich/urlUtils';
import { detectSignals, determineProfile, formatStack, integrationsFromSignals } from '@/lib/enrich/signalDetector';
import { discoverSubpaths, FALLBACK_PATHS } from '@/lib/enrich/subpathDiscovery';
import {
  ExtractorKey,
  ExtractedData,
  EXTRACTOR_TO_SUBPAGES,
  SubpageKind,
} from '@/lib/enrich/extractors/types';
import { extractCustomers, filterCustomerCandidates } from '@/lib/enrich/extractors/customersExtractor';
import { nameListLooksReal } from '@/lib/enrich/extractors/nameQuality';
import { llmExtractCustomers } from '@/lib/enrich/extractors/llmCustomersExtractor';
import { extractCasesCount } from '@/lib/enrich/extractors/casesCountExtractor';
import { extractCaseIndustries } from '@/lib/enrich/extractors/caseIndustriesExtractor';
import { detectEnterpriseLogos, detectEnterpriseInHtml } from '@/lib/enrich/extractors/enterpriseLogosDetector';
import { extractPricingModel } from '@/lib/enrich/extractors/pricingModelExtractor';
import { extractPricingDetails } from '@/lib/enrich/extractors/pricingDetailExtractor';
import { extractHiring, findExternalCareerLinks } from '@/lib/enrich/extractors/hiringExtractor';
import { extractIntegrations } from '@/lib/enrich/extractors/integrationsExtractor';
import { extractFoundedYear } from '@/lib/enrich/extractors/foundedYearExtractor';
import { extractTeamSize } from '@/lib/enrich/extractors/teamSizeExtractor';
import { extractSocialMedia } from '@/lib/enrich/extractors/socialMediaExtractor';
import { extractSocialPosts } from '@/lib/enrich/extractors/socialPostsExtractor';
import { detectEventSignals } from '@/lib/enrich/extractors/eventDetector';
import {
  discoverBlogOrSocialUrls,
  extractBlogLastPost,
  extractFullPostText,
  findLatestPostUrl,
} from '@/lib/enrich/extractors/blogActivityExtractor';
import { llmExtractFields } from '@/lib/enrich/extractors/llmExtractor';

// Convenience predicate — any of the 4 event-signal pairs requested. Used to
// gate the LLM event-detector (it costs ~$0.01/URL and must not run for
// presets that didn't enable any event_* column).
const EVENT_KEYS = new Set<ExtractorKey>([
  'event_opening', 'event_opening_summary',
  'event_redesign', 'event_redesign_summary',
  'event_renovation', 'event_renovation_summary',
  'event_geo', 'event_geo_summary',
]);

function anyEventRequested(extractors: ExtractorKey[]): boolean {
  return extractors.some((k) => EVENT_KEYS.has(k));
}

const DEFAULT_TIMEOUT_MS = 12_000;
const PLAYWRIGHT_TIMEOUT_MS = 18_000;
const DEFAULT_SUBPAGE_TIMEOUT_MS = 8_000;

const DEFAULT_EXTRACTORS: ExtractorKey[] = ['stack', 'profile'];

export type ProcessSignalsResult =
  | (ExtractedData & {
      stack: string;
      profile: string;
      signalIds: string[];
      method: 'http' | 'playwright';
    })
  | { error: string };

export interface ProcessSignalsOptions {
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Which extractors to run. Each extractor maps to 0..N subpages
   * (see EXTRACTOR_TO_SUBPAGES) — only those subpages are fetched.
   * Defaults to ['stack','profile'] for backward compatibility with
   * existing job records that don't carry an `extractors` array.
   */
  extractors?: ExtractorKey[];
  /** Per-subpage timeout in ms. Defaults to 8 000. */
  subpageTimeout?: number;
}

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i, 'Домен не найден (DNS не резолвится)'],
  [/ERR_CONNECTION_REFUSED|ECONNREFUSED/i, 'Сервер отклонил соединение'],
  [/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|[Tt]imeout/i, 'Таймаут подключения'],
  [/ERR_CERT|ERR_SSL|certificate/i, 'Ошибка SSL-сертификата'],
  [/ERR_CONNECTION_RESET|ECONNRESET/i, 'Соединение сброшено'],
  [/ERR_TOO_MANY_REDIRECTS/i, 'Слишком много редиректов'],
];

function classifyFetchError(httpErr: unknown, pwErr: unknown): string {
  const messages = [httpErr, pwErr]
    .filter(Boolean)
    .map((e) => (e instanceof Error ? e.message : String(e)));

  const combined = messages.join(' ');
  if (!combined) return 'Сайт недоступен';

  for (const [pattern, label] of ERROR_PATTERNS) {
    if (pattern.test(combined)) return label;
  }
  return 'Сайт недоступен';
}

/**
 * Build the list of URL variants to try when the primary URL fails to
 * return usable HTML. The pattern mirrors fetchAndExtract (email/text
 * worker): for `https://acme.ru` we try the apex, then `https://www.acme.ru`,
 * then `http://acme.ru`, then `http://www.acme.ru`. Each variant is one
 * cheap extra fetch on the failure path — yields a measurable lift on the
 * ~40% of RU SMB sites that have DNS only on www, or only on plain HTTP.
 */
function buildFetchFallbacks(normalized: string): string[] {
  const variants: string[] = [normalized];
  try {
    const u = new URL(normalized);
    const hasWww = /^www\./i.test(u.hostname);
    const wwwHost = hasWww ? u.hostname.replace(/^www\./i, '') : `www.${u.hostname}`;
    const altHostUrl = `${u.protocol}//${wwwHost}${u.pathname}${u.search}`;
    if (altHostUrl !== normalized) variants.push(altHostUrl);
    if (u.protocol === 'https:') {
      variants.push(`http://${u.hostname}${u.pathname}${u.search}`);
      variants.push(`http://${wwwHost}${u.pathname}${u.search}`);
    }
  } catch {
    /* normalized URL was malformed — just use the original */
  }
  // De-dupe while preserving order.
  return Array.from(new Set(variants));
}

async function fetchMainHtml(
  normalized: string,
  httpTimeout: number,
  signal?: AbortSignal,
): Promise<{ html: string; method: 'http' | 'playwright' } | { error: string }> {
  let html: string | null = null;
  let method: 'http' | 'playwright' = 'http';
  let httpError: unknown = null;
  let pwError: unknown = null;

  // Try each URL variant (apex → www-variant → HTTP-variant) before
  // surrendering to Playwright. Each variant is much cheaper than the
  // Playwright fallback (300ms vs 18s), so we exhaust them first.
  const fallbacks = buildFetchFallbacks(normalized);
  for (const variant of fallbacks) {
    if (signal?.aborted) break;
    try {
      const httpResult = await fetchHtmlWithRetry(variant, {
        timeout: httpTimeout,
        signal,
        allowHttpErrors: false,
      });
      if (httpResult && httpResult.status >= 200 && httpResult.status < 300 && httpResult.html) {
        html = httpResult.html;
        break;
      }
    } catch (err) {
      // Keep the FIRST error we see — that's the primary domain, most
      // informative when everything fails.
      if (httpError === null) httpError = err;
    }
  }

  if (!html && !signal?.aborted) {
    try {
      const pwHtml = await fetchHtmlWithPlaywright(normalized, {
        timeout: PLAYWRIGHT_TIMEOUT_MS,
        signal,
      });
      if (pwHtml && pwHtml.length > 120) {
        html = pwHtml;
        method = 'playwright';
      }
    } catch (err) {
      pwError = err;
    }
  }

  if (!html) return { error: classifyFetchError(httpError, pwError) };
  return { html, method };
}

/**
 * Cheap count of `<img alt="...">` occurrences without parsing the full DOM.
 * Used by enterprise_logos to decide whether we actually had anything to
 * inspect — "no clients + no images" means "we couldn't tell" (undefined),
 * not "no enterprise logos" (false).
 */
function countImgWithAlt(html: string): number {
  if (!html) return 0;
  const matches = html.match(/<img\b[^>]*\balt\s*=\s*["'][^"']{2,}["']/gi);
  return matches ? matches.length : 0;
}

/**
 * Fetch a subpage with a short timeout. Failures are silent — subpage data
 * is always optional, so a single bad subpage must never break the rest.
 */
async function fetchSubpageHtml(
  url: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetchHtmlWithRetry(url, { timeout, signal, allowHttpErrors: false });
    if (res && res.status >= 200 && res.status < 300 && res.html) return res.html;
  } catch {
    /* ignore subpage failures */
  }
  return null;
}

export async function processSignalsForUrl(
  rawUrl: string,
  options?: ProcessSignalsOptions,
): Promise<ProcessSignalsResult> {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return { error: 'Пустой URL' };

  // The "Site" column in exports often carries 2+ URLs in a single cell
  // ("t-paritet.ru, paritet-te.ru", "sportcover.ru, ipksport.ru"). The
  // email path already iterates through every URL it finds; do the same
  // here so a dead first URL doesn't kill the row when a working sibling
  // is right next to it.
  let targets: string[];
  try {
    targets = extractNormalizedUrls(trimmed);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Невалидный URL' };
  }
  if (targets.length === 0) {
    // Fall back to the single-URL parser so the existing error message
    // shape ("Пустой URL" vs "Невалидный URL") is preserved.
    try {
      const fallback = normalizeUrl(trimmed);
      if (!fallback) throw new Error('Невалидный URL');
      targets = [fallback];
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Невалидный URL' };
    }
  }

  const httpTimeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const signal = options?.signal;
  const extractors = options?.extractors ?? DEFAULT_EXTRACTORS;
  const subpageTimeout = options?.subpageTimeout ?? DEFAULT_SUBPAGE_TIMEOUT_MS;

  // Try each candidate URL until one returns usable HTML. Keep the first
  // error message we saw — that's almost always the primary domain and
  // the most informative thing to show the user when the whole row fails.
  let normalized = '';
  let main: Awaited<ReturnType<typeof fetchMainHtml>> | null = null;
  let firstError: string | null = null;

  for (const candidate of targets) {
    if (signal?.aborted) return { error: 'Прервано' };
    const probe = await fetchMainHtml(candidate, httpTimeout, signal);
    if (!('error' in probe)) {
      normalized = candidate;
      main = probe;
      break;
    }
    if (firstError === null) firstError = probe.error;
  }

  if (!main) {
    return { error: firstError ?? 'Сайт недоступен' };
  }

  const out: ExtractedData & { stack: string; profile: string; signalIds: string[]; method: 'http' | 'playwright' } = {
    stack: '',
    profile: '',
    signalIds: [],
    method: main.method,
  };

  // Signature engine runs once on the main page and feeds both the
  // Стек/Профиль columns and the Интеграции column further down.
  const mainSignals = detectSignals(main.html);
  if (extractors.includes('stack') || extractors.includes('profile')) {
    if (extractors.includes('stack')) out.stack = formatStack(mainSignals);
    if (extractors.includes('profile')) out.profile = determineProfile(mainSignals);
    out.signalIds = mainSignals.map((s) => s.id);
  }

  // Determine which subpages we need based on selected extractors.
  const requestedSubpages = new Set<SubpageKind>();
  for (const key of extractors) {
    for (const sp of EXTRACTOR_TO_SUBPAGES[key] ?? []) requestedSubpages.add(sp);
  }

  const subpageHtml: Partial<Record<SubpageKind, string>> = {};
  const subpageUrls: Partial<Record<SubpageKind, string>> = {};

  if (requestedSubpages.size > 0) {
    const discovered = discoverSubpaths(main.html, normalized, Array.from(requestedSubpages));

    // For subpages not found via link discovery, try well-known paths with HEAD probe.
    const missing = Array.from(requestedSubpages).filter((k) => !discovered[k]);
    if (missing.length > 0) {
      let baseOrigin: string;
      try { baseOrigin = new URL(normalized).origin; } catch { baseOrigin = ''; }
      if (baseOrigin) {
        await Promise.all(
          missing.map(async (kind) => {
            const paths = FALLBACK_PATHS[kind] ?? [];
            for (const p of paths) {
              if (signal?.aborted) return;
              try {
                const probeUrl = `${baseOrigin}${p}`;
                const res = await fetch(probeUrl, {
                  method: 'HEAD',
                  redirect: 'follow',
                  signal: signal ?? AbortSignal.timeout(4000),
                });
                if (res.ok) {
                  discovered[kind] = probeUrl;
                  return;
                }
              } catch { /* probe failed, try next */ }
            }
          }),
        );
      }
    }

    await Promise.all(
      Array.from(requestedSubpages).map(async (kind) => {
        const url = discovered[kind];
        if (!url) return;
        subpageUrls[kind] = url;
        const html = await fetchSubpageHtml(url, subpageTimeout, signal);
        if (html) subpageHtml[kind] = html;
      }),
    );
  }

  // Cases-related extractors (share /cases HTML, fallback to main)
  const casesHtml = subpageHtml.cases ?? null;
  if (extractors.includes('customers')) {
    out.customers = extractCustomers(casesHtml ?? '');
    if (out.customers.length === 0) out.customers = extractCustomers(main.html);
    // Trust gate: a thin or junk-heavy heuristic result is dropped so the
    // LLM fallback below produces clean company names instead.
    if (!nameListLooksReal(out.customers)) out.customers = [];
    // Specialized LLM fallback for «Клиенты» (см. llmCustomersExtractor.ts).
    // Триггер: heuristic дал < 3 имён ИЛИ ничего — heuristic покрывает
    // только структурированные logo wall'ы с правильными class-нэймами,
    // а для российского b2b большинство сайтов используют другие классы /
    // вообще без класс-нэймов. LLM получает structured input (alt-атрибуты
    // logo wall'ов + текст разделов под client-headings) и выдаёт чистый
    // список. Поднимает покрытие с ~2% до 80%+ на российском b2b-сегменте
    // (см. промежуточные результаты.txt от 04.06 — повод для этой работы).
    if (out.customers.length < 3) {
      const llmCustomers = await llmExtractCustomers(main.html, casesHtml);
      if (llmCustomers.length > 0) {
        // Merge: keep existing heuristic hits at the front (они уже прошли
        // junk-filter и nameListLooksReal), добавляем уникальные от LLM.
        const merged: string[] = [...out.customers];
        const seen = new Set(out.customers.map((c) => c.toLowerCase()));
        for (const c of llmCustomers) {
          const key = c.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(c);
        }
        // Финальный прогон через filterCustomerCandidates — еще одна линия
        // защиты от мусора (LLM может пропустить «card img», edge-кейсы).
        out.customers = filterCustomerCandidates(merged).slice(0, 30);
      }
    }
  }
  if (extractors.includes('cases_count')) {
    out.cases_count = extractCasesCount(casesHtml ?? '');
    if (out.cases_count === 0 && !casesHtml) out.cases_count = extractCasesCount(main.html);
  }
  if (extractors.includes('case_industries')) {
    out.case_industries = extractCaseIndustries(casesHtml ?? '');
    if (out.case_industries.length === 0) out.case_industries = extractCaseIndustries(main.html);
  }
  if (extractors.includes('enterprise_logos')) {
    const cust = out.customers ?? extractCustomers(casesHtml ?? '');
    const found =
      detectEnterpriseLogos(cust)
      || detectEnterpriseInHtml(casesHtml ?? '')
      || detectEnterpriseInHtml(main.html);
    // Tri-state: true → "Да", false → "Нет", undefined → DASH. A confident
    // "no" requires that we actually had something to check (clients list or
    // logo images on the page). With nothing to inspect we leave it undefined
    // so the cell renders as DASH instead of a misleading "Нет".
    const inspectableCount =
      cust.length
      + countImgWithAlt(casesHtml ?? '')
      + countImgWithAlt(main.html);
    if (found) {
      out.enterprise_logos = true;
    } else if (inspectableCount >= 3) {
      out.enterprise_logos = false;
    }
    // else leave undefined → DASH
  }

  // Pricing-related extractors (share /pricing HTML, fallback to main)
  const pricingHtml = subpageHtml.pricing ?? null;
  if (extractors.includes('pricing_model')) {
    out.pricing_model = extractPricingModel(pricingHtml ?? '');
    if (out.pricing_model === 'unknown' && !pricingHtml) {
      out.pricing_model = extractPricingModel(main.html);
    }
  }
  if (extractors.includes('pricing_min') || extractors.includes('free_trial')) {
    const details = extractPricingDetails(pricingHtml ?? '');
    if (extractors.includes('pricing_min')) out.pricing_min = details.pricing_min;
    // Heuristic only confirms a free trial (true); silence (undefined) means
    // "we didn't see a trial phrase" — LLM gets to weigh in below. We never
    // write false from the heuristic side.
    if (extractors.includes('free_trial') && details.free_trial === true) {
      out.free_trial = true;
    }
    // Fallback to main page if subpage had nothing.
    if (!pricingHtml) {
      const mainDetails = extractPricingDetails(main.html);
      if (extractors.includes('pricing_min') && !out.pricing_min) out.pricing_min = mainDetails.pricing_min;
      if (extractors.includes('free_trial') && out.free_trial !== true && mainDetails.free_trial === true) {
        out.free_trial = true;
      }
    }
  }

  // Careers-related extractors (share /careers HTML, fallback to main,
  // and as a last resort follow an external hh.ru / career.habr link).
  const careersHtml = subpageHtml.careers ?? null;
  if (extractors.includes('vacancies_count') || extractors.includes('hiring_roles')) {
    let hiring = extractHiring(careersHtml ?? '');
    if (hiring.vacancies_count === 0 && !careersHtml) {
      hiring = extractHiring(main.html);
    }

    // External aggregator fallback: when neither the /careers subpage nor the
    // main page yielded vacancies, try the first hh.ru/employer or
    // career.habr.com/companies link we can find. Many B2B сompanies publish
    // hiring only via these aggregators rather than maintaining a /careers page.
    if (hiring.vacancies_count === 0 && !signal?.aborted) {
      const externalLinks = findExternalCareerLinks(main.html);
      for (const url of externalLinks) {
        if (signal?.aborted) break;
        const html = await fetchSubpageHtml(url, subpageTimeout, signal);
        if (!html) continue;
        const externalHiring = extractHiring(html);
        if (externalHiring.vacancies_count > 0) {
          hiring = externalHiring;
          break;
        }
      }
    }

    if (extractors.includes('vacancies_count')) out.vacancies_count = hiring.vacancies_count;
    if (extractors.includes('hiring_roles')) {
      out.hiring_roles = {
        marketing: hiring.has_marketing,
        engineering: hiring.has_engineering,
        sales: hiring.has_sales,
        design: hiring.has_design,
        product: hiring.has_product,
      };
    }
  }

  // Single-extractor subpages (with main page fallback)
  if (extractors.includes('integrations')) {
    // High-confidence: third-party tools detected by their live script/widget
    // footprint (CRM, chat, call-tracking, payments, e-mail, ERP, marketplaces,
    // lead-capture). This is what "интеграции" means for outreach — the services
    // the company actually runs — so signature hits lead the list.
    const fromSignals = integrationsFromSignals(mainSignals);

    // Heuristic: scrape an explicit integrations/partners section for logo
    // alt-text and labels — catches tools we have no signature for (e.g. Slack).
    let heuristic = extractIntegrations(subpageHtml.integrations ?? '');
    if (heuristic.length === 0) heuristic = extractIntegrations(main.html);
    // Trust-gate only the scraped names; signature hits are already trusted.
    if (!nameListLooksReal(heuristic)) heuristic = [];

    // Merge (signatures first), dedup case-insensitively, cap at 20.
    const merged: string[] = [];
    const seenInt = new Set<string>();
    for (const name of [...fromSignals, ...heuristic]) {
      const key = name.toLowerCase();
      if (seenInt.has(key)) continue;
      seenInt.add(key);
      merged.push(name);
    }
    out.integrations = merged.slice(0, 20);
  }
  if (extractors.includes('founded_year')) {
    out.founded_year = subpageHtml.about ? extractFoundedYear(subpageHtml.about) : undefined;
    if (!out.founded_year) out.founded_year = extractFoundedYear(main.html);
  }
  if (extractors.includes('team_size')) {
    out.team_size = subpageHtml.about ? extractTeamSize(subpageHtml.about) : 0;
    if (!out.team_size) out.team_size = extractTeamSize(main.html);
  }
  if (extractors.includes('social_media')) {
    // Соцсети ищем сразу на main+about и мерджим — у b2b-сайтов на главной
    // обычно footer с иконками, на about — текстовые ссылки. Дедуп идёт
    // внутри extractSocialMedia по нормализованному URL.
    const mainSocials = extractSocialMedia(main.html);
    const aboutSocials = subpageHtml.about ? extractSocialMedia(subpageHtml.about) : [];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const url of [...mainSocials, ...aboutSocials]) {
      if (seen.has(url)) continue;
      seen.add(url);
      merged.push(url);
    }
    out.social_media = merged;
  }
  if (extractors.includes('blog_last_post')) {
    // Two-step crawl: from a blog *listing* we locate the latest post link and
    // fetch that page to capture the FULL post text — not just the listing
    // excerpt. Falls back through: listing-as-single-post → listing excerpt →
    // main page → discovered blog/social links.
    const fullPostFromListing = async (
      pageHtml: string,
      pageUrl: string,
    ): Promise<string | undefined> => {
      if (!pageHtml || signal?.aborted) return undefined;
      const postUrl = findLatestPostUrl(pageHtml, pageUrl);
      if (!postUrl || signal?.aborted) return undefined;
      const postHtml = await fetchSubpageHtml(postUrl, subpageTimeout, signal);
      if (!postHtml) return undefined;
      return extractFullPostText(postHtml);
    };

    let post: string | undefined;

    if (subpageHtml.blog && subpageUrls.blog) {
      post = await fullPostFromListing(subpageHtml.blog, subpageUrls.blog);
      if (!post) post = extractFullPostText(subpageHtml.blog);
      if (!post) post = extractBlogLastPost(subpageHtml.blog);
    }

    if (!post) {
      post = await fullPostFromListing(main.html, normalized);
      if (!post) post = extractBlogLastPost(main.html);
    }

    if (!post && !signal?.aborted) {
      const contentUrls = discoverBlogOrSocialUrls(main.html, normalized);
      for (const contentUrl of contentUrls) {
        if (signal?.aborted) break;
        if (subpageUrls.blog && contentUrl === subpageUrls.blog) continue;
        const html = await fetchSubpageHtml(contentUrl, subpageTimeout, signal);
        if (!html) continue;
        post = await fullPostFromListing(html, contentUrl);
        if (!post) post = extractFullPostText(html);
        if (!post) post = extractBlogLastPost(html);
        if (post) break;
      }
    }

    out.blog_last_post = post;
  }

  // ─── Event signals (HoReCa-style) ────────────────────────────────────────
  //
  // Pipeline:
  //   1. Ensure we have a list of social-media URLs (reuse the one we already
  //      computed if social_media was in the extractors set, otherwise compute
  //      it locally without persisting — events need the URLs, the operator
  //      didn't ask for the column).
  //   2. Fetch last ~10 posts from each supported social network in parallel
  //      via extractSocialPosts.
  //   3. Call detectEventSignals with posts + blog_last_post (if available)
  //      + about-page text (if available). It returns the 4 event-signal
  //      booleans + paired summaries.
  //   4. Copy result fields into out{}. detectEventSignals already drops
  //      summaries for false signals, so the cell rendering stays clean.
  //
  // Guard: skip the entire block when no event_* key was requested — the
  // LLM call costs money and must not fire on basic/outreach presets.
  if (anyEventRequested(extractors) && !signal?.aborted) {
    const socialUrlsForEvents =
      out.social_media
      ?? extractSocialMedia([
        main.html,
        subpageHtml.about ?? '',
      ].join('\n'));

    const posts = socialUrlsForEvents.length > 0
      ? await extractSocialPosts(socialUrlsForEvents, {
          timeout: subpageTimeout,
          maxPostsPerNetwork: 10,
          signal,
        })
      : [];

    // Cheap inline tag-strip — eventDetector caps the total context at 12 KB,
    // so we just collapse tags & whitespace and slice. No need for cheerio here.
    // Cheap inline tag-strip — eventDetector caps the total context at 12 KB,
    // so we just collapse tags & whitespace and slice. No need for cheerio here.
    const aboutText = subpageHtml.about
      ? subpageHtml.about
          .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000)
      : undefined;

    const events = await detectEventSignals({
      socialPosts: posts,
      blogText: out.blog_last_post,
      aboutText,
    });

    // Only assign fields the user actually requested — keeps the JSON in
    // result_text minimal and avoids accidentally writing columns the
    // operator didn't enable.
    if (extractors.includes('event_opening')) out.event_opening = events.event_opening;
    if (extractors.includes('event_opening_summary')) out.event_opening_summary = events.event_opening_summary;
    if (extractors.includes('event_redesign')) out.event_redesign = events.event_redesign;
    if (extractors.includes('event_redesign_summary')) out.event_redesign_summary = events.event_redesign_summary;
    if (extractors.includes('event_renovation')) out.event_renovation = events.event_renovation;
    if (extractors.includes('event_renovation_summary')) out.event_renovation_summary = events.event_renovation_summary;
    if (extractors.includes('event_geo')) out.event_geo = events.event_geo;
    if (extractors.includes('event_geo_summary')) out.event_geo_summary = events.event_geo_summary;
  }

  // LLM fallback: for fields that heuristics failed on, ask Sonnet 4.5 via Requesty.
  type LlmField = 'pricing_model' | 'pricing_min' | 'customers' | 'founded_year' | 'team_size' | 'free_trial' | 'case_industries' | 'cases_count' | 'integrations' | 'hiring_roles';
  const llmNeeded = new Set<LlmField>();
  if (extractors.includes('pricing_model') && (out.pricing_model === 'unknown' || !out.pricing_model)) llmNeeded.add('pricing_model');
  if (extractors.includes('pricing_min') && !out.pricing_min) llmNeeded.add('pricing_min');
  // customers вынесены в специализированный llmExtractCustomers выше —
  // там structured input и шире окно контекста, общий extractor не догоняет
  // (см. блок «if (extractors.includes('customers'))»).
  if (extractors.includes('founded_year') && !out.founded_year) llmNeeded.add('founded_year');
  if (extractors.includes('team_size') && !out.team_size) llmNeeded.add('team_size');
  // free_trial: ask the LLM whenever the heuristic didn't confirm (undefined).
  // It may return true OR false; we accept both so the user sees "Нет" instead
  // of the misleading DASH when the LLM is confident there's no trial.
  if (extractors.includes('free_trial') && out.free_trial === undefined) llmNeeded.add('free_trial');
  if (extractors.includes('case_industries') && (!out.case_industries || out.case_industries.length === 0)) llmNeeded.add('case_industries');
  if (extractors.includes('cases_count') && !out.cases_count) llmNeeded.add('cases_count');
  if (extractors.includes('integrations') && (!out.integrations || out.integrations.length === 0)) llmNeeded.add('integrations');
  if (extractors.includes('hiring_roles') && out.hiring_roles && !out.hiring_roles.marketing && !out.hiring_roles.engineering && !out.hiring_roles.sales && !out.hiring_roles.design && !out.hiring_roles.product) llmNeeded.add('hiring_roles');

  if (llmNeeded.size > 0 && !signal?.aborted) {
    try {
      const llmResult = await llmExtractFields(main.html, subpageHtml, llmNeeded);
      if (llmResult.pricing_model && llmNeeded.has('pricing_model')) out.pricing_model = llmResult.pricing_model;
      if (llmResult.pricing_min && llmNeeded.has('pricing_min')) out.pricing_min = llmResult.pricing_min;
      if (llmResult.customers && llmResult.customers.length > 0 && llmNeeded.has('customers')) out.customers = llmResult.customers;
      if (llmResult.founded_year && llmNeeded.has('founded_year')) out.founded_year = llmResult.founded_year;
      if (llmResult.team_size && llmNeeded.has('team_size')) out.team_size = llmResult.team_size;
      // Tri-state merge: heuristic only sets true. Now accept either side of
      // the LLM's verdict so "Нет" (confident no) lands in the cell when the
      // model spotted a Contact-Sales-only page. Heuristic-true is preserved
      // (we don't downgrade Да → Нет just because LLM disagrees).
      if (llmNeeded.has('free_trial') && out.free_trial !== true) {
        if (llmResult.free_trial === true) out.free_trial = true;
        else if (llmResult.free_trial === false) out.free_trial = false;
      }
      if (llmResult.case_industries && llmResult.case_industries.length > 0 && llmNeeded.has('case_industries')) out.case_industries = llmResult.case_industries;
      if (typeof llmResult.cases_count === 'number' && llmResult.cases_count > 0 && llmNeeded.has('cases_count')) out.cases_count = llmResult.cases_count;
      if (llmResult.integrations && llmResult.integrations.length > 0 && llmNeeded.has('integrations')) out.integrations = llmResult.integrations;
      if (llmResult.hiring_roles && llmNeeded.has('hiring_roles')) out.hiring_roles = llmResult.hiring_roles;
    } catch {
      // LLM fallback is best-effort — never break the pipeline.
    }
  }

  return out;
}
