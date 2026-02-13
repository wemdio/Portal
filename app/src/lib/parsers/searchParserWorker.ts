
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError, logInfo, logWarn } from '@/lib/loggerServer';
import { startTrace } from '@/lib/tracer';
import { buildSearchDiagnostics } from '@/lib/parsers/searchParserDiagnostics';
import { simplifySearchQuery } from '@/lib/parsers/searchQueryUtils';
import { fetchWebsiteEmails } from '@/lib/enrich/websiteParser';
import type { SearchResultItem } from './searchScraper';
import { duckDuckGoSearchDetailed, googleSearchDetailed, isDuckDuckGoBlockedError, isGoogleBlockedError } from './searchScraper';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENRICH_EMAIL_ENABLED = process.env.SEARCH_ENRICH_EMAIL_ENABLED !== '0';
const ENRICH_EMAIL_MAX_SITES_PER_JOB = Number(process.env.SEARCH_ENRICH_EMAIL_MAX_SITES_PER_JOB ?? '40') || 40;
const ENRICH_EMAIL_MAX_PAGES_PER_SITE = Number(process.env.SEARCH_ENRICH_EMAIL_MAX_PAGES_PER_SITE ?? '8') || 8;
const ENRICH_EMAIL_CONCURRENCY = Number(process.env.SEARCH_ENRICH_EMAIL_CONCURRENCY ?? '2') || 2;

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

  try {
    // 1. Fetch job
    const { data: job, error } = await supabaseAdmin
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
    await supabaseAdmin
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
    let ddgBlockedStreak = 0;
    let ddgBlockedCount = 0;
    let lastBlockedHint: string | null = null;

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

    // 3. Process queries
    for (const query of queries) {
      // Check for cancellation
      const { data: currentJob } = await supabaseAdmin
        .from('search_parser_jobs')
        .select('status')
        .eq('id', jobId)
        .single();
        
      if (currentJob?.status === 'failed') { // If cancelled/failed externally
         return; 
      }

      const querySpan = await trace?.startChild({
        name: 'search.query',
        input: { query, index: processedQueries + 1, total: queries.length },
        message: `Запрос: ${query}`,
      });

      let queryFinished = false;
      try {
        let results: SearchResultItem[] = [];
        let debugPrimary: unknown = null;
        let usedFallback = false;
        let debugFallback: unknown = null;
        let googleUrlFallback: string | null = null;
        let provider: 'google' | 'duckduckgo' = 'google';

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
          // If Google is blocked (enablejs/captcha/consent), fall back to DDG instead of failing the whole job.
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

        if (results.length === 0) {
          const simplified = simplifySearchQuery(query);
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
        
        if (results.length > 0) {
          const rows = results
            .map((r) => toLeadRow(r, jobId, provider))
            .filter(Boolean)
            .map((row) => row!);

          // Drop rows without (company_name + site) and dedupe by site for this job
          const deduped = rows.filter((row) => {
            const key = row.site.toLowerCase();
            if (seenSites.has(key)) return false;
            seenSites.add(key);
            return true;
          });

          if (deduped.length > 0) {
            // Try to enrich emails by crawling contact pages (home + /contact, etc).
            if (ENRICH_EMAIL_ENABLED && enrichedSites < ENRICH_EMAIL_MAX_SITES_PER_JOB) {
              const remaining = Math.max(0, ENRICH_EMAIL_MAX_SITES_PER_JOB - enrichedSites);
              const toEnrich = deduped.filter((r) => !r.email && isEnrichableCompanySite(r.site)).slice(0, remaining);
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
                for (const row of deduped) {
                  const e = emailBySite.get(row.site.toLowerCase());
                  if (e) row.email = e;
                }
                enrichedSites += toEnrich.length;
              }
            }

            await supabaseAdmin.from('search_results').insert(deduped);
            totalResults += deduped.length;
          }
        }

        await querySpan?.end(
          {
            results: results.length,
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
            ...(results.length === 0
              ? { debug: { primary: debugPrimary, fallback: debugFallback } }
              : {}),
          },
          `Найдено ${results.length} результатов`,
        );
        void logInfo(
          'parser.search.query.completed',
          'Search parser query completed',
          { jobId, query, results: results.length, fallback_used: usedFallback },
          logMeta,
        );

        // Throttle to reduce 202/429 bursts.
        await throttleBetweenQueries(provider);
        queryFinished = true;
      } catch (err) {
        // Expected in practice: search engines can return temporary blocks (enablejs/202/429).
        // Keep logs quieter for known/handled blocks.
        if (!isGoogleBlockedError(err) && !isDuckDuckGoBlockedError(err)) {
          console.error(`Error processing query "${query}":`, err);
        } else {
          console.warn(`Search blocked for query "${query}":`, err);
        }
        hadFailures = true;
        await querySpan?.fail(err);
        void logError(
          'parser.search.query.failed',
          err,
          { jobId, query },
          logMeta,
        );
        if (isGoogleBlockedError(err)) {
          // Google blocking is expected; job should continue via DDG provider.
          ddgBlockedStreak = 0;
          lastBlockedHint = err.message;
          await throttleBetweenQueries('duckduckgo');
          queryFinished = true;
          continue;
        }
        if (isDuckDuckGoBlockedError(err)) {
          ddgBlockedStreak += 1;
          ddgBlockedCount += 1;
          lastBlockedHint = err.message;
          // Extra cooldown when DDG starts returning 202/blocked.
          const streak = Math.min(ddgBlockedStreak, 6);
          const cooldown = Math.min(90_000, 4500 * 2 ** (streak - 1) + randInt(0, 2500));
          await sleep(cooldown);
          queryFinished = true;
          continue;
        }
        ddgBlockedStreak = 0;
      } finally {
        // Always advance progress so the UI doesn't look "stuck" on blocked queries.
        if (!queryFinished) {
          // even if we rethrow in future changes, keep progress monotonic
        }
        processedQueries += 1;
        await supabaseAdmin
          .from('search_parser_jobs')
          .update({
            processed_queries: processedQueries,
            total_results: totalResults,
          })
          .eq('id', jobId);
      }
    }

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
    await supabaseAdmin
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
