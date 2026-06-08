// Server-side runner for the Adzuna ("whole market") parser. Worker-only.
// Adzuna is a market-wide aggregator (millions of postings) — the volume source,
// vs the precision ATS source. node/undici hangs on the Adzuna API, so we fetch
// via curl (curlFetch). Domains come from Clearbit enrichment (capped).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { curlJson, clearbitDomain } from '@/lib/parsers/curlFetch';
import {
  normalizeAdzunaJob,
  buildCompanyLeads,
  companyDedupKey,
  type AdzunaNormalizedJob,
} from '@/lib/jobs/adzunaCompanyParser';
import { ADZUNA_COUNTRY_CODES, isExcludedCompany } from '@/lib/parsers/adzunaConfig';
import { buildRolesRegex } from '@/lib/parsers/atsFilters';
import type { AdzunaSearchConfig } from '@/types';

const PER_PAGE = 50;
const MAX_PAGES = 20;
const DEFAULT_PAGES = 3;
const MAX_RESULT_ROWS = 8_000;
const ENRICH_CAP = 800; // cap Clearbit lookups (top companies by job_count)
const PAGE_DELAY_MS = 350;
const ENRICH_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(level: 'info' | 'error', msg: string, extra?: unknown) {
  const line = `[adzuna-runner][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

class JobCancelledError extends Error {}

function adzunaUrl(
  appId: string,
  appKey: string,
  country: string,
  query: string,
  page: number,
  maxDaysOld: number,
): string {
  const p = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: String(PER_PAGE),
    // what_phrase = exact-phrase candidate search; we still title-filter below,
    // because Adzuna full-text-matches the description too (~⅔ of `what` is noise).
    what_phrase: query,
    sort_by: 'date',
  });
  if (maxDaysOld > 0) p.set('max_days_old', String(maxDaysOld));
  return `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${page}?${p.toString()}`;
}

export async function runAdzunaParserJob(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    log('error', 'supabaseAdmin not configured');
    return;
  }

  const setProgress = (patch: Record<string, unknown>) =>
    db.from('parser_jobs').update(patch).eq('id', jobId);

  const ensureNotCancelled = async () => {
    const { data } = await db.from('parser_jobs').select('status').eq('id', jobId).single();
    if (!data || data.status !== 'running') throw new JobCancelledError();
  };

  try {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY are not set in the worker environment');
    }

    const { data: job, error: jobErr } = await db
      .from('parser_jobs')
      .select('config,status')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');

    const config = (job.config ?? {}) as AdzunaSearchConfig;
    const roles = String(config.text ?? '')
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (roles.length === 0) throw new Error('No role keywords provided');

    const countries = (Array.isArray(config.countries) ? config.countries : [])
      .map((c) => String(c).toLowerCase())
      .filter((c) => ADZUNA_COUNTRY_CODES.includes(c));
    const finalCountries = countries.length ? Array.from(new Set(countries)) : ['us'];
    const pages = Math.min(MAX_PAGES, Math.max(1, Number(config.pages ?? DEFAULT_PAGES)));
    const maxDays = Math.max(0, Number(config.posted_within_days ?? 0));
    const enrich = config.enrich !== false;
    // Keep only postings whose TITLE matches the roles — Adzuna's what/what_phrase
    // also matches the job description, so ~⅔ of raw results are off-target.
    const titleRe = buildRolesRegex(config.text);

    await setProgress({ progress_stage: 'fetching', progress_percent: 0, total_found: 0, total_parsed: 0 });

    const totalCalls = finalCountries.length * roles.length * pages;
    let call = 0;
    let excluded = 0;
    const jobs: AdzunaNormalizedJob[] = [];

    for (const country of finalCountries) {
      for (const query of roles) {
        for (let page = 1; page <= pages; page += 1) {
          call += 1;
          try {
            const data = (await curlJson(adzunaUrl(appId, appKey, country, query, page, maxDays), {
              timeoutMs: REQUEST_TIMEOUT_MS,
            })) as { results?: unknown[] };
            const results = Array.isArray(data?.results) ? data.results : [];
            for (const raw of results) {
              const norm = normalizeAdzunaJob(raw, { country, query });
              if (!norm) continue;
              if (!titleRe.test(norm.title)) continue; // drop description-only matches
              if (isExcludedCompany(norm.company)) {
                excluded += 1;
                continue;
              }
              jobs.push(norm);
            }
            if (results.length === 0) break; // no more pages for this query
          } catch {
            /* skip failed page */
          }
          if (call % 3 === 0 || call === totalCalls) {
            await ensureNotCancelled();
            await setProgress({
              progress_percent: Math.round((call / totalCalls) * 70),
              total_parsed: jobs.length,
            });
          }
          await sleep(PAGE_DELAY_MS);
        }
      }
    }

    const leads = buildCompanyLeads(jobs).slice(0, MAX_RESULT_ROWS);
    log('info', `job ${jobId}: ${leads.length} companies from ${jobs.length} jobs (${excluded} agency-filtered)`);

    // Enrich domains for the top companies (capped — thousands × Clearbit is slow).
    await setProgress({ progress_stage: 'enriching', progress_percent: 72, total_found: leads.length });
    if (enrich) {
      const cache = new Map<string, string>();
      const enrichCount = Math.min(leads.length, ENRICH_CAP);
      for (let i = 0; i < enrichCount; i += 1) {
        const lead = leads[i];
        const key = lead.company.toLowerCase();
        if (cache.has(key)) {
          lead.domain = cache.get(key);
        } else {
          lead.domain = await clearbitDomain(lead.company);
          cache.set(key, lead.domain);
          await sleep(ENRICH_DELAY_MS);
        }
        if ((i + 1) % 25 === 0 || i === enrichCount - 1) {
          await ensureNotCancelled();
          await setProgress({ progress_percent: 72 + Math.round(((i + 1) / enrichCount) * 22) });
        }
      }
    }

    await setProgress({ progress_stage: 'saving', progress_percent: 96 });
    await db.from('adzuna_companies').delete().eq('job_id', jobId);
    const rows = leads.map((l) => ({
      job_id: jobId,
      company: l.company,
      company_key: companyDedupKey(l.company),
      domain: l.domain || null,
      country: l.country || null,
      cities: l.cities,
      roles_found: l.roles_found,
      job_count: l.job_count,
      job_titles: l.job_titles,
      job_urls: l.job_urls,
      queries: l.queries,
      latest_posted_at: l.latest_posted_at || null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await db
        .from('adzuna_companies')
        .upsert(batch, { onConflict: 'job_id,country,company_key' });
      if (error) throw new Error(`save failed: ${error.message}`);
    }

    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: leads.length,
      total_parsed: leads.length,
      completed_at: new Date().toISOString(),
      error_message: null,
    });
    log('info', `job ${jobId} completed: ${leads.length} companies`);
  } catch (err) {
    if (err instanceof JobCancelledError) {
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
