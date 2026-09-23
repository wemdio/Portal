/**
 * Раннер английского аутрича v2 (parser_type='polza_outreach').
 *
 * Флоу CEO (en-outreach-flow-improvements, 23.09.2026):
 *   компания → fit → поводы → данные → Lead Score → кейс → угол → цепочка.
 *
 * S1 кандидаты: вакансии sales/GTM + стартапы YC, склейка по домену/названию;
 * S2 домен, размер/отрасль/страна из PDL; S3 жёсткие отсевы; S4 сайт, разбор
 * вакансии, поводы, Lead Score и статус; S5 почта — только у write now,
 * от сильных к слабым; S6 четыре письма и гарды.
 *
 * Лимит считает ГОТОВЫЕ компании; кандидатов раннер берёт волнами, пока не
 * наберёт или пока не кончится пул. Отсеянные строки остаются с причиной —
 * по ним считается воронка. Ошибка одной компании не валит запуск.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { analyzeVacancy } from './analyzeVacancy';
import { buildLetters, displayName, guardLetters, SEQUENCE_ID, triggerPhrase } from './buildLetters';
import { loadEnCases, routeEnCase, type EnCase } from './caseRouter';
import { findCompanyEmail } from './findEmail';
import { icpFilter } from './icpFilter';
import { employeesFromBucket, leadStatus, primaryTrigger, scoreLead, type LeadScore, type Trigger } from './leadScore';
import { lookupPdlProfile, normalizeDomain, PDL_COUNTRY_BY_CODE, resolveCompanyDomain } from './resolveDomain';
import { selectVacancies } from './selectVacancies';
import { buildSiteProfile, EMPTY_PROFILE, type SiteProfile } from './siteProfile';
import { POLZA_OUTREACH_STAGES as ST, sanitizePolzaOutreachConfig, type PolzaOutreachConfig, type PolzaOutreachVacancyCandidate } from './types';
import { loadYcCompanies, type YcCompany } from './ycCandidates';

const ENRICH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.POLZA_OUTREACH_LLM_CONCURRENCY ?? '4')));
const EMAIL_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.POLZA_OUTREACH_EMAIL_CONCURRENCY ?? '5')));
const DB_CHUNK = 100;
const MIN_WAVE = 25;
const MAX_WAVE = 250;
const BLIND_YIELD_GUESS = 0.12;
const LAUNCH_MAX_AGE_DAYS = 180;
const DAY = 86_400_000;

class PolzaOutreachCancelledError extends Error {}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[polza-outreach][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

/** Общий потолок просмотренных кандидатов — страховка от бесконечного прогона. */
export function maxCandidatesFor(target: number): number {
  return Math.min(4000, Math.max(300, target * 25));
}

export function nextWaveSize(target: number, totals: { vacancies: number; ready: number }): number {
  const missing = Math.max(1, target - totals.ready);
  const yieldRate = totals.vacancies > 0 && totals.ready > 0 ? totals.ready / totals.vacancies : BLIND_YIELD_GUESS;
  return Math.max(MIN_WAVE, Math.min(MAX_WAVE, Math.ceil(missing / Math.max(0.02, yieldRate))));
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await worker(item);
      }
    }),
  );
}

/** Кандидат после склейки источников: одна компания — одна карточка. */
interface Candidate {
  companyName: string;
  vacancy: PolzaOutreachVacancyCandidate | null;
  yc: YcCompany | null;
}

function nameKey(name: string): string {
  return displayName(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const COUNTRY_CODE_BY_NAME = Object.fromEntries(Object.entries(PDL_COUNTRY_BY_CODE).map(([code, name]) => [name, code]));

function mergeCandidates(vacancies: PolzaOutreachVacancyCandidate[], ycs: YcCompany[]): Candidate[] {
  const ycByDomain = new Map(ycs.map((y) => [y.domain, y]));
  const ycByName = new Map(ycs.map((y) => [nameKey(y.name), y]));
  const usedYc = new Set<YcCompany>();
  const both: Candidate[] = [];
  const hiringOnly: Candidate[] = [];
  for (const v of vacancies) {
    const domain = normalizeDomain(String(v.companySiteUrl ?? ''));
    const yc = (domain && ycByDomain.get(domain)) || ycByName.get(nameKey(v.companyName)) || null;
    if (yc && !usedYc.has(yc)) {
      usedYc.add(yc);
      both.push({ companyName: v.companyName, vacancy: v, yc });
    } else {
      hiringOnly.push({ companyName: v.companyName, vacancy: v, yc: null });
    }
  }
  const ycOnly = ycs.filter((y) => !usedYc.has(y)).map((y) => ({ companyName: y.name, vacancy: null, yc: y }));
  // Два сильных повода сразу — первыми: это прямой путь к write now.
  return [...both, ...hiringOnly, ...ycOnly];
}

interface Totals {
  vacancies: number;
  domainFound: number;
  icpPassed: number;
  writeNow: number;
  emailFound: number;
  ready: number;
}

interface Qualified {
  id: string;
  c: Candidate;
  domain: string;
  website: string;
  site: SiteProfile;
  triggers: Trigger[];
  score: LeadScore;
  scoreInput: Parameters<typeof scoreLead>[0];
  caseHit: EnCase | null;
  caseReason: string | null;
}

export async function runPolzaOutreachJob(jobId: string): Promise<void> {
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
    if (!data || data.status !== 'running') throw new PolzaOutreachCancelledError();
  };
  const updateRow = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await db
      .from('polza_outreach_companies')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) log('warn', `row update failed (${id})`, error);
  };

  try {
    const { data: job, error: jobErr } = await db.from('parser_jobs').select('config,status').eq('id', jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');

    const config: PolzaOutreachConfig = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);
    const target = config.limit;
    const maxCandidates = maxCandidatesFor(target);
    const thresholds = { write: config.write_threshold, review: config.review_threshold };

    await setProgress({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'selecting_vacancies',
      progress_percent: 1,
      total_found: 0,
      total_parsed: 0,
    });
    // Повторный прогон (recover после падения воркера) — с чистого листа.
    await db.from('polza_outreach_companies').delete().eq('job_id', jobId);

    // ── S1: пул кандидатов ──
    const vacancies = config.sources.includes('hiring')
      ? (await selectVacancies(db, config, { want: maxCandidates })).candidates
      : [];
    const ycs = config.sources.includes('yc') ? await loadYcCompanies(db, config) : [];
    const pool = mergeCandidates(vacancies, ycs);
    const cases = await loadEnCases(db);
    log('info', `job ${jobId}: pool=${pool.length} (hiring=${vacancies.length}, yc=${ycs.length}), cases=${cases.length}, target=${target}`);

    const totals: Totals = { vacancies: 0, domainFound: 0, icpPassed: 0, writeNow: 0, emailFound: 0, ready: 0 };
    const seenDomains = new Set<string>();
    let cursor = 0;
    let waveNo = 0;

    const funnelOf = () => ({
      vacancies: totals.vacancies,
      domain_found: totals.domainFound,
      icp_passed: totals.icpPassed,
      geo_confirmed: totals.writeNow,
      email_found: totals.emailFound,
      ready: totals.ready,
    });
    const publish = async (stage: string, extra: Record<string, unknown> = {}) => {
      await setProgress({
        progress_stage: stage,
        progress_percent: Math.min(97, 5 + Math.round(90 * Math.max(totals.ready / target, Math.min(1, totals.vacancies / maxCandidates)))),
        total_found: totals.vacancies,
        total_parsed: totals.ready,
        progress_detail: { wave: waveNo, target, pool: pool.length, scanned: totals.vacancies, ready: totals.ready, funnel: funnelOf(), ...extra },
      });
    };

    // ── S2–S4 для одной компании ──
    const qualify = async (id: string, c: Candidate): Promise<Qualified | null> => {
      const exclude = async (stage: string, reason: string, patch: Record<string, unknown> = {}) => {
        await updateRow(id, { ...patch, status: 'excluded', stage, exclusion_reason: reason, lead_status: 'skip' });
        return null;
      };

      // S2 домен
      let domain: string | null = c.yc?.domain ?? null;
      let website: string | null = c.yc?.website ?? null;
      if (!domain && c.vacancy) {
        const res = await resolveCompanyDomain(db, c.companyName, c.vacancy.jobCountryCode, c.vacancy.companySiteUrl);
        domain = res.normalizedDomain;
        website = res.companyWebsite;
      }
      if (!domain || !website) return exclude(ST.s2Domain, 'domain_not_resolved');
      totals.domainFound += 1;
      const pdl = await lookupPdlProfile(db, c.companyName, domain);
      const employees = c.yc?.teamSize ?? employeesFromBucket(pdl.size);
      const countryName = c.yc?.country ?? pdl.country ?? null;
      const countryCode = c.vacancy?.jobCountryCode || (countryName ? COUNTRY_CODE_BY_NAME[countryName.toLowerCase()] ?? null : null);
      const base = {
        normalized_domain: domain,
        company_website: website,
        employee_range: c.yc?.teamSize != null ? String(c.yc.teamSize) : pdl.size,
        industry: pdl.industry ?? c.yc?.industry ?? null,
        country: countryName,
      };
      await updateRow(id, { ...base, status: 'normalized', stage: ST.s2Domain });

      // S3 жёсткие отсевы
      const icp = icpFilter(
        {
          companyName: c.companyName,
          companyDescription: c.vacancy?.companyDescription ?? c.yc?.description ?? null,
          vacancyDescription: c.vacancy?.vacancyDescription ?? null,
          normalizedDomain: domain,
          employees,
          minEmployees: config.min_employees,
          maxEmployees: config.max_employees,
        },
        seenDomains,
      );
      if (icp.exclude) return exclude(ST.s3Icp, icp.reason ?? 'icp');
      totals.icpPassed += 1;

      // S4 сайт, вакансия, поводы, скоринг
      const site = await buildSiteProfile(website, c.yc?.description ?? c.vacancy?.companyDescription ?? null).catch((err) => {
        log('warn', `site profile failed for ${domain}`, err instanceof Error ? err.message : err);
        return EMPTY_PROFILE;
      });
      if (!site.reachable) return exclude(ST.s4Analyzed, 'site_unreachable');
      if (site.exclusion) {
        const map: Record<string, string> = {
          staffing: 'staffing_agency', job_board: 'staffing_agency', lead_gen_agency: 'competitor',
          marketing_agency: 'generic_marketing', b2c: 'b2c_or_education', local_service: 'b2c_or_education', course: 'b2c_or_education',
        };
        return exclude(ST.s4Analyzed, map[site.exclusion] ?? 'b2c_or_education', { company_context: site.companyContext });
      }

      const triggers: Trigger[] = [];
      let analysisPatch: Record<string, unknown> = {};
      if (c.vacancy) {
        const analysis = await analyzeVacancy({
          jobTitle: c.vacancy.jobTitle,
          vacancyDescription: c.vacancy.vacancyDescription,
          companyName: c.companyName,
          countryCode: c.vacancy.jobCountryCode,
        });
        analysisPatch = {
          outbound_mandate: analysis.outbound_mandate,
          outbound_evidence: analysis.outbound_evidence || null,
          service_line: analysis.service_line,
          target_sales_geo: analysis.target_sales_geo,
          target_sales_geo_evidence: analysis.target_sales_geo_evidence || null,
          target_sales_geo_confidence: analysis.target_sales_geo_confidence,
        };
        if (analysis.is_lead_gen_agency) return exclude(ST.s4Analyzed, 'competitor', analysisPatch);
        if (analysis.outbound_mandate) {
          triggers.push({ type: 'hiring', title: c.vacancy.jobTitle, url: c.vacancy.jobSourceUrl, date: c.vacancy.jobPublishedAt, quote: analysis.outbound_evidence || null });
        }
      }
      if (c.yc) triggers.push({ type: 'yc', title: c.yc.batch, url: c.yc.sourceUrl, date: null, quote: null });
      if (site.launch && site.launch.date && Date.now() - new Date(site.launch.date).getTime() <= LAUNCH_MAX_AGE_DAYS * DAY) {
        triggers.push({ type: 'launch', title: site.launch.quote, url: site.launch.url, date: site.launch.date, quote: site.launch.quote });
      }
      if (site.techStack.length) triggers.push({ type: 'tech_stack', title: site.techStack.join(', '), url: website, date: null, quote: null });

      const isB2b = site.isB2b || c.yc?.industry === 'b2b';
      const common = {
        ...analysisPatch,
        source_list: [c.vacancy ? 'hiring' : null, c.yc ? 'yc' : null].filter(Boolean),
        trigger_list: triggers,
        company_context: site.companyContext,
        likely_gtm_problem: site.likelyGtmProblem,
        outreach_angle: site.outreachAngle,
        segments: site.segments,
      };
      if (!isB2b) return exclude(ST.s4Analyzed, 'not_b2b', common);
      if (!triggers.length) return exclude(ST.s4Analyzed, 'no_trigger', common);

      const scoreInput = {
        isB2b,
        businessModel: site.businessModel,
        icpClear: Boolean(site.icpQuote),
        highValue: site.highValue,
        excluded: false,
        employees,
        countryCode,
        triggers,
        hasSite: true,
        hasEmail: true, // до поиска почты — оптимистично: ищем её только у прошедших
        hasDescription: site.hasDescription,
      };
      const score = scoreLead(scoreInput);
      const status = leadStatus(score.total, thresholds);
      const primary = primaryTrigger(triggers);
      const routed = routeEnCase(cases, site.industryGroup);
      const patch = {
        ...common,
        primary_trigger: primary?.type ?? null,
        trigger_evidence_url: primary?.url ?? null,
        trigger_phrase: triggerPhrase(displayName(c.companyName), primary),
        lead_score: score.total,
        score_breakdown: score.breakdown,
        data_quality_score: score.dataQuality,
        lead_status: status,
        recommended_case: routed?.record.caseId ?? null,
        case_reason: routed?.reason ?? null,
        case_snippet: routed?.record.snippet ?? null,
        cta_type: 'route',
      };
      if (status === 'skip') return exclude(ST.s4Analyzed, 'low_score', patch);
      if (status === 'manual_check') {
        await updateRow(id, { ...patch, status: 'needs_review', stage: ST.s4Analyzed, review_reason: 'manual_check' });
        return null;
      }
      totals.writeNow += 1;
      await updateRow(id, { ...patch, status: 'qualified', stage: ST.s4Analyzed });
      return { id, c, domain, website, site, triggers, score, scoreInput, caseHit: routed?.record ?? null, caseReason: routed?.reason ?? null };
    };

    // ── S5–S6 для одной компании ──
    const finalize = async (q: Qualified) => {
      if (totals.ready >= target) {
        await updateRow(q.id, { status: 'needs_review', review_reason: 'limit_reached' });
        return;
      }
      const email = await findCompanyEmail(q.website, q.domain);
      if (!email.email) {
        const score = scoreLead({ ...q.scoreInput, hasEmail: false });
        await updateRow(q.id, {
          status: 'needs_review',
          stage: ST.s5Email,
          review_reason: 'no_corporate_email',
          lead_score: score.total,
          score_breakdown: score.breakdown,
          data_quality_score: score.dataQuality,
          lead_status: 'manual_check',
        });
        return;
      }
      totals.emailFound += 1;
      await updateRow(q.id, {
        selected_company_email: email.email,
        email_type: email.emailType,
        email_source_url: email.emailSourceUrl,
        stage: ST.s5Email,
      });

      const company = displayName(q.c.companyName);
      const primary = primaryTrigger(q.triggers);
      const letters = buildLetters({ company, trigger: primary, caseHit: q.caseHit, segments: q.site.segments });
      const allowedFacts = [company, ...q.triggers.map((t) => t.title), ...(q.caseHit ? [q.caseHit.snippet, q.caseHit.segment] : [])];
      const guard = guardLetters(letters, allowedFacts);
      if (!guard.ok) {
        await updateRow(q.id, {
          status: 'needs_review',
          stage: ST.s6Letters,
          sequence_id: SEQUENCE_ID,
          letters,
          review_reason: `letter_guard_failed: ${guard.violations[0] ?? 'unknown'}`,
        });
        log('warn', `S6 guard failed for ${company}`, guard.violations);
        return;
      }
      if (totals.ready >= target) {
        await updateRow(q.id, { status: 'needs_review', review_reason: 'limit_reached', letters, sequence_id: SEQUENCE_ID });
        return;
      }
      totals.ready += 1;
      await updateRow(q.id, { status: 'ready', stage: ST.s6Letters, sequence_id: SEQUENCE_ID, letters });
    };

    const safely = async (id: string, stage: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof PolzaOutreachCancelledError) throw err;
        await updateRow(id, { status: 'failed', stage, review_reason: err instanceof Error ? err.message.slice(0, 500) : 'failed' });
      }
    };

    while (totals.ready < target && cursor < pool.length && totals.vacancies < maxCandidates) {
      await ensureNotCancelled();
      waveNo += 1;
      const want = Math.min(nextWaveSize(target, totals), maxCandidates - totals.vacancies);
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;

      const ids: string[] = [];
      for (let i = 0; i < wave.length; i += DB_CHUNK) {
        const { data, error } = await db
          .from('polza_outreach_companies')
          .insert(
            wave.slice(i, i + DB_CHUNK).map((c) => ({
              job_id: jobId,
              source_type: c.vacancy && c.yc ? 'hiring+yc' : c.vacancy ? 'hiring' : 'yc',
              vacancy_id: c.vacancy?.vacancyId ?? null,
              job_title: c.vacancy?.jobTitle ?? null,
              job_source_url: c.vacancy?.jobSourceUrl ?? c.yc?.sourceUrl ?? null,
              job_country_code: c.vacancy?.jobCountryCode ?? null,
              job_published_at: c.vacancy?.jobPublishedAt ?? null,
              company_name: c.companyName,
              status: 'discovered',
              stage: ST.s1Selected,
            })),
          )
          .select('id');
        if (error) throw new Error(`polza outreach S1 insert failed: ${error.message}`);
        for (const r of data ?? []) ids.push(String(r.id));
      }
      totals.vacancies += wave.length;
      await publish('analyzing_vacancies', { wave_size: wave.length });
      log('info', `wave ${waveNo}: ${wave.length} candidates (ready ${totals.ready}/${target})`);

      const qualified: Qualified[] = [];
      let done = 0;
      await runPool(wave.map((c, i) => ({ c, id: ids[i] })).filter((x) => x.id), ENRICH_CONCURRENCY, async ({ c, id }) => {
        await ensureNotCancelled();
        await safely(id, ST.s4Analyzed, async () => {
          const q = await qualify(id, c);
          if (q) qualified.push(q);
        });
        done += 1;
        if (done % 10 === 0) await publish('analyzing_vacancies');
      });

      // Почта — только у write now, от самых сильных к слабым.
      qualified.sort((a, b) => b.score.total - a.score.total);
      await publish('finding_emails', { write_now: qualified.length });
      await runPool(qualified, EMAIL_CONCURRENCY, async (q) => {
        await ensureNotCancelled();
        await safely(q.id, ST.s5Email, () => finalize(q));
      });
      await publish('building_letters');
    }

    const stopReason = totals.ready >= target ? 'target_reached' : totals.vacancies >= maxCandidates ? 'scan_limit' : 'pool_exhausted';
    log('info', `job ${jobId} done: ${JSON.stringify(funnelOf())} (${stopReason})`);
    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totals.vacancies,
      total_parsed: totals.ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: { wave: waveNo, target, pool: pool.length, scanned: totals.vacancies, ready: totals.ready, stop_reason: stopReason, funnel: funnelOf() },
    });
  } catch (err) {
    if (err instanceof PolzaOutreachCancelledError) {
      log('info', `job ${jobId} cancelled`);
      return;
    }
    log('error', `job ${jobId} failed`, err);
    await db
      .from('parser_jobs')
      .update({ status: 'failed', progress_stage: 'failed', completed_at: new Date().toISOString(), error_message: err instanceof Error ? err.message : 'Unknown error' })
      .eq('id', jobId);
  }
}
