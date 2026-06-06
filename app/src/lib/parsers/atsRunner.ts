// Server-side runner for the ATS parser (Greenhouse / Lever / Ashby).
// Worker-only: invoked from worker/hh.ts. Reuses the pure functions in
// lib/jobs/atsCompanyParser.js and writes progress to parser_jobs + results to
// ats_companies. Company-token lists come live from the open-source
// kalil0321/ats-scrapers dataset (MIT).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  postingsUrl,
  extractJobs,
  normalizeJob,
  parseCompanyCsv,
  buildCompanyLeads,
  domainFromJobUrls,
  pickDomainFromSuggestions,
  type AtsNormalizedJob,
} from '@/lib/jobs/atsCompanyParser';
import { resolveAtsMatch } from '@/lib/parsers/atsNiches';
import type { AtsSearchConfig } from '@/types';

const execFileP = promisify(execFile);

const TOKENS_BASE =
  'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
const CLEARBIT_SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest';
const UA = 'PortalAtsParser/1.0 (+https://wemd.io)';
const REQUEST_TIMEOUT_MS = 15_000;
const SUPPORTED = ['greenhouse', 'lever', 'ashby'];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000; // safety cap per ATS
const MAX_RESULT_ROWS = 5_000; // cap stored companies
const SCAN_DELAY_MS = 120;
const ENRICH_DELAY_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(level: 'info' | 'error', msg: string, extra?: unknown) {
  const line = `[ats-runner][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

class JobCancelledError extends Error {}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Clearbit's WAF blocks node/undici by TLS fingerprint but lets curl through.
async function clearbitDomain(name: string): Promise<string> {
  const url = `${CLEARBIT_SUGGEST}?query=${encodeURIComponent(name)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await execFileP(
        'curl',
        ['-sS', '--max-time', '15', '-H', 'Accept: application/json', url],
        { timeout: 20_000, maxBuffer: 1024 * 1024 },
      );
      const domain = pickDomainFromSuggestions(name, JSON.parse(stdout));
      if (domain) return domain;
    } catch {
      /* transient curl/parse failure — retry once */
    }
    if (attempt === 0) await sleep(400);
  }
  return '';
}

function titleRegex(config: AtsSearchConfig): RegExp {
  try {
    return new RegExp(resolveAtsMatch(config.niche, config.match), 'i');
  } catch {
    return /.*/;
  }
}

export async function runAtsParserJob(jobId: string): Promise<void> {
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
    const { data: job, error: jobErr } = await db
      .from('parser_jobs')
      .select('config,status')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');

    const config = (job.config ?? {}) as AtsSearchConfig;
    const atsList = (Array.isArray(config.ats) ? config.ats : [])
      .map((a) => String(a).toLowerCase())
      .filter((a) => SUPPORTED.includes(a));
    const finalAts = atsList.length ? atsList : [...SUPPORTED];
    const limit = Math.min(MAX_LIMIT, Math.max(0, Number(config.companies_limit ?? DEFAULT_LIMIT)));
    const enrich = config.enrich !== false;
    const re = titleRegex(config);

    await setProgress({
      progress_stage: 'loading_companies',
      progress_percent: 0,
      total_found: 0,
      total_parsed: 0,
    });

    // 1) Load company-token lists.
    const companies: Array<{ ats: string; name: string; slug: string }> = [];
    for (const ats of finalAts) {
      const csv = await fetchText(`${TOKENS_BASE}/${ats}.csv`);
      let toks = parseCompanyCsv(csv);
      if (limit > 0) toks = toks.slice(0, limit);
      for (const t of toks) companies.push({ ats, name: t.name, slug: t.slug });
    }
    const totalCompanies = companies.length;
    await setProgress({ progress_stage: 'scanning', total_found: totalCompanies, progress_percent: 0 });

    // 2) Scan each company's board for matching roles.
    const jobs: AtsNormalizedJob[] = [];
    for (let i = 0; i < companies.length; i += 1) {
      const c = companies[i];
      try {
        const payload = await fetchJson(postingsUrl(c.ats, c.slug));
        for (const raw of extractJobs(c.ats, payload)) {
          const norm = normalizeJob(c.ats, raw, { slug: c.slug, companyName: c.name });
          if (norm && re.test(norm.title)) jobs.push(norm);
        }
      } catch {
        /* board moved off ATS, private, or rate-limited — skip */
      }
      if ((i + 1) % 25 === 0 || i === companies.length - 1) {
        await ensureNotCancelled();
        await setProgress({
          // scanning occupies 0..80% of the bar
          progress_percent: totalCompanies ? Math.round(((i + 1) / totalCompanies) * 80) : 80,
          total_parsed: jobs.length,
        });
      }
      await sleep(SCAN_DELAY_MS);
    }

    // 3) Aggregate to company leads.
    const leads = buildCompanyLeads(jobs).slice(0, MAX_RESULT_ROWS);

    // 4) Resolve domains (free from careers URL, then Clearbit fallback).
    await setProgress({ progress_stage: 'enriching', progress_percent: 82 });
    for (let i = 0; i < leads.length; i += 1) {
      const lead = leads[i];
      lead.domain = domainFromJobUrls(lead.job_urls);
      if (!lead.domain && enrich) {
        lead.domain = await clearbitDomain(lead.company);
        await sleep(ENRICH_DELAY_MS);
      }
      if ((i + 1) % 20 === 0 || i === leads.length - 1) {
        await ensureNotCancelled();
        await setProgress({
          // enriching occupies 82..95%
          progress_percent: 82 + Math.round(((i + 1) / Math.max(1, leads.length)) * 13),
        });
      }
    }

    // 5) Persist (idempotent: clear prior rows for this job, then upsert).
    await setProgress({ progress_stage: 'saving', progress_percent: 96 });
    await db.from('ats_companies').delete().eq('job_id', jobId);
    const rows = leads.map((l) => ({
      job_id: jobId,
      company: l.company,
      domain: l.domain || null,
      ats: l.ats,
      slug: l.slug,
      country: l.country || null,
      cities: l.cities,
      roles_found: l.roles_found,
      job_count: l.job_count,
      job_titles: l.job_titles,
      job_urls: l.job_urls,
      careers_url: l.careers_url || null,
      latest_posted_at: l.latest_posted_at || null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await db.from('ats_companies').upsert(batch, { onConflict: 'job_id,ats,slug' });
      if (error) throw new Error(`save failed: ${error.message}`);
    }

    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totalCompanies,
      total_parsed: leads.length,
      completed_at: new Date().toISOString(),
      error_message: null,
    });
    log('info', `job ${jobId} completed: ${leads.length} companies from ${totalCompanies} scanned`);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      log('info', `job ${jobId} cancelled`);
      return; // status already changed by the canceller
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
