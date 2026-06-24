/**
 * OutreachOS daily pipeline orchestrator — Mailganer-free self-outreach.
 *
 * Поток (раз в сутки, см. worker/outreachosCron.ts):
 *
 *   1. Загрузить singleton-конфиг. Выключен → выйти. measure_only=false и нет
 *      campaign_id → выйти. measure_only=true → идём без кампании (замер).
 *   2. HH-парс новых работодателей за window_hours, фильтр ICP = индустрии +
 *      exclude федеральных брендов + maxEmployees (БЕЗ скоринга).
 *   3. Дедуп против outreachos_seen_employers (свой журнал, не Mailganer-стек).
 *   4. Сетка → base_constructor_jobs (чистка/обогащение/валидация БЕЗ
 *      ta_scoring/personalization). Ждём, пока worker-baseconstructor доработает.
 *   5. measure_only → журналим parsed/new/valid и ВЫХОДИМ (без заливки, без seen).
 *      Иначе: готовую сетку → лиды → appendLeadsToClientCampaign в ОДНУ кампанию.
 *   6. Журналируем seen + run.
 *
 * ИЗОЛЯЦИЯ: ни одного импорта из autoPipelineRunner / mailganerScore* /
 * clientEndpointClient / bobScoringRunner и ни одного обращения к
 * mailganer_domain_scores / background_scorer_state / client_auto_pipeline_*.
 * Скоринга нет вовсе.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { findNewHhEmployers, deriveDomain, type HhEmployer } from '@/lib/jobs/hhAutoParser';
import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import { loadOutreachOsConfig } from './config';
import { buildExcludePatterns } from './excludePatterns';
import { loadRecentlySeen, markSeen, RECONTACT_AFTER_DAYS, type SeenEmployerUpsert } from './seenEmployers';
import { employersToGrid, gridToLeadPayloads } from './gridMapping';

const POLL_INTERVAL_MS = 10_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface OutreachOsRunResult {
  runId: string | null;
  status: 'completed' | 'failed' | 'skipped';
  parsed: number;
  newEmployers: number;
  validContacts: number;
  appended: number;
  skipped: number;
  error?: string;
}

type Logger = (msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOutreachOsDailyPipeline(log: Logger = () => {}): Promise<OutreachOsRunResult> {
  const empty: OutreachOsRunResult = {
    runId: null,
    status: 'skipped',
    parsed: 0,
    newEmployers: 0,
    validContacts: 0,
    appended: 0,
    skipped: 0,
  };

  if (!supabaseAdmin) {
    return { ...empty, status: 'failed', error: 'supabaseAdmin unavailable' };
  }
  const db = supabaseAdmin;

  // 1. Конфиг.
  const config = await loadOutreachOsConfig();
  if (!config) {
    log('Нет outreachos_pipeline_config (id=1) — пропускаем');
    return { ...empty, error: 'no_config' };
  }
  if (!config.enabled) {
    log('Пайплайн выключен (enabled=false) — пропускаем');
    return empty;
  }
  const measureOnly = config.measure_only === true;
  if (!measureOnly && !config.campaign_id) {
    log('Не задан campaign_id (и не measure_only) — кампания не создана, пропускаем');
    return { ...empty, error: 'no_campaign_id' };
  }
  if (config.selected_steps.length === 0) {
    log('Пустой selected_steps — нечего прогонять, пропускаем');
    return { ...empty, error: 'no_steps' };
  }

  // 2. Run row.
  const { data: runRow, error: runErr } = await db
    .from('outreachos_pipeline_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) {
    return { ...empty, status: 'failed', error: `run insert failed: ${runErr?.message}` };
  }
  const runId = (runRow as { id: string }).id;

  const finishRun = async (patch: Record<string, unknown>): Promise<void> => {
    await db
      .from('outreachos_pipeline_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runId);
  };

  try {
    // 3. HH-парс + ICP-фильтр.
    const since = new Date(Date.now() - config.window_hours * 3600_000);
    const employers = await findNewHhEmployers({
      since,
      area: config.area,
      industries: config.industries.length > 0 ? config.industries : undefined,
      excludePatterns: buildExcludePatterns(config.extra_exclude),
      maxEmployees: config.max_employees ?? undefined,
      limit: config.daily_limit,
      log: (m) => log(`[hh] ${m}`),
    });
    log(`HH вернул ${employers.length} работодателей (после ICP-фильтра)`);

    // 4. Дедуп по окну: компании, контактированные за последние
    //    RECONTACT_AFTER_DAYS дней, пропускаем (не пишем одной компании чаще
    //    раза в 1.5 месяца). По hh_employer_id И по домену сайта. Компании
    //    старше окна — снова eligible (повторный аутрич разрешён).
    const seen = await loadRecentlySeen();
    const fresh = employers.filter((e) => {
      if (seen.ids.has(e.id)) return false;
      const d = deriveDomain(e.siteUrl);
      return !(d && seen.domains.has(d));
    });
    log(`Новых (не контактированы за ${RECONTACT_AFTER_DAYS}д): ${fresh.length}`);

    if (fresh.length === 0) {
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: employers.length,
        new_employers: 0,
        valid_contacts: 0,
        appended: 0,
        skipped: 0,
      });
      return {
        runId,
        status: 'completed',
        parsed: employers.length,
        newEmployers: 0,
        validContacts: 0,
        appended: 0,
        skipped: 0,
      };
    }

    // 5. Сетка → base_constructor_jobs (чистка/валидация без ta_scoring/persona).
    const grid = employersToGrid(fresh);
    const today = new Date().toISOString().slice(0, 10);
    const { data: jobRow, error: jobErr } = await db
      .from('base_constructor_jobs')
      .insert({
        user_id: config.client_user_id,
        file_name: `outreachos-${today}`,
        data: grid,
        selected_steps: config.selected_steps,
        // find_emails пишет прямо в колонку Email (а не в отдельную «Найденный
        // Email» с последующим merge) — убираем неявную зависимость от порядка
        // шагов: даже без промежуточных шагов почты сразу в Email.
        step_config: { find_emails_target: 'same' },
        initial_row_count: grid.length - 1,
        total_steps: config.selected_steps.length,
      })
      .select('id')
      .single();
    if (jobErr || !jobRow) {
      throw new Error(`base job insert failed: ${jobErr?.message}`);
    }
    const baseJobId = (jobRow as { id: string }).id;
    log(`Создан base_constructor_job ${baseJobId} (${grid.length - 1} строк, шаги: ${config.selected_steps.join(',')})`);

    // 6. Ждём, пока worker-baseconstructor доработает. В цикле тянем ТОЛЬКО
    //    status (не весь data-блоб — он может быть мегабайтами), а финальную
    //    сетку забираем один раз по завершении.
    const deadline = Date.now() + config.job_poll_timeout_minutes * 60_000;
    let finalGrid: string[][] | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`base job ${baseJobId} не завершился за ${config.job_poll_timeout_minutes} мин`);
      }
      await sleep(POLL_INTERVAL_MS);
      const { data: js } = await db
        .from('base_constructor_jobs')
        .select('status, error_message')
        .eq('id', baseJobId)
        .maybeSingle();
      const status = (js as { status?: string } | null)?.status;
      if (!status || !TERMINAL_STATUSES.has(status)) continue;
      if (status !== 'completed') {
        const em = (js as { error_message?: string } | null)?.error_message;
        throw new Error(`base job ${baseJobId} завершился со status=${status}: ${em ?? 'no message'}`);
      }
      const { data: full } = await db
        .from('base_constructor_jobs')
        .select('data')
        .eq('id', baseJobId)
        .maybeSingle();
      finalGrid = ((full as { data?: string[][] } | null)?.data ?? null);
      break;
    }

    // 7. Сетка → лиды.
    const leads = gridToLeadPayloads(finalGrid ?? []);
    log(`Валидных контактов на выходе конструктора: ${leads.length}`);

    // MEASURE-режим: только меряем воронку (parsed→new→valid). НЕ заливаем в
    // Instantly и НЕ пишем seen — замер неразрушающий и повторяемый, go-live
    // не «засевается». Ранний выход до append/seen, независимо от числа лидов.
    if (measureOnly) {
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: employers.length,
        new_employers: fresh.length,
        base_job_id: baseJobId,
        valid_contacts: leads.length,
        appended: 0,
        skipped: 0,
      });
      log(`MEASURE: parsed=${employers.length} new=${fresh.length} valid=${leads.length} (без заливки, seen не тронут)`);
      return {
        runId,
        status: 'completed',
        parsed: employers.length,
        newEmployers: fresh.length,
        validContacts: leads.length,
        appended: 0,
        skipped: 0,
      };
    }

    if (leads.length === 0) {
      // Скрейп отработал, но почт не нашли — помечаем seen как no_email,
      // чтобы не гонять тех же работодателей завтра.
      await markSeen(fresh.map(toSeen(new Set(), 'no_email')));
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: employers.length,
        new_employers: fresh.length,
        base_job_id: baseJobId,
        valid_contacts: 0,
        appended: 0,
        skipped: 0,
      });
      return {
        runId,
        status: 'completed',
        parsed: employers.length,
        newEmployers: fresh.length,
        validContacts: 0,
        appended: 0,
        skipped: 0,
      };
    }

    // 8. Добор в фиксированную кампанию Instantly. Сюда попадаем только в
    //    live-режиме (measureOnly=false), а верхний гард гарантирует, что тогда
    //    campaign_id задан. Захватываем в const, чтобы сузить тип до string.
    const campaignId = config.campaign_id;
    if (!campaignId) {
      throw new Error('campaign_id отсутствует в live-режиме (не должно случаться)');
    }
    const appendResult = await appendLeadsToClientCampaign({
      userId: config.client_user_id,
      campaignId,
      leads,
      contextLabel: 'OutreachOS daily',
    });
    log(`Instantly: accepted=${appendResult.accepted} skipped=${appendResult.skipped}`);

    // 9. Журнал seen — только на happy-path (job completed + append прошёл).
    //    Домены, попавшие в лиды → 'appended', остальные fresh → 'no_email'.
    const leadDomains = new Set(
      leads.map((l) => deriveDomain(l.website ?? null)).filter((d): d is string => !!d),
    );
    // fallback='no_email': работодатели, чей домен НЕ дал лида, — это именно
    // no_email, а не appended (иначе метрики seen врут).
    await markSeen(fresh.map(toSeen(leadDomains, 'no_email')));

    await finishRun({
      status: 'completed',
      parsed: employers.length,
      after_icp: employers.length,
      new_employers: fresh.length,
      base_job_id: baseJobId,
      valid_contacts: leads.length,
      appended: appendResult.accepted,
      skipped: appendResult.skipped,
    });

    await logAudit('outreachos.run.completed', 'OutreachOS daily pipeline completed', {
      runId,
      parsed: employers.length,
      newEmployers: fresh.length,
      validContacts: leads.length,
      appended: appendResult.accepted,
    });

    return {
      runId,
      status: 'completed',
      parsed: employers.length,
      newEmployers: fresh.length,
      validContacts: leads.length,
      appended: appendResult.accepted,
      skipped: appendResult.skipped,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // На любой ошибке НЕ помечаем seen — работодатели переедут на следующий
    // прогон после устранения причины (скрейп пере-выполнится, это допустимо).
    await finishRun({ status: 'failed', error_message: message });
    await logError('outreachos.run.failed', err, { runId });
    return { ...empty, runId, status: 'failed', error: message };
  }
}

/**
 * Фабрика маппера HhEmployer → SeenEmployerUpsert. Если домен работодателя есть
 * в leadDomains — статус 'appended', иначе fallback-статус.
 */
function toSeen(
  leadDomains: Set<string>,
  fallback: SeenEmployerUpsert['status'],
): (e: HhEmployer) => SeenEmployerUpsert {
  return (e) => {
    const domain = deriveDomain(e.siteUrl);
    const status: SeenEmployerUpsert['status'] =
      domain && leadDomains.has(domain) ? 'appended' : fallback;
    return {
      hh_employer_id: e.id,
      hh_employer_name: e.name ?? null,
      domain,
      site_url: e.siteUrl,
      status,
    };
  };
}
