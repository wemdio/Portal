
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo, logWarn } from '@/lib/loggerServer';
import { startTrace } from '@/lib/tracer';
import { buildSearchDiagnostics } from '@/lib/parsers/searchParserDiagnostics';
import { simplifySearchQuery } from '@/lib/parsers/searchQueryUtils';
import { fetchWebsiteEmails } from '@/lib/enrich/websiteParser';
import type { SearchResultItem } from './searchScraper';
import { duckDuckGoSearchDetailed, googleSearchDetailed, isDuckDuckGoBlockedError, isGoogleBlockedError } from './searchScraper';
import { extractCompanySitesFromSource } from './sourceCompanyExtractor';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENRICH_EMAIL_ENABLED = process.env.SEARCH_ENRICH_EMAIL_ENABLED !== '0';
const ENRICH_EMAIL_MAX_SITES_PER_JOB = Number(process.env.SEARCH_ENRICH_EMAIL_MAX_SITES_PER_JOB ?? '40') || 40;
const ENRICH_EMAIL_MAX_PAGES_PER_SITE = Number(process.env.SEARCH_ENRICH_EMAIL_MAX_PAGES_PER_SITE ?? '8') || 8;
const ENRICH_EMAIL_CONCURRENCY = Number(process.env.SEARCH_ENRICH_EMAIL_CONCURRENCY ?? '2') || 2;

const SOURCE_EXPAND_ENABLED = process.env.SEARCH_SOURCE_EXPAND_ENABLED !== '0';
const SOURCE_EXPAND_MAX_SOURCES_PER_QUERY = Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SOURCES_PER_QUERY ?? '2') || 2;
const SOURCE_EXPAND_MAX_SOURCES_PER_JOB = Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SOURCES_PER_JOB ?? '10') || 10;
const SOURCE_EXPAND_MAX_SITES_PER_SOURCE = Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SITES_PER_SOURCE ?? '25') || 25;
const SOURCE_EXPAND_CONCURRENCY = Number(process.env.SEARCH_SOURCE_EXPAND_CONCURRENCY ?? '2') || 2;

const QUERY_CONCURRENCY = Math.max(
  1,
  Math.min(3, Number(process.env.SEARCH_QUERY_CONCURRENCY ?? '2') || 2),
);

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

async function throttleBetweenQueries(provider: 'google' | 'duckduckgo') {
  // Aim for stability over speed; jitter helps avoid anti-bot thresholds.
  // Google already has internal delay in googleSearchDetailed; DDG does not.
  const base = provider === 'duckduckgo' ? randInt(1200, 2600) : randInt(600, 1400);
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

function normalizeSite(link: string): string | null {
  try {
    const url = new URL(link);
    // store as canonical "site" (origin only, force https)
    return `https://${url.hostname.replace(/^www\./i, '')}/`;
  } catch {
    return null;
  }
}

function deriveCompanyName(title: string | undefined | null, site: string): string | null {
  const raw = (title ?? '').trim();
  const fallback = site
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split('/')[0]
    .replace(/^www\./i, '');

  const base = raw
    ? raw
        .replace(/[“”«»]/g, '"')
        .split(/\s+[\-|—|•|:|·|::|\|]\s+/)[0]
        .split(' | ')[0]
        .trim()
    : '';

  const candidate = (base || fallback).trim();
  if (candidate.length < 2) return null;
  // avoid returning just a TLD-like token
  if (/^\w+\.\w+$/.test(candidate) && candidate.toLowerCase() === fallback.toLowerCase()) {
    // Convert domain to a slightly nicer display name
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
  provider: 'google' | 'duckduckgo',
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
  const companyName = deriveCompanyName(r.title, site) ?? site;

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

      let providerUsed: 'google' | 'duckduckgo' = 'google';
      let insertedCount = 0;
      let hadQueryFailures = false;

      try {
        let results: SearchResultItem[] = [];
        let debugPrimary: unknown = null;
        let usedFallback = false;
        let debugFallback: unknown = null;
        let googleUrlFallback: string | null = null;
        let provider: 'google' | 'duckduckgo' = 'google';
        const simplifiedQuery = simplifySearchQuery(query);

        try {
          if (googleBlockedForJob) {
            const ddg = await duckDuckGoSearchDetailed(query);
            results = ddg.results;
            debugPrimary = ddg.debug;
            provider = 'duckduckgo';
          } else {
            const primary = await googleSearchDetailed(query);
            results = primary.results;
            debugPrimary = primary.debug;
            provider = 'google';
          }
        } catch (e) {
          if (isGoogleBlockedError(e)) {
            usedFallback = true;
            googleBlockedForJob = true;
            debugPrimary = { error: e instanceof Error ? { name: e.name, message: e.message } : String(e) };
            const ddg = await duckDuckGoSearchDetailed(query);
            results = ddg.results;
            debugFallback = ddg.debug;
            provider = 'duckduckgo';
          } else {
            throw e;
          }
        }

        // If Google returns 200 but we parse zero results, prefer DDG for stability.
        if (!googleBlockedForJob && provider === 'google' && results.length === 0) {
          const dbg =
            debugPrimary && typeof debugPrimary === 'object'
              ? (debugPrimary as { container_count?: unknown; title?: unknown })
              : null;
          const containerCount = typeof dbg?.container_count === 'number' ? dbg.container_count : null;
          const title = typeof dbg?.title === 'string' ? dbg.title : null;
          const looksLikeEmptyShell = containerCount === 0 || (title !== null && title.trim() === '');
          if (looksLikeEmptyShell) {
            try {
              const ddg = await duckDuckGoSearchDetailed(query);
              if (ddg.results.length > 0) {
                usedFallback = true;
                debugFallback = ddg.debug;
                results = ddg.results;
                provider = 'duckduckgo';
                googleBlockedForJob = true;
              }
            } catch (e) {
              debugFallback = { error: e instanceof Error ? { name: e.name, message: e.message } : String(e) };
            }
          }
        }

        if (results.length === 0) {
          const simplified = simplifiedQuery;
          if (simplified && simplified !== query) {
            usedFallback = true;
            if (provider === 'google') {
              const fallback = await googleSearchDetailed(simplified);
              results = fallback.results;
              debugFallback = fallback.debug;
              googleUrlFallback = fallback.debug.request_url;
            } else {
              const fallback = await duckDuckGoSearchDetailed(simplified);
              results = fallback.results;
              debugFallback = fallback.debug;
            }
            if (results.length > 0) {
              results = results.map((item) => ({ ...item, query }));
            }
          }
        }

        providerUsed = provider;

        // Build rows (local dedupe only)
        const rows = results
          .map((r) => toLeadRow(r, jobId, provider))
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

        // Email enrichment (reserve slots globally, do network outside lock)
        let toEnrich: typeof rowsToInsert = [];
        if (ENRICH_EMAIL_ENABLED) {
          toEnrich = await withLock(async () => {
            if (enrichedSites >= ENRICH_EMAIL_MAX_SITES_PER_JOB) return [];
            const remaining = Math.max(0, ENRICH_EMAIL_MAX_SITES_PER_JOB - enrichedSites);
            const candidates = rowsToInsert
              .filter((r) => !r.email && isEnrichableCompanySite(r.site))
              .slice(0, remaining);
            enrichedSites += candidates.length;
            return candidates;
          });
        }

        if (toEnrich.length > 0) {
          const enriched = await mapWithConcurrency(toEnrich, ENRICH_EMAIL_CONCURRENCY, async (lead) => {
            try {
              const { emails } = await fetchWebsiteEmails(lead.site, { maxPages: ENRICH_EMAIL_MAX_PAGES_PER_SITE });
              const cleaned = emails.map((e) => e.trim()).filter(Boolean);
              const unique = Array.from(new Set(cleaned)).slice(0, 3);
              return { site: lead.site, email: unique.length ? unique.join('; ') : null };
            } catch {
              return { site: lead.site, email: null };
            }
          });
          const emailBySite = new Map(enriched.map((e) => [e.site.toLowerCase(), e.email]));
          for (const row of rowsToInsert) {
            const e = emailBySite.get(row.site.toLowerCase());
            if (e) row.email = e;
          }
        }

        if (rowsToInsert.length > 0) {
          const { error: insertError } = await admin.from('search_results').insert(rowsToInsert);
          if (insertError) {
            hadQueryFailures = true;
            void logError('parser.search.insert.failed', insertError, { jobId, provider, query }, logMeta);
          } else {
            insertedCount = rowsToInsert.length;
          }
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

        await throttleBetweenQueries(provider);
      } catch (err) {
        hadQueryFailures = true;
        if (!isGoogleBlockedError(err) && !isDuckDuckGoBlockedError(err)) {
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
        ? `Поисковик ограничил запросы: ${lastBlockedHint}. Попробуйте VPN/прокси или увеличьте паузы.`
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
