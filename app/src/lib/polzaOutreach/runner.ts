/**
 * Раннер задачи polza_outreach: S1..S6 волнами, пока не наберётся заказанное
 * число готовых компаний. После каждой стадии обновляет parser_jobs.progress_*,
 * чтобы в UI крутился прогресс. Ошибка одной компании не валит задачу:
 * status='failed' в строку — и дальше. Отсеянные строки остаются в таблице с
 * причиной — по ним считается воронка.
 *
 * Почему волнами. Раньше «лимит 100» означал «взять сто вакансий», и на выходе
 * получалось столько, сколько доживало до конца конвейера, — на замере
 * 22.09.2026 это две компании из ста. Оператор заказывает не размер выборки, а
 * результат: сто компаний с доменом, почтой и готовой цепочкой, которые можно
 * взять и отправить. Поэтому лимит теперь считает готовые строки, а кандидатов
 * раннер добирает следующими волнами, пока не наберёт нужное или пока кэш
 * вакансий не кончится.
 *
 * Потолок работы всё равно есть: кэш конечен (порядок тысячи компаний за
 * месяц по всем странам), и каждая волна стоит запросов к ИИ и обходов сайтов.
 * Если кэш кончился раньше цели — это не ошибка, а честный ответ «больше
 * вакансий нет», и он виден в сводке запуска.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { selectVacancies } from './selectVacancies';
import { resolveCompanyDomain, type PolzaDomainResolution } from './resolveDomain';
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

/**
 * Поиск домена — это чтение каталога и, в худшем случае, запрос к Clearbit:
 * секунда с лишним на компанию. Последовательно волна из двух сотен компаний
 * простаивала бы минутами, поэтому ищем параллельно, а решение ICP принимаем
 * потом по порядку — дедупу доменов порядок важен, поиску нет.
 */
const DOMAIN_CONCURRENCY = 5;
const LLM_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.POLZA_OUTREACH_LLM_CONCURRENCY ?? '4')));
const EMAIL_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.POLZA_OUTREACH_EMAIL_CONCURRENCY ?? '5')));
const DB_CHUNK = 100;

/** Размер одной волны кандидатов: больше — дольше до первого результата. */
const MIN_WAVE = 25;
const MAX_WAVE = 250;
/**
 * Сколько кандидатов готовы просмотреть ради одной готовой компании, пока не
 * набралась статистика. Первая волна идёт вслепую, дальше размер считается по
 * фактическому выходу.
 */
const BLIND_YIELD_GUESS = 0.15;

class PolzaOutreachCancelledError extends Error {}

type Row = {
  id: string;
  candidate: PolzaOutreachVacancyCandidate;
  normalizedDomain: string | null;
  companyWebsite: string | null;
  companySize: string | null;
  analysis: PolzaVacancyAnalysis | null;
  domain: PolzaDomainResolution | null;
  domainError: string | null;
  email: string | null;
  emailType: string | null;
  emailSourceUrl: string | null;
  status: string;
  done: boolean;
};

interface Totals {
  vacancies: number;
  domainFound: number;
  icpPassed: number;
  geoConfirmed: number;
  emailFound: number;
  ready: number;
}

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

/** Общий потолок просмотренных кандидатов — страховка от бесконечного прогона. */
export function maxCandidatesFor(target: number): number {
  return Math.min(3000, Math.max(300, target * 25));
}

/**
 * Размер следующей волны: сколько кандидатов нужно, чтобы добрать недостающие
 * готовые компании при уже наблюдаемом выходе конвейера.
 */
export function nextWaveSize(target: number, totals: { vacancies: number; ready: number }): number {
  const missing = Math.max(1, target - totals.ready);
  const yieldRate = totals.vacancies > 0 && totals.ready > 0
    ? totals.ready / totals.vacancies
    : BLIND_YIELD_GUESS;
  const needed = Math.ceil(missing / Math.max(0.02, yieldRate));
  return Math.max(MIN_WAVE, Math.min(MAX_WAVE, needed));
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
    const target = config.limit;
    const maxCandidates = maxCandidatesFor(target);

    await setProgress({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'selecting_vacancies',
      progress_percent: 1,
      total_found: 0,
      total_parsed: 0,
    });

    // Повторный прогон (recover после падения воркера вернул задачу в pending)
    // начинается с чистого листа: старые строки джобы удаляем, иначе дубли
    // сломают воронку. Как и saveResults в eng-hiring.
    await db.from('polza_outreach_companies').delete().eq('job_id', jobId);

    const totals: Totals = { vacancies: 0, domainFound: 0, icpPassed: 0, geoConfirmed: 0, emailFound: 0, ready: 0 };
    const geoCounts = { high: 0, medium: 0, low: 0 };
    // Домены и компании живут через все волны: дубль во второй волне — такой же
    // дубль, как и в первой.
    const seenDomains = new Set<string>();
    const seenCompanies = new Set<string>();
    let cacheOffset = 0;
    let poolExhausted = false;
    let waveNo = 0;

    const progressPercent = () =>
      Math.min(
        97,
        5 + Math.round(90 * Math.max(totals.ready / target, Math.min(1, totals.vacancies / maxCandidates))),
      );

    const publishTotals = async (stage: string, extra: Record<string, unknown> = {}) => {
      await setProgress({
        progress_stage: stage,
        progress_percent: progressPercent(),
        total_found: totals.vacancies,
        total_parsed: totals.ready,
        progress_detail: {
          wave: waveNo,
          target,
          scanned: totals.vacancies,
          ready: totals.ready,
          funnel: funnelOf(totals),
          geo_confidence: geoCounts,
          ...extra,
        },
      });
    };

    /** Одна волна: S2 → S3 → S4 → S5 → S6 по своему набору кандидатов. */
    const processWave = async (rows: Row[]) => {
      // ── S2: домен (параллельно) → S3: ICP-фильтр (по порядку — дедуп доменов
      // должен оставлять первую компанию, а не случайную) ──
      await publishTotals('resolving_domains');
      const domainSources: Record<string, number> = {};
      let resolved = 0;
      await runPool(rows, DOMAIN_CONCURRENCY, async (row) => {
        try {
          row.domain = await resolveCompanyDomain(
            db,
            row.candidate.companyName,
            row.candidate.jobCountryCode,
            row.candidate.companySiteUrl,
          );
          if (row.domain.source) {
            domainSources[row.domain.source] = (domainSources[row.domain.source] ?? 0) + 1;
          }
        } catch (err) {
          row.domainError = err instanceof Error ? err.message : 'domain stage failed';
        } finally {
          resolved += 1;
          if (resolved % 10 === 0 || resolved === rows.length) {
            await publishTotals('resolving_domains', { domains_resolved: resolved, wave_total: rows.length });
          }
        }
      });

      for (let i = 0; i < rows.length; i += 1) {
        await ensureNotCancelled();
        const row = rows[i];
        try {
          if (row.domainError) throw new Error(row.domainError);
          const domainResult = row.domain ?? { normalizedDomain: null, companyWebsite: null, companySize: null, source: null };
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
            totals.domainFound += 1;
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
              totals.icpPassed += 1;
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
      }
      await publishTotals('resolving_domains', { domains_resolved: rows.length, wave_total: rows.length });
      log(
        'info',
        `wave ${waveNo} S2/S3: domain ${rows.filter((r) => r.normalizedDomain).length}/${rows.length}, ICP passed ${rows.filter((r) => !r.done).length}`,
        domainSources,
      );

      // ── S4: LLM-разбор вакансии ──
      await publishTotals('analyzing_vacancies');
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
          geoCounts[analysis.target_sales_geo_confidence] += 1;
          if (analysis.target_sales_geo_confidence !== 'low') totals.geoConfirmed += 1;
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
            await publishTotals('analyzing_vacancies', { analyzed_vacancies: analyzed, wave_total: active.length });
          }
        }
      });

      // ── S5: корпоративная почта ──
      await ensureNotCancelled();
      await publishTotals('finding_emails');
      const qualified = rows.filter((r) => !r.done);
      let emailed = 0;
      await runPool(qualified, clampInt(process.env.POLZA_OUTREACH_EMAIL_CONCURRENCY, EMAIL_CONCURRENCY, 1, 5), async (row) => {
        try {
          const emailResult = await findCompanyEmail(row.companyWebsite as string, row.normalizedDomain as string);
          row.email = emailResult.email;
          row.emailType = emailResult.emailType;
          row.emailSourceUrl = emailResult.emailSourceUrl;
          if (emailResult.email) {
            totals.emailFound += 1;
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
            await publishTotals('finding_emails', { emails_searched: emailed, wave_total: qualified.length });
          }
        }
      });

      // ── S6: сборка писем + гарды ──
      await ensureNotCancelled();
      await publishTotals('building_letters');
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
            totals.ready += 1;
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
          await publishTotals('building_letters', { letters_built: built, wave_total: withEmail.length });
        }
      }
    };

    while (totals.ready < target && !poolExhausted && totals.vacancies < maxCandidates) {
      waveNo += 1;
      const want = Math.min(nextWaveSize(target, totals), maxCandidates - totals.vacancies);
      await publishTotals('selecting_vacancies', { wave_want: want });

      const wave = await selectVacancies(db, config, {
        want,
        startOffset: cacheOffset,
        seenCompanies,
      });
      cacheOffset = wave.nextOffset;
      poolExhausted = wave.exhausted;
      await ensureNotCancelled();
      if (wave.candidates.length === 0) break;

      for (const candidate of wave.candidates) seenCompanies.add(candidate.companyName.toLowerCase());
      await insertRows(
        wave.candidates.map((candidate) => ({
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
      const rows: Row[] = wave.candidates
        .map((candidate) => ({
          id: rowByCompanyKey.get(candidate.companyName.toLowerCase()) ?? '',
          candidate,
          normalizedDomain: null,
          companyWebsite: null,
          companySize: null,
          analysis: null,
          domain: null,
          domainError: null,
          email: null,
          emailType: null,
          emailSourceUrl: null,
          status: 'discovered',
          done: false,
        }))
        .filter((row) => row.id);
      totals.vacancies += rows.length;
      log('info', `wave ${waveNo}: ${rows.length} companies selected (ready ${totals.ready}/${target})`);

      await processWave(rows);
      log(
        'info',
        `wave ${waveNo} done: scanned=${totals.vacancies} domain=${totals.domainFound} email=${totals.emailFound} ready=${totals.ready}/${target}`,
      );
    }

    const stopReason = totals.ready >= target
      ? 'target_reached'
      : poolExhausted
        ? 'pool_exhausted'
        : totals.vacancies >= maxCandidates
          ? 'scan_limit'
          : 'pool_exhausted';

    log(
      'info',
      `job ${jobId} done: scanned=${totals.vacancies} domain=${totals.domainFound} icp=${totals.icpPassed} geo=${totals.geoConfirmed} email=${totals.emailFound} ready=${totals.ready}/${target} (${stopReason})`,
    );
    await setProgress({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totals.vacancies,
      total_parsed: totals.ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: {
        wave: waveNo,
        target,
        scanned: totals.vacancies,
        ready: totals.ready,
        stop_reason: stopReason,
        funnel: funnelOf(totals),
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

function funnelOf(totals: Totals) {
  return {
    vacancies: totals.vacancies,
    domain_found: totals.domainFound,
    icp_passed: totals.icpPassed,
    geo_confirmed: totals.geoConfirmed,
    email_found: totals.emailFound,
    ready: totals.ready,
  };
}
