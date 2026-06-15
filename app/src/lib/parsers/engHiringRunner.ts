import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { extractJobs, parseCompanyCsv, postingsUrl } from '@/lib/jobs/atsCompanyParser';
import {
  ENG_HIRING_SOURCES,
  dedupeEngHiringVacanciesByCompany,
  dedupeEngHiringVacancies,
  dedupeEngHiringRowsBySourceJobId,
  mergeEngHiringVacancyDetail,
  matchesEngHiringVacancy,
  normalizeAtsJobToEngVacancy,
  resolveEngHiringCompaniesLimit,
  type EngHiringSearchConfig,
  type EngHiringSource,
  type EngHiringVacancy,
} from '@/lib/parsers/engHiring';
import { fetchJsonWithFallback, fetchTextWithFallback } from '@/lib/parsers/atsHttp';
import { domainToSiteUrl, resolveCompanyDomainByName } from '@/lib/parsers/companyDomainResolver';

const TOKENS_BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
const UA = 'PortalEngHiringParser/1.0 (+https://wemd.io)';
const REQUEST_TIMEOUT_MS = 15_000;
const LEVER_REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.ENG_HIRING_LEVER_TIMEOUT_MS ?? '8000'));
const DEFAULT_COMPANIES_LIMIT = 1000;
const MAX_COMPANIES_LIMIT = Math.max(1000, Number(process.env.ENG_HIRING_MAX_COMPANIES_LIMIT ?? '25000'));
const MAX_CACHE_SCAN_ROWS = Math.max(1000, Number(process.env.ENG_HIRING_MAX_CACHE_SCAN_ROWS ?? '50000'));
const MAX_RESULTS = Math.max(1000, Number(process.env.ENG_HIRING_MAX_RESULTS ?? '20000'));
const DEFAULT_CACHE_MAX_AGE_HOURS = 12;
const SCAN_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_SCAN_DELAY_MS ?? '80'));
const ENRICH_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_ENRICH_DELAY_MS ?? '200'));
const ENRICH_LIMIT = Math.max(0, Number(process.env.ENG_HIRING_ENRICH_LIMIT ?? '300'));
const DETAIL_ENRICH_DELAY_MS = Math.max(0, Number(process.env.ENG_HIRING_DETAIL_DELAY_MS ?? '120'));
const DETAIL_ENRICH_LIMIT = Math.max(0, Number(process.env.ENG_HIRING_DETAIL_LIMIT ?? '500'));
const CACHE_BATCH_SIZE = 250;
const RESULT_BATCH_SIZE = 500;

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

function toCacheRow(v: EngHiringVacancy) {
  const now = new Date().toISOString();
  return {
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
  };
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

async function upsertCacheBatch(db: Db, rows: ReturnType<typeof toCacheRow>[]) {
  if (rows.length === 0) return;
  const uniqueRows = dedupeEngHiringRowsBySourceJobId(rows);
  const { error } = await db
    .from('eng_hiring_cache')
    .upsert(uniqueRows, { onConflict: 'source,source_job_id' });
  if (error) throw new Error(`cache upsert failed: ${error.message}`);
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
  return null;
}

async function refreshSourceCache(
  db: Db,
  source: EngHiringSource,
  limit: number,
  ensureNotCancelled: () => Promise<void>,
  onProgress: (done: number, total: number, source: EngHiringSource) => Promise<void>,
): Promise<RefreshSourceStats> {
  const csv = await fetchText(`${TOKENS_BASE}/${source}.csv`);
  const tokens = parseCompanyCsv(csv).slice(0, limit);
  const batch: ReturnType<typeof toCacheRow>[] = [];
  let cachedVacancies = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    try {
      const payload = await fetchJson(
        postingsUrl(source, token.slug),
        source === 'lever' ? LEVER_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      );
      for (const raw of extractJobs(source, payload)) {
        const vacancy = normalizeAtsJobToEngVacancy(source, raw, {
          slug: token.slug,
          companyName: token.name,
        });
        if (!vacancy) continue;
        batch.push(toCacheRow(vacancy));
        cachedVacancies += 1;
      }
    } catch {
      /* board moved, private, empty, or rate-limited: skip */
    }

    if (batch.length >= CACHE_BATCH_SIZE) {
      await upsertCacheBatch(db, batch.splice(0, batch.length));
    }
    if ((i + 1) % 25 === 0 || i === tokens.length - 1) {
      await ensureNotCancelled();
      await onProgress(i + 1, tokens.length, source);
    }
    await sleep(SCAN_DELAY_MS);
  }

  if (batch.length) {
    await upsertCacheBatch(db, batch);
  }

  return { scannedCompanies: tokens.length, cachedVacancies };
}

function rowNeedsDetail(row: CacheRow): boolean {
  return !row.vacancy_description || (row.salary_from == null && row.salary_to == null);
}

async function updateCacheDetail(db: Db, row: CacheRow): Promise<void> {
  const patch = {
    company_site_url: row.company_site_url,
    company_description: row.company_description,
    vacancy_description: row.vacancy_description,
    salary_from: row.salary_from,
    salary_to: row.salary_to,
    salary_currency: row.salary_currency,
    raw: row.raw ?? {},
    updated_at: new Date().toISOString(),
  };

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

async function ensureCache(
  db: Db,
  config: EngHiringSearchConfig,
  ensureNotCancelled: () => Promise<void>,
  setProgress: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (config.refresh_cache === false) return;
  const sources = sourcesFromConfig(config);
  const limit = clampCompaniesLimit(config.companies_limit);
  const maxAgeHours = Math.max(1, Number(config.cache_max_age_hours ?? DEFAULT_CACHE_MAX_AGE_HOURS));

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    await ensureNotCancelled();
    const needs = await sourceNeedsRefresh(db, source, limit, maxAgeHours);
    if (!needs) continue;
    const { data: runRow, error: runErr } = await db
      .from('eng_hiring_cache_runs')
      .insert({
        source,
        companies_limit: limit,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (runErr) throw new Error(`cache run create failed: ${runErr.message}`);

    await setProgress({
      progress_stage: 'refreshing_cache',
      progress_detail: { source, source_index: i + 1, total_sources: sources.length },
    });
    try {
      const stats = await refreshSourceCache(db, source, limit, ensureNotCancelled, async (done, total, currentSource) => {
        const sourceProgress = total ? done / total : 1;
        const percent = Math.round(((i + sourceProgress) / sources.length) * 55);
        await setProgress({
          progress_percent: Math.max(1, Math.min(55, percent)),
          progress_detail: { source: currentSource, scanned_companies: done, total_companies: total },
        });
      });
      await db
        .from('eng_hiring_cache_runs')
        .update({
          status: 'completed',
          scanned_companies: stats.scannedCompanies,
          cached_vacancies: stats.cachedVacancies,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runRow.id);
    } catch (err) {
      await db
        .from('eng_hiring_cache_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: err instanceof Error ? err.message : 'Unknown error',
        })
        .eq('id', runRow.id);
      throw err;
    }
  }
}

async function loadMatchingCacheRows(db: Db, config: EngHiringSearchConfig): Promise<CacheRow[]> {
  const sources = sourcesFromConfig(config);
  const maxResults = clampMaxResults(config.max_results);
  const out: CacheRow[] = [];
  let offset = 0;

  while (offset < MAX_CACHE_SCAN_ROWS && out.length < maxResults) {
    const { data, error } = await db
      .from('eng_hiring_cache')
      .select('*')
      .in('source', sources)
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
    const domain = await resolveCompanyDomainByName(first.company_name);
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
    const { error } = await db
      .from('eng_hiring_vacancies')
      .upsert(batch, { onConflict: 'job_id,source,source_job_id' });
    if (error) throw new Error(`results upsert failed: ${error.message}`);
    await setProgress({
      progress_percent: 85 + Math.round((Math.min(i + RESULT_BATCH_SIZE, rows.length) / Math.max(1, rows.length)) * 14),
    });
  }
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

    await ensureCache(db, config, ensureNotCancelled, setProgress);

    await ensureNotCancelled();
    await setProgress({ progress_stage: 'filtering_cache', progress_percent: 60, progress_detail: null });
    const matched = await loadMatchingCacheRows(db, config);
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
      progress_detail: null,
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
