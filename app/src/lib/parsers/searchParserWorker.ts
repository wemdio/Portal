
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo, logWarn } from '@/lib/loggerServer';
import { startTrace } from '@/lib/tracer';
import { buildSearchDiagnostics } from '@/lib/parsers/searchParserDiagnostics';
import { simplifySearchQuery } from '@/lib/parsers/searchQueryUtils';
import { fetchWebsiteEmails } from '@/lib/enrich/websiteParser';
import type { SearchResultItem } from './searchScraper';
import {
  bingSearchDetailed,
  duckDuckGoSearchDetailed,
  googleSearchDetailed,
  isBingBlockedError,
  isDuckDuckGoBlockedError,
  isGoogleBlockedError,
  isMojeekBlockedError,
  mojeekSearchDetailed,
} from './searchScraper';
import { extractCompanySitesFromSource } from './sourceCompanyExtractor';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Max-yield defaults: prioritize collecting *more unique sites* with fewer blocks.
// Email enrichment can become the bottleneck; keep it lightweight so lead collection keeps moving.
const ENRICH_EMAIL_ENABLED = true;
const ENRICH_EMAIL_MAX_SITES_PER_JOB = 500;
const ENRICH_EMAIL_MAX_PAGES_PER_SITE = 3;
const ENRICH_EMAIL_CONCURRENCY = 2;

const SOURCE_EXPAND_ENABLED = true;
const SOURCE_EXPAND_MAX_SOURCES_PER_QUERY = 10;
const SOURCE_EXPAND_MAX_SOURCES_PER_JOB = 250;
const SOURCE_EXPAND_MAX_SITES_PER_SOURCE = 250;
const SOURCE_EXPAND_CONCURRENCY = 3;

// Lower concurrency -> fewer blocks -> more total sites, given enough time.
const QUERY_CONCURRENCY = 1;

const GOOGLE_RESULTS_PER_QUERY = 100;
const BING_MAX_PAGES = 8;
const BING_MAX_RESULTS = 200;
const MULTI_PROVIDER_ENABLED = true;
const MAX_UNIQUE_SITES_PER_QUERY = 500;

function randInt(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

async function insertInBatches<T extends Record<string, unknown>>(
  admin: NonNullable<typeof supabaseAdmin>,
  rows: T[],
  opts?: { batchSize?: number },
): Promise<{ inserted: number; hadFailures: boolean; firstErrorMessage: string | null }> {
  const batchSize = Math.max(1, Math.min(250, Math.floor(opts?.batchSize ?? 60)));
  let inserted = 0;
  let hadFailures = false;
  let firstErrorMessage: string | null = null;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await admin.from('search_results').insert(batch);
    if (error) {
      hadFailures = true;
      firstErrorMessage ??= error.message;
      // Also log to stdout to make local debugging obvious.
      console.error('search_results insert batch failed:', error.message);
      continue;
    }
    inserted += batch.length;
  }

  return { inserted, hadFailures, firstErrorMessage };
}

async function throttleBetweenQueries(provider: 'google' | 'duckduckgo' | 'bing' | 'mojeek') {
  // Aim for stability over speed; jitter helps avoid anti-bot thresholds.
  // Google already has internal delay in googleSearchDetailed; DDG does not.
  const base =
    provider === 'duckduckgo'
      ? randInt(1800, 4200)
      : provider === 'bing'
        ? randInt(1200, 2800)
        : provider === 'mojeek'
          ? randInt(900, 2200)
          : randInt(900, 2200);
  await sleep(base);
}

function createAsyncLock() {
  let chain = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release: () => void = () => {};
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function createRateLimiter() {
  const withLock = createAsyncLock();
  let nextAllowedAt = 0;
  return async function scheduleDelay(getDelayMs: () => number) {
    await withLock(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextAllowedAt - now);
      // Reserve the next slot first, so concurrent waiters don't bunch up.
      nextAllowedAt = Math.max(nextAllowedAt, now) + Math.max(0, getDelayMs());
      if (waitMs > 0) await sleep(waitMs);
    });
  };
}

function normalizeSite(link: string): string | null {
  try {
    const url = new URL(link);
    // store as canonical "site" (origin only, force https)
    return `https://${url.hostname.replace(/^www\./i, '')}/`;
  } catch {
    return null;
  }
}

function deriveCompanyNameFromSite(site: string): string | null {
  try {
    const host = site
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .split('/')[0]
      .replace(/^www\./i, '');
    if (!host) return null;
    const base = host.split('.')[0] || host;
    const pretty = base
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!pretty) return null;
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  } catch {
    return null;
  }
}

function scoreCompanyName(value: string | null | undefined): number {
  const s = (value ?? '').trim();
  if (!s) return -100;
  let score = 0;
  if (s.length >= 2 && s.length <= 80) score += 5;
  else if (s.length <= 140) score += 2;
  else score -= 2;
  if (/\b(ООО|ЗАО|ОАО|ПАО|АО|ИП)\b/i.test(s)) score += 4;
  if (/^\d/.test(s)) score -= 6;
  if (/(рейтинг|топ|лучши|обзор|каталог|список|реестр|ваканс|новост|блог|статья)/i.test(s)) score -= 6;
  if (/https?:\/\//i.test(s)) score -= 4;
  if (/\w+\.\w+/.test(s)) score -= 2;
  if (/[|]/.test(s)) score -= 1;
  return score;
}

function pickBetterCompanyName(prev: string | null, next: string | null): string | null {
  const a = (prev ?? '').trim() || null;
  const b = (next ?? '').trim() || null;
  if (!a) return b;
  if (!b) return a;
  const sa = scoreCompanyName(a);
  const sb = scoreCompanyName(b);
  if (sb !== sa) return sb > sa ? b : a;
  // Tie-breaker: prefer shorter (company names shouldn't be essays)
  return b.length < a.length ? b : a;
}

function deriveCompanyName(title: string | undefined | null, site: string): string | null {
  const raw = (title ?? '').trim();
  const fallback = site
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split('/')[0]
    .replace(/^www\./i, '');

  const base = (() => {
    if (!raw) return '';
    const cleaned = raw.replace(/[“”«»]/g, '"');

    // Most common Russian SEO title pattern: "Описание | НазваниеКомпании"
    // Company brand is typically the LAST segment after ' | '
    const pipeParts = cleaned.split(' | ').map((s) => s.trim()).filter((s) => s.length >= 2);
    if (pipeParts.length >= 2) {
      const last = pipeParts[pipeParts.length - 1];
      // Company names are typically short; use last segment if it fits
      if (last.length <= 80) return last;
      // If last is long, prefer any segment with a legal entity marker
      const withEntity = pipeParts.find((p) => /\b(ООО|ЗАО|ОАО|ПАО|ИП|АО)\b/i.test(p));
      if (withEntity) return withEntity;
      // Fall back to first segment
      return pipeParts[0];
    }

    // No '|' — try em/en-dash: "НазваниеКомпании — описание"
    // Company name is typically BEFORE the dash
    const dashParts = cleaned.split(/\s+[—–]\s+/).map((s) => s.trim()).filter((s) => s.length >= 2);
    if (dashParts.length >= 2) {
      return dashParts[0];
    }

    return cleaned.trim();
  })();

  const candidateFromTitle = base.trim();
  const isSuspiciousTitle =
    raw.length > 80 ||
    /^\d+\b/.test(raw) ||
    /(рейтинг|топ|лучши|обзор|каталог|список|реестр|ваканс|новост|блог|статья)/i.test(raw);

  const candidate = ((candidateFromTitle && !isSuspiciousTitle ? candidateFromTitle : '') || fallback).trim();
  if (candidate.length < 2) return null;
  // avoid returning just a TLD-like token
  if (/^\w+\.\w+$/.test(candidate) && candidate.toLowerCase() === fallback.toLowerCase()) {
    const parts = fallback.split('.');
    const name = parts[0] || fallback;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return candidate.slice(0, 160);
}

function isLeadCandidateSite(site: string): boolean {
  const host = site
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  // We accept almost any source domain for leads.
  // Only exclude obvious search engine / redirect hosts that are never "companies".
  const blocked = [
    'duckduckgo.com',
    'google.com',
    'googleusercontent.com',
    'gstatic.com',
    'yandex.ru',
    'yandex.com',
    'ya.ru',
    'bing.com',
  ];
  return !blocked.some((b) => host === b || host.endsWith(`.${b}`));
}

function isEnrichableCompanySite(site: string): boolean {
  const host = site
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  // Skip obvious directories/content sources for email crawling.
  const blockedForEnrich = [
    'duckduckgo.com',
    'google.com',
    'yandex.ru',
    'yandex.com',
    'ya.ru',
    'bing.com',
    'wikipedia.org',
    'youtube.com',
    't.me',
    'vk.com',
    'ok.ru',
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'rbc.ru',
    'cnews.ru',
    'vc.ru',
    'habr.com',
    'tadviser.ru',
    'cyberleninka.ru',
  ];
  return !blockedForEnrich.some((b) => host === b || host.endsWith(`.${b}`));
}

function isLikelySourceSite(site: string): boolean {
  const host = site
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!host) return false;
  const knownSources = [
    // directories/registries
    'gisp.gov.ru',
    'energybase.ru',
    // events/directories
    '10times.com',
    'expocentr.ru',
    // procurement
    'zakupki.gov.ru',
    'zakupki.kontur.ru',
    'rostender.info',
    'synapsenet.ru',
    'bicotender.ru',
    // jobs
    'hh.ru',
    'rabota.ru',
    'gorodrabot.ru',
    'dreamjob.ru',
  ];
  if (knownSources.some((b) => host === b || host.endsWith(`.${b}`))) return true;
  if (/(zakup|tender|torgi|vacanc|rabota|career|job|work|expo|catalog|directory|reest|reestr|spravochnik)/i.test(host)) {
    return true;
  }
  return false;
}

function toLeadRow(
  r: SearchResultItem,
  jobId: string,
  provider: string,
): {
  job_id: string;
  query: string;
  title: string;
  link: string;
  snippet: string;
  position: number;
  company_name: string;
  site: string;
  description: string | null;
  email: string | null;
  provider: string;
} | null {
  const site = normalizeSite(r.link);
  if (!site) return null;
  if (!isLeadCandidateSite(site)) return null;
  const companyName = deriveCompanyName(r.title, site) ?? deriveCompanyNameFromSite(site) ?? site;

  return {
    job_id: jobId,
    query: r.query,
    title: r.title,
    link: r.link,
    snippet: r.snippet,
    position: r.position,
    company_name: companyName,
    site,
    description: r.snippet?.trim() ? r.snippet.trim().slice(0, 500) : null,
    email: null,
    provider,
  };
}

export async function runSearchParserJob(jobId: string) {
  if (!supabaseAdmin) {
    console.error('supabaseAdmin not configured');
    return;
  }
  const admin = supabaseAdmin;

  try {
    // 1. Fetch job
    const { data: job, error } = await admin
      .from('search_parser_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !job) {
      console.error('Job not found:', jobId);
      return;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return;
    }

    const requestId = crypto.randomUUID();
    const logMeta = { userId: job.user_id, requestId, route: 'search_parser_worker' };

    // 2. Set running
    await admin
      .from('search_parser_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', jobId);

    const queries = (job.config as { queries?: string[] })?.queries || [];

    let totalResults = 0;
    let processedQueries = 0;
    // NOTE: we prefer completing with a warning over failing the whole job
    // when search engines temporarily rate-limit or challenge the scraper.
    let hadFailures = false;
    const seenSites = new Set<string>();
    let enrichedSites = 0;
    let expandedSources = 0;
    let ddgBlockedStreak = 0;
    let ddgBlockedCount = 0;
    let lastBlockedHint: string | null = null;
    let cancelled = false;
    const withLock = createAsyncLock();
    const scheduleGoogle = createRateLimiter();
    const scheduleDdg = createRateLimiter();
    const scheduleBing = createRateLimiter();
    const scheduleMojeek = createRateLimiter();

    void logInfo(
      'parser.search.job.start',
      'Search parser job started',
      { jobId, totalQueries: queries.length, queries: queries.slice(0, 10) },
      logMeta,
    );

    const trace = await startTrace({
      name: 'search.execute',
      input: {
        jobId,
        queries,
        totalQueries: queries.length,
        userId: job.user_id,
        requestId,
        route: 'search_parser_worker',
      },
      message: `Парсинг поиска: ${queries[0] ?? 'без запросов'}`,
      userId: job.user_id,
      searchJobId: jobId,
    });

    // Once Google blocks (enablejs/captcha/consent), stop trying it for this job to avoid log spam and wasted latency.
    let googleBlockedForJob = false;

    // 3. Process queries (parallel workers: 2-3 by default)
    await mapWithConcurrency(queries, QUERY_CONCURRENCY, async (query, index) => {
      if (cancelled) return;

      // Check for cancellation (best-effort)
      const { data: currentJob } = await admin
        .from('search_parser_jobs')
        .select('status')
        .eq('id', jobId)
        .single();
      if (currentJob?.status === 'failed') {
        cancelled = true;
        return;
      }

      const querySpan = await trace?.startChild({
        name: 'search.query',
        input: { query, index: index + 1, total: queries.length },
        message: `Запрос: ${query}`,
      });

      let insertedCount = 0;
      let hadQueryFailures = false;

      try {
        const runGoogle = async (q: string) => {
          // Google has internal delays, but we still gate globally to avoid bursts
          // when query concurrency > 1.
          await scheduleGoogle(() => randInt(1400, 3200));
          return await googleSearchDetailed(q, GOOGLE_RESULTS_PER_QUERY);
        };

        const runDdg = async (q: string) => {
          // DDG blocks aggressively on bursty traffic; gate and scale delays
          // based on recent blocking streak to improve stability.
          const streak = Math.min(ddgBlockedStreak, 4);
          const mult = streak <= 0 ? 1 : 2 ** streak;
          await scheduleDdg(() => randInt(5200, 9800) * mult + randInt(0, 1600));
          return await duckDuckGoSearchDetailed(q);
        };

        const runBing = async (q: string) => {
          await scheduleBing(() => randInt(2800, 6200));
          return await bingSearchDetailed(q, { maxPages: BING_MAX_PAGES, pageSize: 10, maxResults: BING_MAX_RESULTS });
        };

        const runMojeek = async (q: string) => {
          await scheduleMojeek(() => randInt(1800, 4500));
          return await mojeekSearchDetailed(q);
        };

        let results: Array<(SearchResultItem & { _provider: 'google' | 'duckduckgo' | 'bing' | 'mojeek' })> = [];
        let debugPrimary: unknown = null;
        let usedFallback = false;
        let debugFallback: unknown = null;
        let googleUrlFallback: string | null = null;
        let provider: 'google' | 'duckduckgo' | 'bing' | 'mojeek' = 'google';
        const simplifiedQuery = simplifySearchQuery(query);

        const tryProviders = async (q: string) => {
          const order: Array<'google' | 'duckduckgo' | 'bing' | 'mojeek'> = googleBlockedForJob
            ? ['duckduckgo', 'bing', 'mojeek']
            : ['google', 'duckduckgo', 'bing', 'mojeek'];

          let lastErr: unknown = null;
          for (const p of order) {
            try {
              if (p === 'google') {
                const out = await runGoogle(q);
                return { provider: p, out };
              }
              if (p === 'duckduckgo') {
                const out = await runDdg(q);
                return { provider: p, out };
              }
              if (p === 'bing') {
                const out = await runBing(q);
                return { provider: p, out };
              }
              const out = await runMojeek(q);
              return { provider: p, out };
            } catch (e) {
              lastErr = e;
              if (isGoogleBlockedError(e)) {
                googleBlockedForJob = true;
                lastBlockedHint = e.message;
                // keep trying other providers
                continue;
              }
              if (isDuckDuckGoBlockedError(e) || isBingBlockedError(e) || isMojeekBlockedError(e)) {
                lastBlockedHint = e instanceof Error ? e.message : String(e);
                continue;
              }
              throw e;
            }
          }
          throw lastErr ?? new Error('All search providers failed');
        };

        const collectProviders = async (q: string) => {
          const order: Array<'google' | 'duckduckgo' | 'bing' | 'mojeek'> = googleBlockedForJob
            ? ['duckduckgo', 'bing', 'mojeek']
            : ['google', 'duckduckgo', 'bing', 'mojeek'];

          const combined: Array<(SearchResultItem & { _provider: 'google' | 'duckduckgo' | 'bing' | 'mojeek' })> = [];
          const seen = new Set<string>();
          const debug: Record<string, unknown> = {};

          for (const p of order) {
            try {
              const out =
                p === 'google'
                  ? await runGoogle(q)
                  : p === 'duckduckgo'
                    ? await runDdg(q)
                    : p === 'bing'
                      ? await runBing(q)
                      : await runMojeek(q);
              debug[p] = out.debug;
              for (const item of out.results) {
                const site = normalizeSite(item.link);
                if (!site) continue;
                if (!isLeadCandidateSite(site)) continue;
                const key = site.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                combined.push({ ...item, _provider: p });
                if (seen.size >= MAX_UNIQUE_SITES_PER_QUERY) break;
              }
              if (seen.size >= MAX_UNIQUE_SITES_PER_QUERY) break;
            } catch (e) {
              debug[p] = { error: e instanceof Error ? { name: e.name, message: e.message } : String(e) };
              if (isGoogleBlockedError(e)) {
                googleBlockedForJob = true;
                lastBlockedHint = e.message;
                continue;
              }
              if (isDuckDuckGoBlockedError(e) || isBingBlockedError(e) || isMojeekBlockedError(e)) {
                lastBlockedHint = e instanceof Error ? e.message : String(e);
                continue;
              }
              // Non-blocking unexpected errors: keep going to other providers
              continue;
            }
          }
          return { results: combined, debug };
        };

        try {
          if (MULTI_PROVIDER_ENABLED) {
            const out = await collectProviders(query);
            results = out.results;
            debugPrimary = out.debug;
            provider = 'google'; // kept for legacy trace fields; per-row provider is stored separately
          } else {
            const primary = await tryProviders(query);
            provider = primary.provider;
            results = primary.out.results.map((r) => ({ ...r, _provider: primary.provider }));
            debugPrimary = primary.out.debug;
          }
        } catch (e) {
          // If everything failed, bubble up. The catch below will handle cooldowns/hints.
          throw e;
        }

        // If provider returns 0, try the next providers (stability > speed).
        if (results.length === 0) {
          try {
            usedFallback = true;
            debugFallback = debugPrimary;
            if (MULTI_PROVIDER_ENABLED) {
              const out = await collectProviders(query);
              results = out.results;
              debugPrimary = out.debug;
            } else {
              const fallback = await tryProviders(query);
              provider = fallback.provider;
              results = fallback.out.results.map((r) => ({ ...r, _provider: fallback.provider }));
              debugPrimary = fallback.out.debug;
            }
          } catch (e) {
            debugFallback = { error: e instanceof Error ? { name: e.name, message: e.message } : String(e) };
          }
        }

        if (results.length === 0) {
          const simplified = simplifiedQuery;
          if (simplified && simplified !== query) {
            usedFallback = true;
            try {
              if (MULTI_PROVIDER_ENABLED) {
                const out = await collectProviders(simplified);
                results = out.results.map((r) => ({ ...r, query }));
                debugFallback = out.debug;
              } else {
                const fallback = await tryProviders(simplified);
                provider = fallback.provider;
                results = fallback.out.results.map((r) => ({ ...r, _provider: fallback.provider }));
                debugFallback = fallback.out.debug;
                if (fallback.provider === 'google' && fallback.out?.debug && typeof fallback.out.debug === 'object') {
                  googleUrlFallback = (fallback.out.debug as { request_url?: string }).request_url ?? null;
                }
                if (results.length > 0) {
                  results = results.map((item) => ({ ...item, query }));
                }
              }
            } catch (e) {
              debugFallback = { error: e instanceof Error ? { name: e.name, message: e.message } : String(e) };
            }
          }
        }

        // Build rows (local dedupe only)
        const rows = results
          .map((r) => toLeadRow(r, jobId, r._provider))
          .filter(Boolean)
          .map((row) => row!);
        const localSeen = new Set<string>();
        const localDeduped = rows.filter((row) => {
          const key = row.site.toLowerCase();
          if (localSeen.has(key)) return false;
          localSeen.add(key);
          return true;
        });

        // Claim new sites globally (dedupe across all concurrent tasks)
        const { claimedRows, reservedSourcesToExpand } = await withLock(async () => {
          const claimed: typeof localDeduped = [];
          for (const row of localDeduped) {
            const key = row.site.toLowerCase();
            if (seenSites.has(key)) continue;
            seenSites.add(key);
            claimed.push(row);
          }

          let reserved: typeof claimed = [];
          if (SOURCE_EXPAND_ENABLED && expandedSources < SOURCE_EXPAND_MAX_SOURCES_PER_JOB) {
            const remainingSources = Math.max(0, SOURCE_EXPAND_MAX_SOURCES_PER_JOB - expandedSources);
            reserved = claimed
              .filter((r) => isLikelySourceSite(r.site))
              .slice(0, Math.min(SOURCE_EXPAND_MAX_SOURCES_PER_QUERY, remainingSources));
            // Reserve slots globally (even if expansion yields 0)
            expandedSources += reserved.length;
          }

          return { claimedRows: claimed, reservedSourcesToExpand: reserved };
        });

        // Expand sources outside the lock (network-bound)
        let extractedRows: typeof claimedRows = [];
        if (reservedSourcesToExpand.length > 0) {
          const extractedBatches = await mapWithConcurrency(
            reservedSourcesToExpand,
            SOURCE_EXPAND_CONCURRENCY,
            async (source) => {
              try {
                const out = await extractCompanySitesFromSource(source.link, {
                  maxSites: SOURCE_EXPAND_MAX_SITES_PER_SOURCE,
                });
                return { source, sites: out.sites };
              } catch (e) {
                void logWarn(
                  'parser.search.source_expand.failed',
                  e instanceof Error ? e.message : String(e),
                  { jobId, source: source.site },
                  logMeta,
                );
                return { source, sites: [] };
              }
            },
          );

          const maybeExtracted: typeof claimedRows = [];
          for (const batch of extractedBatches) {
            for (const s of batch.sites) {
              if (!isLeadCandidateSite(s.site)) continue;
              maybeExtracted.push({
                job_id: jobId,
                query,
                title: s.title ?? s.site,
                link: s.link,
                snippet: `Источник: ${batch.source.site} (${batch.source.link})`,
                position: 0,
                company_name: deriveCompanyName(s.title, s.site) ?? s.site,
                site: s.site,
                description: `Источник: ${batch.source.site}`,
                email: null,
                provider: 'source_expand',
              });
            }
          }

          // Claim extracted sites globally
          extractedRows = await withLock(async () => {
            const claimed: typeof maybeExtracted = [];
            for (const row of maybeExtracted) {
              const key = row.site.toLowerCase();
              if (seenSites.has(key)) continue;
              seenSites.add(key);
              claimed.push(row);
            }
            return claimed;
          });

          if (extractedRows.length > 0) {
            void logInfo(
              'parser.search.source_expand.completed',
              'Expanded source pages into company sites',
              { jobId, query, sources: reservedSourcesToExpand.length, extracted: extractedRows.length },
              logMeta,
            );
          }
        }

        const rowsToInsert = [...claimedRows, ...extractedRows];
        // UI/export expects only companies (leads). Keep source pages for expansion but do not store them as results.
        const companyRowsToInsert = rowsToInsert.filter((r) => !isLikelySourceSite(r.site));

        // Email enrichment (reserve slots globally, do network outside lock)
        let toEnrich: typeof companyRowsToInsert = [];
        if (ENRICH_EMAIL_ENABLED) {
          toEnrich = await withLock(async () => {
            if (enrichedSites >= ENRICH_EMAIL_MAX_SITES_PER_JOB) return [];
            const remaining = Math.max(0, ENRICH_EMAIL_MAX_SITES_PER_JOB - enrichedSites);
            const candidates = companyRowsToInsert
              .filter((r) => !r.email && isEnrichableCompanySite(r.site))
              .slice(0, remaining);
            enrichedSites += candidates.length;
            return candidates;
          });
        }

        if (toEnrich.length > 0) {
          const enriched = await mapWithConcurrency(toEnrich, ENRICH_EMAIL_CONCURRENCY, async (lead) => {
            try {
              const { emails, brand_name } = await fetchWebsiteEmails(lead.site, {
                maxPages: ENRICH_EMAIL_MAX_PAGES_PER_SITE,
              });
              const cleaned = emails.map((e) => e.trim()).filter(Boolean);
              const unique = Array.from(new Set(cleaned)).slice(0, 3);
              return {
                site: lead.site,
                email: unique.length ? unique.join('; ') : null,
                brand_name: brand_name?.trim() ? brand_name.trim().slice(0, 160) : null,
              };
            } catch {
              return { site: lead.site, email: null, brand_name: null };
            }
          });
          const enrichedBySite = new Map(enriched.map((e) => [e.site.toLowerCase(), e]));
          for (const row of companyRowsToInsert) {
            const e = enrichedBySite.get(row.site.toLowerCase());
            if (!e) continue;
            if (e.email) row.email = e.email;
            if (e.brand_name) row.company_name = pickBetterCompanyName(row.company_name, e.brand_name) ?? row.company_name;
          }
        }

        if (companyRowsToInsert.length > 0) {
          const inserted = await insertInBatches(admin, companyRowsToInsert, { batchSize: 60 });
          if (inserted.hadFailures) {
            hadQueryFailures = true;
            void logError(
              'parser.search.insert.failed',
              new Error(inserted.firstErrorMessage ?? 'insert failed'),
              { jobId, provider, query, attempted: companyRowsToInsert.length, inserted: inserted.inserted },
              logMeta,
            );
          }
          insertedCount = inserted.inserted;
        }

        await querySpan?.end(
          {
            results: results.length,
            inserted: insertedCount,
            fallback_used: usedFallback,
            provider,
            links: {
              ...(provider === 'google' && debugPrimary && typeof debugPrimary === 'object'
                ? {
                    google_url: (debugPrimary as { request_url?: string }).request_url,
                    final_url: (debugPrimary as { final_url?: string }).final_url,
                  }
                : {}),
              ...(provider === 'duckduckgo' && debugPrimary && typeof debugPrimary === 'object'
                ? {
                    duckduckgo_url: (debugPrimary as { request_url?: string }).request_url,
                    final_url: (debugPrimary as { final_url?: string }).final_url,
                  }
                : {}),
              ...(provider === 'bing' && debugPrimary && typeof debugPrimary === 'object'
                ? {
                    bing_url: (debugPrimary as { request_url?: string }).request_url,
                    final_url: (debugPrimary as { final_url?: string }).final_url,
                  }
                : {}),
              ...(provider === 'mojeek' && debugPrimary && typeof debugPrimary === 'object'
                ? {
                    mojeek_url: (debugPrimary as { request_url?: string }).request_url,
                    final_url: (debugPrimary as { final_url?: string }).final_url,
                  }
                : {}),
              ...(usedFallback && googleUrlFallback ? { fallback_google_url: googleUrlFallback } : {}),
            },
            ...(results.length === 0 ? { debug: { primary: debugPrimary, fallback: debugFallback } } : {}),
          },
          `Найдено ${results.length} результатов`,
        );
        void logInfo(
          'parser.search.query.completed',
          'Search parser query completed',
          { jobId, query, results: results.length, inserted: insertedCount, fallback_used: usedFallback },
          logMeta,
        );
      } catch (err) {
        hadQueryFailures = true;
        if (!isGoogleBlockedError(err) && !isDuckDuckGoBlockedError(err) && !isBingBlockedError(err) && !isMojeekBlockedError(err)) {
          console.error(`Error processing query "${query}":`, err);
        } else {
          console.warn(`Search blocked for query "${query}":`, err);
        }
        await querySpan?.fail(err);
        void logError('parser.search.query.failed', err, { jobId, query }, logMeta);

        // Keep the same cooldown behavior, but update shared counters under lock.
        if (isGoogleBlockedError(err)) {
          await withLock(async () => {
            ddgBlockedStreak = 0;
            lastBlockedHint = err.message;
          });
          await throttleBetweenQueries('duckduckgo');
        } else if (isDuckDuckGoBlockedError(err)) {
          await withLock(async () => {
            ddgBlockedStreak += 1;
            ddgBlockedCount += 1;
            lastBlockedHint = err.message;
          });
          const streak = Math.min(ddgBlockedStreak, 6);
          const cooldown = Math.min(90_000, 4500 * 2 ** (streak - 1) + randInt(0, 2500));
          await sleep(cooldown);
        } else if (isBingBlockedError(err)) {
          await withLock(async () => {
            ddgBlockedStreak = 0;
            lastBlockedHint = err instanceof Error ? err.message : String(err);
          });
          await sleep(randInt(6000, 16000));
        } else if (isMojeekBlockedError(err)) {
          await withLock(async () => {
            ddgBlockedStreak = 0;
            lastBlockedHint = err instanceof Error ? err.message : String(err);
          });
          await sleep(randInt(3500, 9000));
        } else {
          await withLock(async () => {
            ddgBlockedStreak = 0;
          });
        }
      } finally {
        await withLock(async () => {
          processedQueries += 1;
          if (insertedCount > 0) totalResults += insertedCount;
          if (hadQueryFailures) hadFailures = true;
        });
        await admin
          .from('search_parser_jobs')
          .update({
            processed_queries: processedQueries,
            total_results: totalResults,
          })
          .eq('id', jobId);
      }
    });

    // Prefer completing with a meaningful hint if we saw blocks.
    const hint =
      totalResults <= 0 && lastBlockedHint
        ? `Поисковик ограничил запросы: ${lastBlockedHint}.`
        : lastBlockedHint && (ddgBlockedCount > 0 || hadFailures)
          ? `Частично ограничено поисковиком: ${lastBlockedHint}`
          : null;

    const diagnostics = buildSearchDiagnostics({ totalResults, blockedMessage: hint });
    if (diagnostics.status === 'empty' && diagnostics.hint) {
      void logWarn(
        'parser.search.zero_results',
        diagnostics.hint,
        { jobId, processedQueries, totalQueries: queries.length },
        logMeta,
      );
    }

    // 4. Complete
    await admin
      .from('search_parser_jobs')
      .update({  
        status: 'completed',
        completed_at: new Date().toISOString(),
        processed_queries: processedQueries,
        total_results: totalResults,
        error_message: diagnostics.hint,
      })
      .eq('id', jobId);

    await trace?.end(
      { processedQueries, totalResults, hadFailures },
      `Завершено: ${totalResults} результатов`,
    );
    void logInfo(
      'parser.search.job.completed',
      'Search parser job completed',
      { jobId, processedQueries, totalResults, hadFailures },
      logMeta,
    );
  } catch (err) {
    console.error('Search parser worker failed:', err);
    if (supabaseAdmin) {
      await supabaseAdmin
        .from('search_parser_jobs')
        .update({ 
          status: 'failed', 
          error_message: err instanceof Error ? err.message : 'Unknown error',
          completed_at: new Date().toISOString()
        })
        .eq('id', jobId);
    }
    void logError(
      'parser.search.job.failed',
      err,
      { jobId },
      undefined,
    );
  }
}
