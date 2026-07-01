import { fetchHtmlWithRetry, fetchHtmlWithPlaywright } from '@/lib/enrich/websiteParser';
import { logInfo } from '@/lib/loggerServer';
import { normalizeUrl, extractNormalizedUrls } from '@/lib/enrich/urlUtils';
import { detectSignals, determineProfile, formatStack, integrationsFromSignals } from '@/lib/enrich/signalDetector';
import {
  ANALYTICS_SERVICES,
  ANALYTICS_SERVICE_KEYS,
  detectAnalyticsServices,
} from '@/lib/enrich/analyticsServicesDetector';
import { discoverSubpaths, FALLBACK_PATHS } from '@/lib/enrich/subpathDiscovery';
import {
  ExtractorKey,
  ExtractedData,
  EXTRACTOR_TO_SUBPAGES,
  SubpageKind,
} from '@/lib/enrich/extractors/types';
import { extractCustomers } from '@/lib/enrich/extractors/customersExtractor';
import { nameListLooksReal } from '@/lib/enrich/extractors/nameQuality';
import { extractCasesCount } from '@/lib/enrich/extractors/casesCountExtractor';
import { extractCaseIndustries } from '@/lib/enrich/extractors/caseIndustriesExtractor';
import { detectEnterpriseLogos, detectEnterpriseInHtml } from '@/lib/enrich/extractors/enterpriseLogosDetector';
import { extractPricingModel } from '@/lib/enrich/extractors/pricingModelExtractor';
import { extractPricingDetails } from '@/lib/enrich/extractors/pricingDetailExtractor';
import { extractHiring, findExternalCareerLinks } from '@/lib/enrich/extractors/hiringExtractor';
import { extractIntegrations } from '@/lib/enrich/extractors/integrationsExtractor';
import { extractFoundedYear } from '@/lib/enrich/extractors/foundedYearExtractor';
import { extractTeamSize } from '@/lib/enrich/extractors/teamSizeExtractor';
import { extractSocialMedia, filterSocialUrls } from '@/lib/enrich/extractors/socialMediaExtractor';
import { findCompanySocials } from '@/lib/enrich/extractors/socialCompanyFinder';
import { deriveCompanyName } from '@/lib/enrich/extractors/deriveCompanyName';
import { extractSocialPosts } from '@/lib/enrich/extractors/socialPostsExtractor';
import { pickLatestNews } from '@/lib/enrich/extractors/socialLatestNewsDetector';
import {
  discoverBlogOrSocialUrls,
  extractBlogLastPost,
  extractFullPostText,
  findLatestPostUrl,
} from '@/lib/enrich/extractors/blogActivityExtractor';
import { llmExtractFields, LlmFields } from '@/lib/enrich/extractors/llmExtractor';

// Convenience predicate — any of the 4 event-signal pairs requested. Used to
// gate the LLM social-latest-news detector (it costs ~$0.003/URL and must
// not run for presets that didn't enable the social_latest_news column).
function socialLatestNewsRequested(extractors: ExtractorKey[]): boolean {
  return extractors.includes('social_latest_news');
}

// Глубокий добор соцсетей (рендер браузером + поиск через Serper) дорогой —
// читаем флаг на каждом вызове, чтобы прод/тесты могли включить «быстрый
// режим» SIGNALS_SOCIAL_DEEP=0.
function socialDeepEnabled(): boolean {
  return (process.env.SIGNALS_SOCIAL_DEEP ?? '1') !== '0';
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

  // ── Сервисы сквозной аналитики / коллтрекинга (matrix-пресет) ──
  // Детект по уже скачанной главной (тот же HTML, что для «Стека»), отдельными
  // домен-якорными regex'ами (analyticsServicesDetector). Каждый запрошенный
  // сервис → 'да'/'' в своей колонке + сводная «Обнаружено сервисов». Запускаем
  // только если выбран хоть один ключ фичи — иначе колонок не будет.
  if (extractors.some((k) => ANALYTICS_SERVICE_KEYS.has(k))) {
    const detected = detectAnalyticsServices(main.html);
    const detectedIds = new Set(detected.map((d) => d.id));
    const outRec = out as unknown as Record<string, unknown>;
    for (const svc of ANALYTICS_SERVICES) {
      if (extractors.includes(svc.key)) {
        outRec[svc.key] = detectedIds.has(svc.id) ? 'да' : '';
      }
    }
    if (extractors.includes('analytics_services')) {
      out.analytics_services = detected.map((d) => d.label).join(', ');
    }
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
  // «Клиенты» = сегмент ЦА (кого обслуживает компания), не список брендов.
  // Эвристики нет — поле целиком на LLM. Ставим пустую строку как дефолт;
  // консолидированный LLM-вызов в конце наполнит его (если сможет).
  if (extractors.includes('client_segment')) {
    out.client_segment = '';
  }
  if (extractors.includes('cases_count')) {
    // Точный счёт по карточкам/числу — бесплатно. Если 0, кейсы всё же могут
    // быть в нестандартной вёрстке → консолидированный LLM-вызов в конце даёт
    // число или оценку «N+». Так ячейка не пустеет при наличии кейсов.
    let casesCount: number | string = extractCasesCount(casesHtml ?? '');
    if (casesCount === 0 && !casesHtml) casesCount = extractCasesCount(main.html);
    out.cases_count = casesCount;
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

    // Эвристика записана; пробелы (вакансии/профессии из нестандартной вёрстки,
    // напр. moslift.ru/jobs/) добирает консолидированный LLM-вызов в конце.
    if (extractors.includes('vacancies_count')) out.vacancies_count = hiring.vacancies_count;
    if (extractors.includes('hiring_roles')) out.hiring_roles = hiring.professions;
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
    // Пустой merge (нет ни следов скриптов, ни распознанной секции) добирает
    // консолидированный LLM-вызов в конце.
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
  // ── Соцсети (общий результат для колонки «Соцсети» и для событий) ──────────
  // static (main+about) → если пусто и включён deep: рендер браузером → если
  // всё ещё пусто: поиск офиц. канала через Serper. Все источники проходят один
  // фильтр (боты/личные/чужие/потолки) в filterSocialUrls.
  const needSocial = extractors.includes('social_media') || socialLatestNewsRequested(extractors);
  let socialUrls: string[] = [];
  if (needSocial) {
    socialUrls = filterSocialUrls([
      ...extractSocialMedia(main.html),
      ...(subpageHtml.about ? extractSocialMedia(subpageHtml.about) : []),
    ]);
    if (socialUrls.length === 0 && socialDeepEnabled() && !signal?.aborted) {
      if (main.method === 'http') {
        try {
          const rendered = await fetchHtmlWithPlaywright(normalized, {
            timeout: PLAYWRIGHT_TIMEOUT_MS,
            signal,
          });
          if (rendered) socialUrls = extractSocialMedia(rendered);
        } catch {
          // Playwright-рендер — best-effort добор соцсетей: сбой настройки
          // браузера не должен ронять строку, просто идём дальше (Serper).
        }
      }
      if (socialUrls.length === 0 && !signal?.aborted) {
        let host = '';
        try { host = new URL(normalized).hostname; } catch { /* ignore */ }
        socialUrls = await findCompanySocials(deriveCompanyName(main.html, normalized), host, { signal });
      }
    }
    if (extractors.includes('social_media')) out.social_media = socialUrls;
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

  // ─── social_latest_news: LLM picks 1 best post out of ~10 recent ────────
  //
  // Pipeline:
  //   1. socialUrls уже вычислен выше (static → render → Serper).
  //   2. Тянем последние ~10 постов с каждой поддерживаемой сети параллельно
  //      через extractSocialPosts.
  //   3. pickLatestNews отдаёт LLM этот массив, получает {index, reason}
  //      и формирует готовую ячейку "YYYY-MM-DD [url] — text...".
  //
  // Guard: пропускаем весь блок если social_latest_news не запрошен —
  // LLM-вызов стоит денег и не должен срабатывать на basic/outreach пресетах.
  if (socialLatestNewsRequested(extractors) && !signal?.aborted) {
    const posts = socialUrls.length > 0
      ? await extractSocialPosts(socialUrls, {
          timeout: subpageTimeout,
          maxPostsPerNetwork: 10,
          signal,
        })
      : [];

    // Bridge-лог: видим, дошли ли мы от «нашли соцсети» до «есть из чего
    // выбирать пост». 0 URL → ячейка заведомо DASH; URL есть, но posts=0 —
    // fetch'и упали (приватный канал, JS-only, бан, таймаут).
    await logInfo('social_news.pipeline.input', 'Latest news: входные данные', {
      url: normalized,
      social_urls_found: socialUrls.length,
      social_urls_sample: socialUrls.slice(0, 5),
      posts_fetched: posts.length,
      posts_by_network: posts.reduce<Record<string, number>>((acc, p) => {
        acc[p.network] = (acc[p.network] ?? 0) + 1;
        return acc;
      }, {}),
    });

    const news = await pickLatestNews({ socialPosts: posts, url: normalized });
    if (extractors.includes('social_latest_news')) out.social_latest_news = news.social_latest_news;
  }

  // ─── Консолидированный LLM-добор по ВСЕМ «сайтовым» полям, что не закрыли
  // эвристики. ОДИН запрос вместо 5-6 отдельных: сайт уже распарсен и нужные
  // подстраницы скачаны — повторно тот же HTML в модель не шлём. Соцсети
  // (social_latest_news) идут отдельно — у них другой вход (посты, не сайт).
  const llmNeeded = new Set<keyof LlmFields>();
  if (extractors.includes('client_segment')) llmNeeded.add('client_segment');
  if (extractors.includes('cases_count') && out.cases_count === 0) llmNeeded.add('cases_count');
  if (extractors.includes('case_industries') && (!out.case_industries || out.case_industries.length === 0)) llmNeeded.add('case_industries');
  if (extractors.includes('pricing_model') && (out.pricing_model === 'unknown' || !out.pricing_model)) llmNeeded.add('pricing_model');
  if (extractors.includes('pricing_min') && !out.pricing_min) llmNeeded.add('pricing_min');
  if (extractors.includes('free_trial') && out.free_trial === undefined) llmNeeded.add('free_trial');
  if (extractors.includes('vacancies_count') && (out.vacancies_count === undefined || out.vacancies_count === 0)) llmNeeded.add('vacancies_count');
  if (extractors.includes('hiring_roles') && (!out.hiring_roles || (Array.isArray(out.hiring_roles) && out.hiring_roles.length === 0))) llmNeeded.add('hiring_roles');
  if (extractors.includes('integrations') && (!out.integrations || out.integrations.length === 0)) llmNeeded.add('integrations');
  if (extractors.includes('founded_year') && !out.founded_year) llmNeeded.add('founded_year');
  if (extractors.includes('team_size') && !out.team_size) llmNeeded.add('team_size');

  if (llmNeeded.size > 0 && !signal?.aborted) {
    // Шлём только подстраницы, релевантные недостающим полям — минимизируем
    // токены (главная всегда + нужные subpages, уже скачанные выше).
    const wantKinds = new Set<SubpageKind>();
    if (llmNeeded.has('pricing_model') || llmNeeded.has('pricing_min') || llmNeeded.has('free_trial')) wantKinds.add('pricing');
    if (llmNeeded.has('vacancies_count') || llmNeeded.has('hiring_roles')) wantKinds.add('careers');
    if (llmNeeded.has('cases_count') || llmNeeded.has('case_industries') || llmNeeded.has('client_segment')) wantKinds.add('cases');
    if (llmNeeded.has('client_segment') || llmNeeded.has('founded_year') || llmNeeded.has('team_size')) wantKinds.add('about');
    if (llmNeeded.has('integrations')) wantKinds.add('integrations');
    const relevantSubpages: Partial<Record<SubpageKind, string>> = {};
    for (const kind of wantKinds) {
      const html = subpageHtml[kind];
      if (html) relevantSubpages[kind] = html;
    }

    try {
      const llm = await llmExtractFields(main.html, relevantSubpages, llmNeeded, { url: normalized });
      if (llmNeeded.has('client_segment') && typeof llm.client_segment === 'string') out.client_segment = llm.client_segment;
      if (llmNeeded.has('cases_count') && llm.cases_count !== undefined) out.cases_count = llm.cases_count;
      if (llmNeeded.has('case_industries') && llm.case_industries && llm.case_industries.length > 0) out.case_industries = llm.case_industries;
      if (llmNeeded.has('pricing_model') && llm.pricing_model) out.pricing_model = llm.pricing_model;
      if (llmNeeded.has('pricing_min') && llm.pricing_min) out.pricing_min = llm.pricing_min;
      // free_trial: принимаем true И false, чтобы «Нет» попадал в ячейку.
      if (llmNeeded.has('free_trial') && llm.free_trial !== undefined) out.free_trial = llm.free_trial;
      if (llmNeeded.has('vacancies_count') && llm.vacancies_count !== undefined) out.vacancies_count = llm.vacancies_count;
      if (llmNeeded.has('hiring_roles') && Array.isArray(llm.hiring_roles) && llm.hiring_roles.length > 0) out.hiring_roles = llm.hiring_roles;
      if (llmNeeded.has('integrations') && llm.integrations && llm.integrations.length > 0) out.integrations = llm.integrations;
      if (llmNeeded.has('founded_year') && llm.founded_year) out.founded_year = llm.founded_year;
      if (llmNeeded.has('team_size') && llm.team_size) out.team_size = llm.team_size;
    } catch {
      // LLM-добор best-effort — никогда не роняем пайплайн.
    }
  }

  return out;
}
