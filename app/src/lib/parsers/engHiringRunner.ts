import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { extractJobs, mergeCompanyTokens, parseCompanyCsv, postingsUrl, type AtsCompanyToken } from '@/lib/jobs/atsCompanyParser';
import {
  ENG_HIRING_SOURCES,
  dedupeEngHiringVacanciesByCompany,
  dedupeEngHiringVacancies,
  dedupeEngHiringRowsBySourceJobId,
  mergeEngHiringVacancyDetail,
  matchesEngHiringVacancy,
  normalizeAtsJobToEngVacancy,
  resolveEngHiringCompaniesLimit,
  stripUnstorableJsonChars,
  type EngHiringSearchConfig,
  type EngHiringSource,
  type EngHiringVacancy,
} from '@/lib/parsers/engHiring';
import { fetchJsonWithFallback, fetchTextWithFallback } from '@/lib/parsers/atsHttp';
import { domainToSiteUrl, resolveCompanyDomainByName } from '@/lib/parsers/companyDomainResolver';

const TOKENS_BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
// One or more comma-separated bases, each serving `<base>/<source>.csv` in the
// `name,slug,url` schema. Lists are merged + deduped by slug (primary first), so
// a larger derived list can be layered on top of the seed without code changes.
const TOKEN_BASES = (process.env.ENG_HIRING_TOKEN_BASES ?? TOKENS_BASE)
  .split(',')
  .map((base) => base.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const UA = 'PortalEngHiringParser/1.0 (+https://wemd.io)';

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const REQUEST_TIMEOUT_MS = 15_000;
const LEVER_REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.ENG_HIRING_LEVER_TIMEOUT_MS ?? '8000'));
const DEFAULT_COMPANIES_LIMIT = 1000;
const MAX_COMPANIES_LIMIT = Math.max(1000, Number(process.env.ENG_HIRING_MAX_COMPANIES_LIMIT ?? '25000'));
const MAX_CACHE_SCAN_ROWS = Math.max(1000, Number(process.env.ENG_HIRING_MAX_CACHE_SCAN_ROWS ?? '50000'));
const MAX_RESULTS = Math.max(1000, Number(process.env.ENG_HIRING_MAX_RESULTS ?? '20000'));
const DEFAULT_CACHE_MAX_AGE_HOURS = 12;
const SCAN_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_SCAN_DELAY_MS ?? '80'));
const SCAN_CONCURRENCY = clampInteger(process.env.ENG_HIRING_SCAN_CONCURRENCY, 12, 1, 50);
// Per-source scan pacing. Workday's CXS WAF IP-bans aggressive scanners (a burst
// of 2604 boards at the global pace yielded 0 vacancies in prod), so it gets much
// gentler built-in defaults. Every source can be tuned without a redeploy via
// ENG_HIRING_<SOURCE>_SCAN_CONCURRENCY / ENG_HIRING_<SOURCE>_SCAN_DELAY_MS;
// unlisted sources keep the global knobs above.
const SCAN_PACE_DEFAULTS: Partial<Record<EngHiringSource, { concurrency: number; delayMs: number }>> = {
  workday: { concurrency: 2, delayMs: 1500 },
};

function scanPaceFor(source: EngHiringSource): { concurrency: number; delayMs: number } {
  const key = source.toUpperCase();
  const base = SCAN_PACE_DEFAULTS[source] ?? { concurrency: SCAN_CONCURRENCY, delayMs: SCAN_DELAY_MS };
  return {
    concurrency: clampInteger(process.env[`ENG_HIRING_${key}_SCAN_CONCURRENCY`], base.concurrency, 1, 50),
    delayMs: Math.max(0, Number(process.env[`ENG_HIRING_${key}_SCAN_DELAY_MS`] ?? base.delayMs) || 0),
  };
}
const CACHE_PROGRESS_INTERVAL = clampInteger(process.env.ENG_HIRING_CACHE_PROGRESS_INTERVAL, 25, 1, 1000);
const ENRICH_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_ENRICH_DELAY_MS ?? '200'));
const ENRICH_LIMIT = Math.max(0, Number(process.env.ENG_HIRING_ENRICH_LIMIT ?? '300'));
const DETAIL_ENRICH_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_DETAIL_DELAY_MS ?? '120'));
const DETAIL_ENRICH_LIMIT = Math.max(0, Number(process.env.ENG_HIRING_DETAIL_LIMIT ?? '500'));
const WORKDAY_PAGE_SIZE = 100;
const WORKDAY_MAX_POSTINGS_PER_COMPANY = clampInteger(process.env.ENG_HIRING_WORKDAY_MAX_POSTINGS_PER_COMPANY, 200, 50, 1000);
// Targeted search terms used by ATS that expose a free-text query (Workday CXS,
// SmartRecruiters), so an empty-query first page does not crowd out sales roles.
const SALES_SEARCH_TEXTS = ['', 'sales', 'account', 'business development', 'partnership', 'revenue'];
const SMARTRECRUITERS_PAGE_SIZE = 100;
const SMARTRECRUITERS_MAX_POSTINGS_PER_COMPANY = clampInteger(process.env.ENG_HIRING_SMARTRECRUITERS_MAX_POSTINGS_PER_COMPANY, 200, 50, 1000);
const CACHE_BATCH_SIZE = 250;
const RESULT_BATCH_SIZE = 500;
const CACHE_UPSERT_CHUNK = clampInteger(process.env.ENG_HIRING_CACHE_UPSERT_CHUNK, 100, 10, 500);
const UPSERT_RETRIES = clampInteger(process.env.ENG_HIRING_UPSERT_RETRIES, 3, 1, 6);
const UPSERT_RETRY_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_UPSERT_RETRY_DELAY_MS ?? '1000'));

type Db = NonNullable<typeof supabaseAdmin>;

type CacheRow = EngHiringVacancy & {
  id?: string;
  cache_id?: string | null;
  cache_fetched_at?: string | null;
  last_seen_at?: string | null;
};

type RefreshSourceStats = {
  scannedCompanies: number;
  cachedVacancies: number;
  failedBoards: number;
  error: string | null;
};

type SourceDiagnostics = {
  refreshed: boolean;
  scanned_companies: number;
  cached_vacancies: number;
  failed_boards: number;
  error: string | null;
  matched_rows: number;
};

type CacheRunRow = {
  id: string;
  next_company_index?: number | null;
  scanned_companies?: number | null;
  cached_vacancies?: number | null;
  total_companies?: number | null;
};

class EngHiringCancelledError extends Error {}

type DetailRequest = {
  url: string;
  format: 'json' | 'text';
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: 'info' | 'error' | 'warn', msg: string, extra?: unknown) {
  const line = `[eng-hiring-runner][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

function sourcesFromConfig(config: EngHiringSearchConfig): EngHiringSource[] {
  const raw = Array.isArray(config.sources) ? config.sources : [];
  const valid = raw.filter((s): s is EngHiringSource => ENG_HIRING_SOURCES.includes(s));
  return valid.length ? Array.from(new Set(valid)) : [...ENG_HIRING_SOURCES];
}

function clampCompaniesLimit(value: unknown): number {
  return resolveEngHiringCompaniesLimit(value, {
    defaultLimit: DEFAULT_COMPANIES_LIMIT,
    maxCoverageLimit: MAX_COMPANIES_LIMIT,
  });
}

function clampMaxResults(value: unknown): number {
  const n = Number(value ?? 5000);
  if (!Number.isFinite(n)) return 5000;
  if (n <= 0) return MAX_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(n)));
}

function cachePublishedCutoff(config: EngHiringSearchConfig): string | null {
  const days = Number(config.posted_within_days ?? 0);
  if (!Number.isFinite(days) || days <= 0) return null;
  const now = config.now ? new Date(config.now) : new Date();
  if (Number.isNaN(now.getTime())) return null;
  return new Date(now.getTime() - Math.trunc(days) * 86_400_000).toISOString();
}

function cacheCountryCodes(config: EngHiringSearchConfig): string[] {
  const countries = Array.isArray(config.countries)
    ? config.countries.map((code) => String(code).toLowerCase().trim()).filter(Boolean)
    : [];
  if (countries.length === 0 || countries.includes('remote')) return [];
  return Array.from(new Set(countries));
}

async function fetchJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  return fetchJsonWithFallback(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    timeoutMs,
  });
}

async function fetchText(url: string): Promise<string> {
  return fetchTextWithFallback(url, {
    headers: { 'User-Agent': UA },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

async function fetchWorkdayPayloads(url: string): Promise<unknown[]> {
  const payloads: unknown[] = [];

  for (const searchText of SALES_SEARCH_TEXTS) {
    let offset = 0;
    let total = WORKDAY_PAGE_SIZE;

    while (offset < total && offset < WORKDAY_MAX_POSTINGS_PER_COMPANY) {
      // Workday's CXS endpoint sits behind a WAF that blocks Node/undici by TLS
      // fingerprint (same class of block as Clearbit), so route the POST through
      // the curl-backed fallback instead of a raw fetch — otherwise every board
      // silently returns 0 (see engHiringRunner Workday WAF regression test).
      const payload = await fetchJsonWithFallback(url, {
        method: 'POST',
        body: JSON.stringify({
          appliedFacets: {},
          limit: WORKDAY_PAGE_SIZE,
          offset,
          searchText,
        }),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
      }) as Record<string, unknown>;
      payloads.push(payload);
      const count = Array.isArray(payload.jobPostings) ? payload.jobPostings.length : 0;
      const rawTotal = Number(payload.total);
      total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : offset + count;
      if (count === 0) break;
      offset += count;
    }

    // Short-circuit: if the broad ('') query paged through the company's ENTIRE
    // posting list (reached the end, not stopped by the per-company cap), the
    // targeted searches can only re-return a subset we already have — skip them.
    // Saves ~5 requests per small board (the vast majority); big boards with more
    // postings than the cap still fan out to surface sales roles beyond the broad
    // pages.
    if (searchText === '' && offset >= total) break;
  }

  return payloads;
}

async function fetchSmartrecruitersPayloads(baseUrl: string): Promise<unknown[]> {
  const payloads: unknown[] = [];

  for (const searchText of SALES_SEARCH_TEXTS) {
    let offset = 0;
    let total = SMARTRECRUITERS_PAGE_SIZE;

    while (offset < total && offset < SMARTRECRUITERS_MAX_POSTINGS_PER_COMPANY) {
      const params = new URLSearchParams({ limit: String(SMARTRECRUITERS_PAGE_SIZE), offset: String(offset) });
      if (searchText) params.set('q', searchText);
      const payload = await fetchJson(`${baseUrl}?${params.toString()}`) as Record<string, unknown>;
      payloads.push(payload);
      const count = Array.isArray(payload.content) ? payload.content.length : 0;
      const rawTotal = Number(payload.totalFound);
      total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : offset + count;
      if (count === 0) break;
      offset += count;
    }

    // Same short-circuit as Workday: a broad query that returned the whole board
    // makes the targeted q-searches redundant (see fetchWorkdayPayloads).
    if (searchText === '' && offset >= total) break;
  }

  return payloads;
}

function toCacheRow(v: EngHiringVacancy) {
  const now = new Date().toISOString();
  // Strip NUL / lone surrogates so the jsonb `raw` blob and text columns can't
  // trip Postgres ("invalid input syntax for type json") on scraped payloads.
  return stripUnstorableJsonChars({
    source: v.source,
    source_company_slug: v.source_company_slug,
    source_job_id: v.source_job_id,
    company_name: v.company_name,
    company_site_url: v.company_site_url,
    company_description: v.company_description,
    vacancy_title: v.vacancy_title,
    vacancy_description: v.vacancy_description,
    vacancy_url: v.vacancy_url,
    careers_url: v.careers_url,
    location: v.location,
    city: v.city,
    country: v.country,
    country_code: v.country_code,
    salary_from: v.salary_from,
    salary_to: v.salary_to,
    salary_currency: v.salary_currency,
    published_at: v.published_at,
    raw: v.raw ?? {},
    last_seen_at: now,
    cache_fetched_at: now,
    updated_at: now,
  });
}

async function fetchSourceCacheRows(source: EngHiringSource, token: AtsCompanyToken): Promise<{ rows: ReturnType<typeof toCacheRow>[]; failed: boolean }> {
  try {
    const payloads = source === 'workday'
      ? await fetchWorkdayPayloads(postingsUrl(source, token.slug, token.url))
      : source === 'smartrecruiters'
        ? await fetchSmartrecruitersPayloads(postingsUrl(source, token.slug, token.url))
        : [await fetchJson(
          postingsUrl(source, token.slug, token.url),
          source === 'lever' ? LEVER_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        )];
    const rows: ReturnType<typeof toCacheRow>[] = [];
    for (const payload of payloads) {
      for (const raw of extractJobs(source, payload)) {
        const vacancy = normalizeAtsJobToEngVacancy(source, raw, {
          slug: token.slug,
          companyName: token.name,
          sourceUrl: token.url,
        });
        if (vacancy) rows.push(toCacheRow(vacancy));
      }
    }
    return { rows, failed: false };
  } catch {
    /* board moved, private, empty, or rate-limited: skip — but count it, so a
       full-sweep failure (WAF/IP block) can't masquerade as an empty source */
    return { rows: [], failed: true };
  }
}

function cacheRowToVacancy(row: Record<string, unknown>): CacheRow {
  return {
    id: String(row.id ?? ''),
    cache_id: String(row.id ?? ''),
    source: row.source as EngHiringSource,
    source_company_slug: String(row.source_company_slug ?? ''),
    source_job_id: String(row.source_job_id ?? ''),
    company_name: String(row.company_name ?? ''),
    company_site_url: (row.company_site_url as string | null) ?? null,
    company_description: (row.company_description as string | null) ?? null,
    vacancy_title: String(row.vacancy_title ?? ''),
    vacancy_description: (row.vacancy_description as string | null) ?? null,
    vacancy_url: String(row.vacancy_url ?? ''),
    careers_url: (row.careers_url as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    country_code: (row.country_code as string | null) ?? null,
    salary_from: (row.salary_from as number | null) ?? null,
    salary_to: (row.salary_to as number | null) ?? null,
    salary_currency: (row.salary_currency as string | null) ?? null,
    published_at: (row.published_at as string | null) ?? null,
    raw: row.raw ?? {},
    cache_fetched_at: (row.cache_fetched_at as string | null) ?? null,
    last_seen_at: (row.last_seen_at as string | null) ?? null,
  };
}

function toResultRow(jobId: string, v: CacheRow) {
  return {
    job_id: jobId,
    cache_id: v.cache_id ?? v.id ?? null,
    source: v.source,
    source_company_slug: v.source_company_slug,
    source_job_id: v.source_job_id,
    company_name: v.company_name,
    company_site_url: v.company_site_url,
    company_description: v.company_description,
    vacancy_title: v.vacancy_title,
    vacancy_description: v.vacancy_description,
    vacancy_url: v.vacancy_url,
    careers_url: v.careers_url,
    location: v.location,
    city: v.city,
    country: v.country,
    country_code: v.country_code,
    salary_from: v.salary_from,
    salary_to: v.salary_to,
    salary_currency: v.salary_currency,
    published_at: v.published_at,
  };
}

type UpsertOutcome = { error: { message: string } | null };

// Abort / timeout / dropped-connection errors are worth retrying; data and
// constraint errors are not (a retry just fails identically and wastes time).
export function isTransientDbError(message: string): boolean {
  return /\babort|timed?\s*out|timeout|fetch failed|socket|econnreset|epipe|enetunreach|network|terminat/i.test(message ?? '');
}

// Upsert rows in bounded chunks, retrying transient failures with backoff. The
// cache/result upserts use ON CONFLICT, so they are idempotent — safe to retry
// even when a 120s fetch-timeout abort may have partially applied the write (the
// admin client conservatively refuses to retry write aborts; this layer can,
// because re-running the same upsert converges to the same rows). Smaller chunks
// also keep each request well under the DB fetch timeout when 144 is under load.
export async function upsertInChunksWithRetry(
  upsert: (chunk: unknown[]) => Promise<UpsertOutcome>,
  rows: unknown[],
  opts: { chunkSize: number; retries: number; delayMs: number; sleep?: (ms: number) => Promise<void>; label?: string },
): Promise<void> {
  const wait = opts.sleep ?? sleep;
  const label = opts.label ?? 'cache upsert';
  for (let i = 0; i < rows.length; i += opts.chunkSize) {
    const chunk = rows.slice(i, i + opts.chunkSize);
    let lastMessage = '';
    let ok = false;
    for (let attempt = 1; attempt <= opts.retries; attempt += 1) {
      const { error } = await upsert(chunk);
      if (!error) { ok = true; break; }
      lastMessage = error.message;
      if (attempt < opts.retries && isTransientDbError(error.message)) {
        await wait(opts.delayMs * attempt);
        continue;
      }
      break;
    }
    if (!ok) throw new Error(`${label} failed: ${lastMessage}`);
  }
}

async function upsertCacheBatch(db: Db, rows: ReturnType<typeof toCacheRow>[]) {
  if (rows.length === 0) return;
  const uniqueRows = dedupeEngHiringRowsBySourceJobId(rows);
  await upsertInChunksWithRetry(
    (chunk) => db
      .from('eng_hiring_cache')
      .upsert(chunk as ReturnType<typeof toCacheRow>[], { onConflict: 'source,source_job_id' }) as unknown as Promise<UpsertOutcome>,
    uniqueRows,
    { chunkSize: CACHE_UPSERT_CHUNK, retries: UPSERT_RETRIES, delayMs: UPSERT_RETRY_DELAY_MS },
  );
}

async function sourceNeedsRefresh(db: Db, source: EngHiringSource, limit: number, maxAgeHours: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
  const { data, error } = await db
    .from('eng_hiring_cache_runs')
    .select('id')
    .eq('source', source)
    .eq('status', 'completed')
    .gte('companies_limit', limit)
    .gte('completed_at', cutoff)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`cache run freshness check failed: ${error.message}`);
  return !data;
}

function toNonNegativeInt(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

async function findResumableCacheRun(db: Db, source: EngHiringSource, limit: number): Promise<CacheRunRow | null> {
  const { data, error } = await db
    .from('eng_hiring_cache_runs')
    .select('id,next_company_index,scanned_companies,cached_vacancies,total_companies')
    .eq('source', source)
    .eq('companies_limit', limit)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`cache run resume check failed: ${error.message}`);
  return (data as CacheRunRow | null) ?? null;
}

async function createCacheRun(db: Db, source: EngHiringSource, limit: number): Promise<CacheRunRow> {
  const { data, error } = await db
    .from('eng_hiring_cache_runs')
    .insert({
      source,
      companies_limit: limit,
      status: 'running',
      next_company_index: 0,
      total_companies: 0,
      scanned_companies: 0,
      cached_vacancies: 0,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id,next_company_index,scanned_companies,cached_vacancies,total_companies')
    .single();
  if (error) throw new Error(`cache run create failed: ${error.message}`);
  return data as CacheRunRow;
}

async function updateCacheRunProgress(
  db: Db,
  runId: string,
  patch: Partial<{
    next_company_index: number;
    scanned_companies: number;
    cached_vacancies: number;
    total_companies: number;
    status: 'running' | 'completed' | 'failed';
    completed_at: string | null;
    error_message: string | null;
  }>,
): Promise<void> {
  const { error } = await db
    .from('eng_hiring_cache_runs')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw new Error(`cache run progress update failed: ${error.message}`);
}

function buildAtsDetailRequest(row: CacheRow): DetailRequest | null {
  const slug = encodeURIComponent(row.source_company_slug);
  const jobId = encodeURIComponent(row.source_job_id);
  if (!slug || !jobId) return null;
  if (row.source === 'greenhouse') {
    return { url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?questions=false`, format: 'json' };
  }
  if (row.source === 'lever') {
    return { url: `https://api.lever.co/v0/postings/${slug}/${jobId}?mode=json`, format: 'json' };
  }
  if (row.source === 'workable') {
    return { url: `https://apply.workable.com/${slug}/jobs/view/${jobId}.md`, format: 'text' };
  }
  if (row.source === 'bamboohr') {
    return { url: `https://${row.source_company_slug}.bamboohr.com/careers/${jobId}/detail`, format: 'json' };
  }
  if (row.source === 'smartrecruiters') {
    return { url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${jobId}`, format: 'json' };
  }
  return null;
}

async function refreshSourceCache(
  db: Db,
  source: EngHiringSource,
  limit: number,
  run: CacheRunRow,
  ensureNotCancelled: () => Promise<void>,
  onProgress: (done: number, total: number, source: EngHiringSource) => Promise<void>,
): Promise<RefreshSourceStats> {
  const tokenLists = await Promise.all(
    TOKEN_BASES.map(async (base) => {
      try {
        return parseCompanyCsv(await fetchText(`${base}/${source}.csv`));
      } catch {
        return []; // a base may not publish this source's list — skip it
      }
    }),
  );
  const tokens = mergeCompanyTokens(tokenLists).slice(0, limit);
  const pace = scanPaceFor(source);
  const startIndex = Math.min(toNonNegativeInt(run.next_company_index), tokens.length);
  const batch: ReturnType<typeof toCacheRow>[] = [];
  let cachedVacancies = toNonNegativeInt(run.cached_vacancies);
  let failedBoards = 0;
  let lastCheckpoint = startIndex;

  await updateCacheRunProgress(db, run.id, {
    next_company_index: startIndex,
    scanned_companies: startIndex,
    cached_vacancies: cachedVacancies,
    total_companies: tokens.length,
    error_message: null,
  });

  for (let i = startIndex; i < tokens.length; i += pace.concurrency) {
    await ensureNotCancelled();
    const chunk = tokens.slice(i, Math.min(i + pace.concurrency, tokens.length));
    const chunkResults = await Promise.all(chunk.map((token) => fetchSourceCacheRows(source, token)));
    for (const { rows, failed } of chunkResults) {
      if (failed) failedBoards += 1;
      batch.push(...rows);
      cachedVacancies += rows.length;
    }

    const done = i + chunk.length;
    const shouldCheckpoint = done - lastCheckpoint >= CACHE_PROGRESS_INTERVAL || done >= tokens.length;
    if (batch.length >= CACHE_BATCH_SIZE || shouldCheckpoint) {
      await upsertCacheBatch(db, batch.splice(0, batch.length));
    }

    if (shouldCheckpoint) {
      await updateCacheRunProgress(db, run.id, {
        next_company_index: done,
        scanned_companies: done,
        cached_vacancies: cachedVacancies,
        total_companies: tokens.length,
        error_message: null,
      });
      lastCheckpoint = done;
      await ensureNotCancelled();
      await onProgress(done, tokens.length, source);
    }
    if (pace.delayMs > 0 && done < tokens.length) await sleep(pace.delayMs);
  }

  if (batch.length) {
    await upsertCacheBatch(db, batch);
  }

  // Loud zero-yield: scanning boards but caching nothing means something systemic
  // (WAF/IP block, TLS fingerprint ban, or an upstream schema change) — a legit
  // quiet market never zeroes out hundreds of boards at once. Mark the run failed
  // instead of silently 'completed', so the next job retries the source and the
  // error surfaces in the cache run + job progress detail.
  if (tokens.length > 0 && cachedVacancies === 0) {
    const message = `${source} cache scan yielded 0 vacancies from ${tokens.length} boards `
      + `(${failedBoards} board fetches failed) — likely WAF/IP block or upstream schema change`;
    await updateCacheRunProgress(db, run.id, {
      next_company_index: tokens.length,
      scanned_companies: tokens.length,
      cached_vacancies: cachedVacancies,
      total_companies: tokens.length,
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: message,
    });
    return { scannedCompanies: tokens.length, cachedVacancies, failedBoards, error: message };
  }

  await updateCacheRunProgress(db, run.id, {
    next_company_index: tokens.length,
    scanned_companies: tokens.length,
    cached_vacancies: cachedVacancies,
    total_companies: tokens.length,
    error_message: null,
  });

  return { scannedCompanies: tokens.length, cachedVacancies, failedBoards, error: null };
}

function rowNeedsDetail(row: CacheRow): boolean {
  return !row.vacancy_description || (row.salary_from == null && row.salary_to == null);
}

async function updateCacheDetail(db: Db, row: CacheRow): Promise<void> {
  const patch = stripUnstorableJsonChars({
    company_site_url: row.company_site_url,
    company_description: row.company_description,
    vacancy_description: row.vacancy_description,
    salary_from: row.salary_from,
    salary_to: row.salary_to,
    salary_currency: row.salary_currency,
    raw: row.raw ?? {},
    updated_at: new Date().toISOString(),
  });

  if (row.cache_id || row.id) {
    await db.from('eng_hiring_cache').update(patch).eq('id', row.cache_id ?? row.id);
    return;
  }
  await db
    .from('eng_hiring_cache')
    .update(patch)
    .eq('source', row.source)
    .eq('source_job_id', row.source_job_id);
}

async function enrichVacancyDetails(
  db: Db,
  rows: CacheRow[],
  ensureNotCancelled: () => Promise<void>,
  setProgress: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (DETAIL_ENRICH_LIMIT <= 0) return;

  const targets = rows
    .filter((row) => rowNeedsDetail(row) && buildAtsDetailRequest(row))
    .slice(0, DETAIL_ENRICH_LIMIT);

  for (let i = 0; i < targets.length; i += 1) {
    await ensureNotCancelled();
    const row = targets[i];
    const detailRequest = buildAtsDetailRequest(row);
    if (!detailRequest) continue;

    try {
      const detail = detailRequest.format === 'json'
        ? await fetchJson(detailRequest.url, row.source === 'lever' ? LEVER_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
        : await fetchText(detailRequest.url);
      Object.assign(row, mergeEngHiringVacancyDetail(row, detail));
      await updateCacheDetail(db, row);
    } catch {
      /* details are best-effort: keep the list-row vacancy */
    }

    if ((i + 1) % 20 === 0 || i === targets.length - 1) {
      await setProgress({
        progress_percent: 65 + Math.round(((i + 1) / Math.max(1, targets.length)) * 10),
        progress_detail: { enriching_details: i + 1, total_detail_enrich: targets.length },
      });
    }
    await sleep(DETAIL_ENRICH_DELAY_MS);
  }
}

// Sources populated out-of-band by a dedicated bulk ingest (worker/jobhiveIngestCron),
// not by per-board fetching. The run treats them as cache-only: it queries + filters +
// dedups + enriches their cached rows downstream, but never fetches boards or opens a
// cache run for them.
const CACHE_ONLY_SOURCES = new Set<EngHiringSource>(['jobhive']);

async function ensureCache(
  db: Db,
  config: EngHiringSearchConfig,
  ensureNotCancelled: () => Promise<void>,
  setProgress: (patch: Record<string, unknown>) => Promise<void>,
): Promise<Record<EngHiringSource, SourceDiagnostics>> {
  const sources = sourcesFromConfig(config);
  const diagnostics = Object.fromEntries(sources.map((source) => [
    source,
    {
      refreshed: false,
      scanned_companies: 0,
      cached_vacancies: 0,
      failed_boards: 0,
      error: null,
      matched_rows: 0,
    },
  ])) as Record<EngHiringSource, SourceDiagnostics>;
  if (config.refresh_cache === false) return diagnostics;

  const limit = clampCompaniesLimit(config.companies_limit);
  const maxAgeHours = Math.max(1, Number(config.cache_max_age_hours ?? DEFAULT_CACHE_MAX_AGE_HOURS));

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    // Bulk sources are filled by their own ingest job — never fetch their boards here.
    if (CACHE_ONLY_SOURCES.has(source)) continue;
    await ensureNotCancelled();
    const needs = await sourceNeedsRefresh(db, source, limit, maxAgeHours);
    if (!needs) continue;
    const runRow = await findResumableCacheRun(db, source, limit) ?? await createCacheRun(db, source, limit);

    await setProgress({
      progress_stage: 'refreshing_cache',
      progress_detail: { source, source_index: i + 1, total_sources: sources.length },
    });
    try {
      const stats = await refreshSourceCache(db, source, limit, runRow, ensureNotCancelled, async (done, total, currentSource) => {
        const sourceProgress = total ? done / total : 1;
        const percent = Math.round(((i + sourceProgress) / sources.length) * 55);
        await setProgress({
          progress_percent: Math.max(1, Math.min(55, percent)),
          progress_detail: { source: currentSource, scanned_companies: done, total_companies: total },
        });
      });
      diagnostics[source] = {
        ...diagnostics[source],
        refreshed: true,
        scanned_companies: stats.scannedCompanies,
        cached_vacancies: stats.cachedVacancies,
        failed_boards: stats.failedBoards,
        error: stats.error,
      };
      // A zero-yield scan already marked its own run 'failed' with the diagnosis —
      // don't overwrite that with a misleading 'completed'.
      if (stats.error == null) {
        await updateCacheRunProgress(db, runRow.id, {
          status: 'completed',
          next_company_index: stats.scannedCompanies,
          scanned_companies: stats.scannedCompanies,
          cached_vacancies: stats.cachedVacancies,
          completed_at: new Date().toISOString(),
          error_message: null,
        });
      }
    } catch (err) {
      if (err instanceof EngHiringCancelledError) {
        await updateCacheRunProgress(db, runRow.id, { error_message: null });
        throw err;
      }
      await updateCacheRunProgress(db, runRow.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: err instanceof Error ? err.message : 'Unknown error',
      });
      throw err;
    }
  }

  return diagnostics;
}

async function loadMatchingCacheRows(db: Db, config: EngHiringSearchConfig): Promise<CacheRow[]> {
  const sources = sourcesFromConfig(config);
  const maxResults = clampMaxResults(config.max_results);
  const countryCodes = cacheCountryCodes(config);
  const publishedCutoff = cachePublishedCutoff(config);
  const out: CacheRow[] = [];
  let offset = 0;

  while (offset < MAX_CACHE_SCAN_ROWS && out.length < maxResults) {
    let query = db
      .from('eng_hiring_cache')
      .select('*')
      .in('source', sources);
    if (countryCodes.length) query = query.in('country_code', countryCodes);
    // Keep null-dated rows in the SQL result (date >= cutoff OR date IS NULL) so the
    // per-source recency policy is decided once, in matchesEngHiringVacancy. A bare
    // .gte() would silently drop dateless sources (e.g. BambooHR) before that policy
    // ever runs — Postgres treats NULL >= cutoff as NULL (not true).
    if (publishedCutoff && config.include_unknown_dates !== true) {
      query = query.or(`published_at.gte.${publishedCutoff},published_at.is.null`);
    }
    const { data, error } = await query
      .order('published_at', { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error(`cache select failed: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const vacancy = cacheRowToVacancy(row as Record<string, unknown>);
      if (matchesEngHiringVacancy(vacancy, config)) out.push(vacancy);
      if (out.length >= maxResults) break;
    }
    offset += rows.length;
    if (rows.length < 1000) break;
  }

  const uniqueRows = dedupeEngHiringVacancies(out).map((row) => row as CacheRow);
  return config.dedupe_companies === false
    ? uniqueRows
    : dedupeEngHiringVacanciesByCompany(uniqueRows, config);
}

async function enrichSelectedRows(
  db: Db,
  rows: CacheRow[],
  config: EngHiringSearchConfig,
  ensureNotCancelled: () => Promise<void>,
  setProgress: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (config.enrich === false || ENRICH_LIMIT <= 0) return;

  const targets = new Map<string, CacheRow[]>();
  for (const row of rows) {
    if (row.company_site_url) continue;
    const key = `${row.source}:${row.source_company_slug || row.company_name}`.toLowerCase();
    if (!targets.has(key)) targets.set(key, []);
    targets.get(key)!.push(row);
  }

  const entries = Array.from(targets.values()).slice(0, ENRICH_LIMIT);
  for (let i = 0; i < entries.length; i += 1) {
    await ensureNotCancelled();
    const group = entries[i];
    const first = group[0];
    const domain = await resolveCompanyDomainByName(first.company_name, { country: first.country_code });
    const siteUrl = domainToSiteUrl(domain);
    if (siteUrl) {
      for (const row of group) row.company_site_url = siteUrl;
      await db
        .from('eng_hiring_cache')
        .update({ company_site_url: siteUrl, updated_at: new Date().toISOString() })
        .eq('source', first.source)
        .eq('source_company_slug', first.source_company_slug);
    }
    if ((i + 1) % 20 === 0 || i === entries.length - 1) {
      await setProgress({
        progress_percent: 75 + Math.round(((i + 1) / Math.max(1, entries.length)) * 10),
        progress_detail: { enriching_companies: i + 1, total_enrich_companies: entries.length },
      });
    }
    await sleep(ENRICH_DELAY_MS);
  }
}

async function saveResults(db: Db, jobId: string, rows: CacheRow[], setProgress: (patch: Record<string, unknown>) => Promise<void>) {
  await db.from('eng_hiring_vacancies').delete().eq('job_id', jobId);
  for (let i = 0; i < rows.length; i += RESULT_BATCH_SIZE) {
    const batch = rows.slice(i, i + RESULT_BATCH_SIZE).map((row) => toResultRow(jobId, row));
    await upsertInChunksWithRetry(
      (chunk) => db
        .from('eng_hiring_vacancies')
        .upsert(chunk as ReturnType<typeof toResultRow>[], { onConflict: 'job_id,source,source_job_id' }) as unknown as Promise<UpsertOutcome>,
      batch,
      { chunkSize: CACHE_UPSERT_CHUNK, retries: UPSERT_RETRIES, delayMs: UPSERT_RETRY_DELAY_MS, label: 'results upsert' },
    );
    await setProgress({
      progress_percent: 85 + Math.round((Math.min(i + RESULT_BATCH_SIZE, rows.length) / Math.max(1, rows.length)) * 14),
    });
  }
}

function attachMatchedDiagnostics(
  diagnostics: Record<EngHiringSource, SourceDiagnostics>,
  rows: CacheRow[],
): Record<EngHiringSource, SourceDiagnostics> {
  const out = { ...diagnostics };
  for (const row of rows) {
    out[row.source] ??= {
      refreshed: false,
      scanned_companies: 0,
      cached_vacancies: 0,
      failed_boards: 0,
      error: null,
      matched_rows: 0,
    };
    out[row.source] = {
      ...out[row.source],
      matched_rows: out[row.source].matched_rows + 1,
    };
  }
  return out;
}

export async function runEngHiringParserJob(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    log('error', 'supabaseAdmin not configured');
    return;
  }

  const setProgress = async (patch: Record<string, unknown>) => {
    const { error } = await db.from('parser_jobs').update(patch).eq('id', jobId);
    if (error) log('warn', `progress update failed for ${jobId}`, error);
  };

  const ensureNotCancelled = async () => {
    const { data } = await db.from('parser_jobs').select('status').eq('id', jobId).single();
    if (!data || data.status !== 'running') throw new EngHiringCancelledError();
  };

  try {
    const { data: job, error: jobErr } = await db
      .from('parser_jobs')
      .select('config,status')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');

    const config = (job.config ?? {}) as EngHiringSearchConfig;
    await setProgress({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'refreshing_cache',
      progress_percent: 0,
      total_found: 0,
      total_parsed: 0,
    });

    let sourceDiagnostics = await ensureCache(db, config, ensureNotCancelled, setProgress);

    await ensureNotCancelled();
    await setProgress({ progress_stage: 'filtering_cache', progress_percent: 60, progress_detail: null });
    const matched = await loadMatchingCacheRows(db, config);
    sourceDiagnostics = attachMatchedDiagnostics(sourceDiagnostics, matched);
    await setProgress({ total_found: matched.length, total_parsed: 0, progress_percent: 65 });

    await setProgress({ progress_stage: 'enriching_details', progress_percent: 65 });
    await enrichVacancyDetails(db, matched, ensureNotCancelled, setProgress);

    await setProgress({ progress_stage: 'enriching', progress_percent: 75 });
    await enrichSelectedRows(db, matched, config, ensureNotCancelled, setProgress);

    await ensureNotCancelled();
    await setProgress({ progress_stage: 'saving', progress_percent: 85 });
    await saveResults(db, jobId, matched, setProgress);

    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      progress_detail: {
        source_stats: sourceDiagnostics,
        include_unknown_dates: config.include_unknown_dates === true,
      },
      total_found: matched.length,
      total_parsed: matched.length,
      completed_at: new Date().toISOString(),
      error_message: null,
    });
    log('info', `job ${jobId} completed: ${matched.length} vacancies`);
  } catch (err) {
    if (err instanceof EngHiringCancelledError) {
      log('info', `job ${jobId} cancelled`);
      return;
    }
    log('error', `job ${jobId} failed`, err);
    await db
      .from('parser_jobs')
      .update({
        status: 'failed',
        progress_stage: 'failed',
        completed_at: new Date().toISOString(),
        error_message: err instanceof Error ? err.message : 'Unknown error',
      })
      .eq('id', jobId);
  }
}
