// Server-side runner for the ATS parser (Greenhouse / Lever / Ashby).
// Worker-only: invoked from worker/hh.ts. Reuses the pure functions in
// lib/jobs/atsCompanyParser.js and writes progress to parser_jobs + results to
// ats_companies. Company-token lists come live from the open-source
// kalil0321/ats-scrapers dataset (MIT).

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  postingsUrl,
  extractJobs,
  normalizeJob,
  parseCompanyCsv,
  buildCompanyLeads,
  domainFromJobUrls,
  type AtsNormalizedJob,
} from '@/lib/jobs/atsCompanyParser';
import { buildRolesRegex, buildCountryRegex } from '@/lib/parsers/atsFilters';
import { resolveCompanyDomainByName } from '@/lib/parsers/companyDomainResolver';
import {
  fenceParserJobQuery,
  requestSignal,
  sleepUnlessAborted,
  type ParserJobRunContext,
} from '@/lib/parsers/parserJobContext';
import type { AtsSearchConfig } from '@/types';

const TOKENS_BASE =
  'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
const UA = 'PortalAtsParser/1.0 (+https://wemd.io)';
const REQUEST_TIMEOUT_MS = 15_000;
const SUPPORTED = ['greenhouse', 'lever', 'ashby'];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000; // safety cap per ATS
const MAX_RESULT_ROWS = 5_000; // cap stored companies
const SCAN_DELAY_MS = 120;
const ENRICH_DELAY_MS = 200;

function log(level: 'info' | 'error', msg: string, extra?: unknown) {
  const line = `[ats-runner][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

class JobCancelledError extends Error {}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: requestSignal(REQUEST_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: requestSignal(REQUEST_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 02.09.2026 — единый жизненный цикл задач (app/src/lib/jobs/lifecycle.ts).
 * С контекстом: записи в строку задачи ограждены жетоном захвата, паузы и
 * сетевые запросы слушают сигнал остановки, а на остановке функция выходит без
 * терминальной записи — задачу целиком переиграет следующая реплика (курсора у
 * очереди нет, см. app/worker/parserJobs.ts). Без контекста — как было.
 */
export async function runAtsParserJob(jobId: string, ctx?: ParserJobRunContext): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    log('error', 'supabaseAdmin not configured');
    return;
  }

  const setProgress = (patch: Record<string, unknown>) =>
    fenceParserJobQuery(db.from('parser_jobs').update(patch).eq('id', jobId), ctx);

  const sleep = (ms: number) => sleepUnlessAborted(ms, ctx?.signal);

  const ensureNotCancelled = async () => {
    // Остановка воркера — тот же выход, что и отмена пользователем: бросаем
    // JobCancelledError и не пишем терминальный статус. Кто именно нас
    // остановил, решает вызывающий по ctx.signal.aborted.
    if (ctx?.signal.aborted) throw new JobCancelledError();
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
    const rolesRe = buildRolesRegex(config.text);
    const countryRe = buildCountryRegex(config.countries);
    const withinDays = Number(config.posted_within_days ?? 0);
    const cutoffIso =
      withinDays > 0 ? new Date(Date.now() - withinDays * 86_400_000).toISOString() : null;
    const matches = (j: AtsNormalizedJob): boolean => {
      if (!rolesRe.test(j.title)) return false;
      if (countryRe && !countryRe.test(`${j.location} ${j.country}`)) return false;
      if (cutoffIso && (!j.posted_at || j.posted_at < cutoffIso)) return false;
      return true;
    };

    await setProgress({
      progress_stage: 'loading_companies',
      progress_percent: 0,
      total_found: 0,
      total_parsed: 0,
    });

    // 1) Load company-token lists.
    const companies: Array<{ ats: string; name: string; slug: string }> = [];
    for (const ats of finalAts) {
      await ensureNotCancelled();
      const csv = await fetchText(`${TOKENS_BASE}/${ats}.csv`, ctx?.signal);
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
        const payload = await fetchJson(postingsUrl(c.ats, c.slug), ctx?.signal);
        for (const raw of extractJobs(c.ats, payload)) {
          const norm = normalizeJob(c.ats, raw, { slug: c.slug, companyName: c.name });
          if (norm && matches(norm)) jobs.push(norm);
        }
      } catch {
        /* board moved off ATS, private, or rate-limited — skip */
      }
      // Прерванный запрос попадает в тот же catch, что и мёртвый борд, поэтому
      // остановку проверяем ЗДЕСЬ, а не полагаемся на исключение: иначе воркер
      // на стопе молотил бы оставшиеся тысячи бордов вхолостую.
      if (ctx?.signal.aborted) throw new JobCancelledError();
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
      if (ctx?.signal.aborted) throw new JobCancelledError();
      const lead = leads[i];
      lead.domain = domainFromJobUrls(lead.job_urls);
      if (!lead.domain && enrich) {
        lead.domain = await resolveCompanyDomainByName(lead.company);
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
    //
    // Единственная запись этого раннера, которую НЕЛЬЗЯ оградить жетоном:
    // строки чужой таблицы, у них нет run_token. И она не идемпотентна по
    // отношению к соседу: shutdown() библиотеки отпускает аренду, не дожидаясь
    // конца тела (это её контракт), поэтому новый владелец может начать задачу,
    // пока старое тело ещё доигрывает. Если старое тело попадёт в этот delete
    // внутри такого окна, оно снесёт строки, которые новый владелец уже
    // записал. Терпим осознанно: окно ограничено сроком остановки контейнера
    // (docker stop --timeout 15), а новый владелец идёт задачу с нуля и
    // допишет всё заново. Та же форма у ENG-найма (saveResults чистит
    // eng_hiring_vacancies перед записью); у HH-парсера её нет — он только
    // upsert'ит.
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
    // Судим по СОСТОЯНИЮ СИГНАЛА, а не по типу ошибки: остановка воркера может
    // прилететь и прерванным fetch'ем, и JobCancelledError, а чужой AbortError
    // по таймауту обязан остаться настоящей ошибкой. Терминальный статус на
    // остановке не пишем — строку с живой арендой отпустит библиотека.
    if (ctx?.signal.aborted) {
      log('info', `job ${jobId} stopped mid-run — leaving it for reclaim`);
      return;
    }
    if (err instanceof JobCancelledError) {
      log('info', `job ${jobId} cancelled`);
      return; // status already changed by the canceller
    }
    log('error', `job ${jobId} failed`, err);
    await setProgress({
      status: 'failed',
      progress_stage: 'failed',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
