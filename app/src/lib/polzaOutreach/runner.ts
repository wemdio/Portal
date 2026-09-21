/**
 * Раннер задачи polza_outreach: последовательно S1..S6, после каждой стадии
 * обновляет parser_jobs.progress_stage и progress_percent, чтобы в UI крутился
 * прогресс. Ошибка одной компании не валит задачу: status='failed' в строку —
 * и дальше. Отсеянные строки остаются в таблице с причиной — по ним считается
 * воронка.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { selectVacancies } from './selectVacancies';
import { resolveCompanyDomain } from './resolveDomain';
import { icpFilter } from './icpFilter';
import { analyzeVacancy } from './analyzeVacancy';
import { findCompanyEmail } from './findEmail';
import { buildLetters, guardLetters } from './buildLetters';
import {
  POLZA_OUTREACH_STAGES,
  sanitizePolzaOutreachConfig,
  type PolzaOutreachConfig,
  type PolzaOutreachVacancyCandidate,
  type PolzaVacancyAnalysis,
} from './types';

const SEQUENCE_ID = 'sdr_hiring_trigger';

const LLM_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.POLZA_OUTREACH_LLM_CONCURRENCY ?? '4')));
const EMAIL_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.POLZA_OUTREACH_EMAIL_CONCURRENCY ?? '5')));
const DB_CHUNK = 100;

class PolzaOutreachCancelledError extends Error {}

type Row = {
  id: string;
  candidate: PolzaOutreachVacancyCandidate;
  normalizedDomain: string | null;
  companyWebsite: string | null;
  companySize: string | null;
  analysis: PolzaVacancyAnalysis | null;
  email: string | null;
  emailType: string | null;
  emailSourceUrl: string | null;
  status: string;
  done: boolean;
};

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[polza-outreach][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
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

  // company_name уникален внутри джобы (дедуп S1), связываем вставку и id по нему.
  const rowByCompanyKey = new Map<string, string>();

  const insertRows = async (rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += DB_CHUNK) {
      const chunk = rows.slice(i, i + DB_CHUNK);
      const { data, error } = await db.from('polza_outreach_companies').insert(chunk).select('id,company_name');
      if (error) throw new Error(`polza outreach S1 insert failed: ${error.message}`);
      for (const inserted of data ?? []) {
        if (inserted?.id && inserted.company_name) {
          rowByCompanyKey.set(String(inserted.company_name).toLowerCase(), String(inserted.id));
        }
      }
    }
  };

  try {
    const { data: job, error: jobErr } = await db
      .from('parser_jobs')
      .select('config,status')
      .eq('id', jobId)
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');

    const config = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);
    await setProgress({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'selecting_vacancies',
      progress_percent: 1,
      total_found: 0,
      total_parsed: 0,
    });

    // ── S1: выборка вакансий ──
    // Повторный прогон (recover после падения воркера вернул задачу в pending)
    // начинается с чистого листа: старые строки джобы удаляем, иначе дубли
    // сломают воронку. Как и saveResults в eng-hiring.
    await db.from('polza_outreach_companies').delete().eq('job_id', jobId);
    const candidates = await selectVacancies(db, config);
    await ensureNotCancelled();
    await insertRows(
      candidates.map((candidate) => ({
        job_id: jobId,
        source_type: 'sdr_job',
        vacancy_id: candidate.vacancyId,
        job_title: candidate.jobTitle,
        job_source_url: candidate.jobSourceUrl,
        job_country_code: candidate.jobCountryCode,
        job_published_at: candidate.jobPublishedAt,
        company_name: candidate.companyName,
        status: 'discovered',
        stage: POLZA_OUTREACH_STAGES.s1Selected,
      })),
    );
    const rows: Row[] = candidates.map((candidate) => ({
      id: rowByCompanyKey.get(candidate.companyName.toLowerCase()) ?? '',
      candidate,
      normalizedDomain: null,
      companyWebsite: null,
      companySize: null,
      analysis: null,
      email: null,
      emailType: null,
      emailSourceUrl: null,
      status: 'discovered',
      done: false,
    })).filter((row) => row.id);
    await setProgress({
      progress_stage: 'selecting_vacancies',
      progress_percent: 10,
      total_found: rows.length,
      progress_detail: { vacancies: rows.length },
    });
    log('info', `S1: ${rows.length} companies selected`);

    if (rows.length === 0) {
      await setProgress({
        status: 'completed',
        progress_stage: 'completed',
        progress_percent: 100,
        completed_at: new Date().toISOString(),
        error_message: null,
        progress_detail: { funnel: emptyFunnel() },
      });
      return;
    }

    // ── S2 + S3: домен → ICP-фильтр (последовательно: seenDomains требует порядка) ──
    await setProgress({ progress_stage: 'resolving_domains', progress_percent: 12 });
    const seenDomains = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      await ensureNotCancelled();
      const row = rows[i];
      try {
        const domainResult = await resolveCompanyDomain(db, row.candidate.companyName, row.candidate.jobCountryCode);
        if (!domainResult.normalizedDomain) {
          row.status = 'excluded';
          row.done = true;
          await updateRow(row.id, {
            status: 'excluded',
            stage: POLZA_OUTREACH_STAGES.s2Domain,
            exclusion_reason: 'domain_not_resolved',
          });
        } else {
          row.normalizedDomain = domainResult.normalizedDomain;
          row.companyWebsite = domainResult.companyWebsite;
          row.companySize = domainResult.companySize;
          const icp = icpFilter(
            {
              ...row.candidate,
              normalizedDomain: row.normalizedDomain,
              companySize: row.companySize,
            },
            seenDomains,
          );
          if (icp.exclude) {
            row.status = 'excluded';
            row.done = true;
            await updateRow(row.id, {
              normalized_domain: row.normalizedDomain,
              company_website: row.companyWebsite,
              status: 'excluded',
              stage: POLZA_OUTREACH_STAGES.s3Icp,
              exclusion_reason: icp.reason,
            });
          } else {
            row.status = 'normalized';
            await updateRow(row.id, {
              normalized_domain: row.normalizedDomain,
              company_website: row.companyWebsite,
              status: 'normalized',
              stage: POLZA_OUTREACH_STAGES.s3Icp,
            });
          }
        }
      } catch (err) {
        row.status = 'failed';
        row.done = true;
        await updateRow(row.id, {
          status: 'failed',
          stage: POLZA_OUTREACH_STAGES.s2Domain,
          review_reason: err instanceof Error ? err.message : 'domain stage failed',
        });
      }
      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        await setProgress({
          progress_percent: 12 + Math.round(((i + 1) / rows.length) * 18),
          progress_detail: { domains_resolved: i + 1, total: rows.length },
        });
      }
    }
    const domainFound = rows.filter((r) => r.normalizedDomain).length;
    const domainShare = rows.length ? Math.round((domainFound / rows.length) * 100) : 0;
    const icpPassed = rows.filter((r) => !r.done).length;
    log('info', `S2/S3: domain found ${domainFound}/${rows.length} (${domainShare}%), ICP passed ${icpPassed}`);
    // План, шаг 3: доля доменов — цифра для разговора про объёмы; <20% это риск.
    await setProgress({
      progress_detail: {
        domains_resolved: rows.length,
        domain_found: domainFound,
        domain_share_pct: domainShare,
        ...(domainShare < 20 ? { domain_share_warning: 'домен находится менее чем у 20% компаний' } : {}),
      },
    });
    if (domainFound / rows.length < 0.2) {
      log('warn', `S2: домен найден у ${domainFound}/${rows.length} (<20%) — это меняет разговор про объёмы`);
    }

    // ── S4: LLM-разбор вакансии ──
    await setProgress({ progress_stage: 'analyzing_vacancies', progress_percent: 30 });
    const active = rows.filter((r) => !r.done);
    let analyzed = 0;
    await runPool(active, clampInt(process.env.POLZA_OUTREACH_LLM_CONCURRENCY, LLM_CONCURRENCY, 1, 6), async (row) => {
      try {
        const analysis = await analyzeVacancy({
          jobTitle: row.candidate.jobTitle,
          vacancyDescription: row.candidate.vacancyDescription,
          companyName: row.candidate.companyName,
          countryCode: row.candidate.jobCountryCode,
        });
        row.analysis = analysis;
        if (analysis.is_lead_gen_agency) {
          row.status = 'excluded';
          row.done = true;
          await updateRow(row.id, {
            outbound_mandate: analysis.outbound_mandate,
            outbound_evidence: analysis.outbound_evidence,
            service_line: analysis.service_line,
            target_sales_geo: analysis.target_sales_geo,
            target_sales_geo_evidence: analysis.target_sales_geo_evidence,
            target_sales_geo_confidence: analysis.target_sales_geo_confidence,
            status: 'excluded',
            stage: POLZA_OUTREACH_STAGES.s4Analyzed,
            exclusion_reason: 'competitor',
          });
        } else if (!analysis.outbound_mandate) {
          row.status = 'excluded';
          row.done = true;
          await updateRow(row.id, {
            outbound_mandate: false,
            service_line: analysis.service_line,
            target_sales_geo: analysis.target_sales_geo,
            target_sales_geo_evidence: analysis.target_sales_geo_evidence,
            target_sales_geo_confidence: analysis.target_sales_geo_confidence,
            status: 'excluded',
            stage: POLZA_OUTREACH_STAGES.s4Analyzed,
            exclusion_reason: 'no_outbound_mandate',
          });
        } else {
          row.status = 'qualified';
          await updateRow(row.id, {
            outbound_mandate: true,
            outbound_evidence: analysis.outbound_evidence,
            service_line: analysis.service_line,
            target_sales_geo: analysis.target_sales_geo,
            target_sales_geo_evidence: analysis.target_sales_geo_evidence,
            target_sales_geo_confidence: analysis.target_sales_geo_confidence,
            status: 'qualified',
            stage: POLZA_OUTREACH_STAGES.s4Analyzed,
          });
        }
      } catch (err) {
        row.status = 'failed';
        row.done = true;
        await updateRow(row.id, {
          status: 'failed',
          stage: POLZA_OUTREACH_STAGES.s4Analyzed,
          review_reason: err instanceof Error ? err.message : 'LLM analysis failed',
        });
      } finally {
        analyzed += 1;
        if (analyzed % 10 === 0 || analyzed === active.length) {
          await setProgress({
            progress_percent: 30 + Math.round((analyzed / Math.max(1, active.length)) * 30),
            progress_detail: { analyzed_vacancies: analyzed, total: active.length },
          });
        }
      }
    });
    const geoCounts = { high: 0, medium: 0, low: 0 };
    for (const row of rows) {
      if (row.analysis) geoCounts[row.analysis.target_sales_geo_confidence] += 1;
    }
    log('info', `S4: geo confidence high=${geoCounts.high} medium=${geoCounts.medium} low=${geoCounts.low}`);
    await setProgress({
      progress_detail: {
        analyzed_vacancies: analyzed,
        total: active.length,
        geo_confidence: geoCounts,
      },
    });

    // ── S5: корпоративная почта ──
    await ensureNotCancelled();
    await setProgress({ progress_stage: 'finding_emails', progress_percent: 60 });
    const qualified = rows.filter((r) => !r.done);
    let emailed = 0;
    await runPool(qualified, clampInt(process.env.POLZA_OUTREACH_EMAIL_CONCURRENCY, EMAIL_CONCURRENCY, 1, 5), async (row) => {
      try {
        const emailResult = await findCompanyEmail(row.companyWebsite as string, row.normalizedDomain as string);
        row.email = emailResult.email;
        row.emailType = emailResult.emailType;
        row.emailSourceUrl = emailResult.emailSourceUrl;
        if (emailResult.email) {
          await updateRow(row.id, {
            selected_company_email: emailResult.email,
            email_type: emailResult.emailType,
            email_source_url: emailResult.emailSourceUrl,
            stage: POLZA_OUTREACH_STAGES.s5Email,
          });
        } else {
          row.status = 'needs_review';
          row.done = true;
          await updateRow(row.id, {
            status: 'needs_review',
            stage: POLZA_OUTREACH_STAGES.s5Email,
            review_reason: 'no_corporate_email',
          });
        }
      } catch (err) {
        row.status = 'failed';
        row.done = true;
        await updateRow(row.id, {
          status: 'failed',
          stage: POLZA_OUTREACH_STAGES.s5Email,
          review_reason: err instanceof Error ? err.message : 'email stage failed',
        });
      } finally {
        emailed += 1;
        if (emailed % 10 === 0 || emailed === qualified.length) {
          await setProgress({
            progress_percent: 60 + Math.round((emailed / Math.max(1, qualified.length)) * 25),
            progress_detail: { emails_searched: emailed, total: qualified.length },
          });
        }
      }
    });
    const emailFound = rows.filter((r) => r.email).length;
    log('info', `S5: corporate email found ${emailFound}/${qualified.length}`);

    // ── S6: сборка писем + гарды ──
    await ensureNotCancelled();
    await setProgress({ progress_stage: 'building_letters', progress_percent: 85 });
    const withEmail = rows.filter((r) => !r.done && r.email && r.analysis);
    let built = 0;
    for (const row of withEmail) {
      try {
        const letters = buildLetters({
          targetSalesGeo: row.analysis?.target_sales_geo ?? null,
          targetSalesGeoConfidence: row.analysis?.target_sales_geo_confidence ?? null,
          serviceLine: row.analysis?.service_line ?? null,
          serviceLineConfident: row.analysis?.service_line_confident === true,
        });
        const guard = guardLetters(letters);
        if (guard.ok) {
          row.status = 'ready';
          await updateRow(row.id, {
            status: 'ready',
            stage: POLZA_OUTREACH_STAGES.s6Letters,
            sequence_id: SEQUENCE_ID,
            letters,
          });
        } else {
          row.status = 'needs_review';
          row.done = true;
          await updateRow(row.id, {
            status: 'needs_review',
            stage: POLZA_OUTREACH_STAGES.s6Letters,
            sequence_id: SEQUENCE_ID,
            letters,
            review_reason: `letter_guard_failed: ${guard.violations[0] ?? 'unknown'}`,
          });
          log('warn', `S6 guard failed for ${row.candidate.companyName}`, guard.violations);
        }
      } catch (err) {
        row.status = 'failed';
        await updateRow(row.id, {
          status: 'failed',
          stage: POLZA_OUTREACH_STAGES.s6Letters,
          review_reason: err instanceof Error ? err.message : 'letters stage failed',
        });
      }
      built += 1;
      if (built % 10 === 0 || built === withEmail.length) {
        await setProgress({
          progress_percent: 85 + Math.round((built / Math.max(1, withEmail.length)) * 13),
          progress_detail: { letters_built: built, total: withEmail.length },
        });
      }
    }

    const ready = rows.filter((r) => r.status === 'ready').length;
    const geoConfirmed = rows.filter(
      (r) => r.analysis && (r.analysis.target_sales_geo_confidence === 'high' || r.analysis.target_sales_geo_confidence === 'medium'),
    ).length;
    log(
      'info',
      `job ${jobId} done: vacancies=${rows.length} domain=${domainFound} icp=${icpPassed} geo=${geoConfirmed} email=${emailFound} ready=${ready}`,
    );
    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: rows.length,
      total_parsed: ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: {
        funnel: {
          vacancies: rows.length,
          domain_found: domainFound,
          icp_passed: icpPassed,
          geo_confirmed: geoConfirmed,
          email_found: emailFound,
          ready,
        },
        geo_confidence: geoCounts,
      },
    });
  } catch (err) {
    if (err instanceof PolzaOutreachCancelledError) {
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

function emptyFunnel() {
  return {
    vacancies: 0,
    domain_found: 0,
    icp_passed: 0,
    geo_confirmed: 0,
    email_found: 0,
    ready: 0,
  };
}
