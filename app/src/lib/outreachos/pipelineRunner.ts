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
 * 2GIS TOP-UP (gis_topup_enabled): между шагом 7b (LLM) и шагом 8 (markSeen)
 * вставлены фазы 8t.1–8t.5 — ежедневная цель gis_topup_target_appended
 * контактов из 2gis_dataset СВЕРХ результата HH. GIS-лиды объединяются с HH keptLeads ПЕРЕД общим
 * markSeen, общим дедупом против своих кампаний и общим A/B-сплитом — отдельная
 * кампания C не заводится (решение §7.2 дизайн-дока
 * docs/design/2026-08-11-outreachos-2gis-topup.md).
 *
 * КОНТРОЛЬНЫЕ ТОЧКИ (инцидент 23–24.09.2026, см. runCheckpoint.ts): деплой
 * убивает exec'нутый прогон вместе с контейнером. Поэтому прогон сохраняет
 * состояние после HH-фазы («constructor») и перед шагом 8 («upload»), а сторож
 * outreachosWatchdogCron продолжает его через resumeOutreachOsRun с последней
 * точки — в той же строке outreachos_pipeline_runs.
 *
 * ИЗОЛЯЦИЯ: ни одного импорта из autoPipelineRunner / mailganerScore* /
 * clientEndpointClient / bobScoringRunner и ни одного обращения к
 * mailganer_domain_scores / background_scorer_state / client_auto_pipeline_*.
 * Из gisSignalOutreach — тоже ничего (кросс-дедупы идут через таблицы и
 * twoGis/*). Скоринга нет вовсе.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { findNewHhEmployers, deriveDomain, type HhEmployer } from '@/lib/jobs/hhAutoParser';
import { ensureArchiveSinkJob, buildHhArchiveSinkCallback, getUserIdByEmail } from '@/lib/parsers/hhArchiveSink';
import { appendLeadsToClientCampaign, fetchExistingCampaignEmails } from '@/lib/clientLaunch/appendLeads';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { getLatestTwoGisSnapshotId } from '@/lib/twoGis/repository';
import { normalizeTwoGisFilters } from '@/lib/twoGis/query';
import { toTwoGisRubricGroups } from '@/lib/twoGis/rubricGroups';
import { loadOutreachOsConfig, type OutreachOsConfig } from './config';
import { buildExcludePatterns } from './excludePatterns';
import { isOutreachOsB2cCompany } from './excludeB2c';
import {
  EMPTY_SUPPRESSION,
  isSuppressedCompany,
  type OutreachOsSuppression,
} from './suppression';
import { llmClassifyNoise, type CompanyForClassify } from './classifyCompanies';
import {
  loadRecentlySeen,
  markSeen,
  RECONTACT_AFTER_DAYS,
  type RecentlySeen,
  type SeenEmployerUpsert,
} from './seenEmployers';
import { employersToGrid, gridToLeadPayloads } from './gridMapping';
import {
  buildGisClassifyIndustries,
  computeGisPullLimit,
  gisCandidatesToGrid,
  loadGisSignalSeenDomains,
  markGisSignalSeen,
  pullGisTopupCandidates,
  type GisTopupCandidate,
} from './gisTopup';
import {
  gisScanRubricKey,
  gisScanStartCursor,
  loadGisScanState,
  saveGisScanState,
  type GisScanCheckpoint,
} from './gisScanState';
import {
  CHECKPOINT_VERSION,
  claimRunCheckpoint,
  compactEmployer,
  deleteRunCheckpoint,
  loadRunCheckpoint,
  restoreEmployer,
  saveRunCheckpoint,
  type ConstructorPayload,
  type GisCounters,
  type HhPhaseTotals,
  type RunCheckpoint,
  type UploadPayload,
} from './runCheckpoint';

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
  /** Счётчики 2GIS top-up'а; отсутствует, если топ-ап в прогоне не запускался. */
  gisTopup?: {
    pulled: number;
    afterDedup: number;
    validContacts: number;
    llmKept: number;
    appended: number;
  };
  error?: string;
}

export interface RunOptions {
  /** Тесты подставляют ~0, чтобы не ждать реальный poll-интервал. */
  pollIntervalMs?: number;
  /**
   * started_at убитого прогона, который перезапускает сторож: HH берём с его
   * окна (started_at − window_hours), чтобы вакансии между стартами не выпали.
   */
  anchorStartedAt?: string;
}

type Logger = (msg: string) => void;
type Db = NonNullable<typeof supabaseAdmin>;
type FinishRun = (patch: Record<string, unknown>) => Promise<void>;

interface RunContext {
  db: Db;
  config: OutreachOsConfig;
  runId: string;
  log: Logger;
  pollIntervalMs: number;
  anchorStartedAt?: string;
  checkpoint: RunCheckpoint | null;
}

/** Состояние 2GIS top-up'а, которое catch пишет в run-строку при сбое. */
interface GisRunState {
  executed: boolean;
  counters: GisCounters;
}

/** Результат HH-фазы: свежий прогон собирает его, продолжение берёт из точки. */
interface HhPhase {
  totals: HhPhaseTotals;
  fresh: HhEmployer[];
  batchDomains: Set<string>;
  suppression: OutreachOsSuppression;
  /** seen-окно со старта HH; при продолжении грузится заново только для 2GIS. */
  seen: RecentlySeen | null;
  finalGrid: string[][] | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyResult(): OutreachOsRunResult {
  return {
    runId: null,
    status: 'skipped',
    parsed: 0,
    newEmployers: 0,
    validContacts: 0,
    appended: 0,
    skipped: 0,
  };
}

/** Проверки конфига перед прогоном: null — можно ехать, иначе результат пропуска. */
function configSkip(config: OutreachOsConfig | null, log: Logger): OutreachOsRunResult | null {
  const empty = emptyResult();
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
  return null;
}

export async function runOutreachOsDailyPipeline(
  log: Logger = () => {},
  opts: RunOptions = {},
): Promise<OutreachOsRunResult> {
  if (!supabaseAdmin) {
    return { ...emptyResult(), status: 'failed', error: 'supabaseAdmin unavailable' };
  }
  const db = supabaseAdmin;

  // 1. Конфиг.
  const config = await loadOutreachOsConfig();
  const skip = configSkip(config, log);
  if (skip || !config) return skip ?? emptyResult();

  // 2. Run row.
  const { data: runRow, error: runErr } = await db
    .from('outreachos_pipeline_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) {
    return { ...emptyResult(), status: 'failed', error: `run insert failed: ${runErr?.message}` };
  }

  return executeRun({
    db,
    config,
    runId: (runRow as { id: string }).id,
    log,
    pollIntervalMs: opts.pollIntervalMs ?? POLL_INTERVAL_MS,
    anchorStartedAt: opts.anchorStartedAt,
    checkpoint: null,
  });
}

/**
 * Продолжение прогона, чей процесс погиб (деплой пересоздал контейнер), с его
 * контрольной точки. Запускает сторож outreachosWatchdogCron через
 * `outreachosCron.js --resume=<runId>`. Строка прогона та же, так что день
 * остаётся одной записью.
 */
export async function resumeOutreachOsRun(
  runId: string,
  log: Logger = () => {},
  opts: RunOptions = {},
): Promise<OutreachOsRunResult> {
  const empty = { ...emptyResult(), runId };
  if (!supabaseAdmin) {
    return { ...empty, status: 'failed', error: 'supabaseAdmin unavailable' };
  }
  const db = supabaseAdmin;

  const { data: runRow, error: runErr } = await db
    .from('outreachos_pipeline_runs')
    .select('status')
    .eq('id', runId)
    .maybeSingle();
  if (runErr) {
    return { ...empty, status: 'failed', error: `run read failed: ${runErr.message}` };
  }
  if ((runRow as { status?: string } | null)?.status !== 'running') {
    log(`Прогон ${runId} уже не running — продолжать нечего`);
    return { ...empty, error: 'run_not_running' };
  }
  const checkpoint = await loadRunCheckpoint(runId);
  if (!checkpoint) {
    log(`У прогона ${runId} нет контрольной точки — продолжать не с чего`);
    return { ...empty, error: 'no_checkpoint' };
  }
  if (!(await claimRunCheckpoint(runId, checkpoint.resumeAttempts))) {
    log(`Прогон ${runId} уже забрал другой сторож — выходим`);
    return { ...empty, error: 'claimed_by_other' };
  }

  const config = await loadOutreachOsConfig();
  const skip = configSkip(config, log);
  if (skip || !config) {
    const reason = `прогон не продолжен: ${skip?.error ?? 'пайплайн выключен'}`;
    await db
      .from('outreachos_pipeline_runs')
      .update({ status: 'failed', error_message: reason, finished_at: new Date().toISOString() })
      .eq('id', runId);
    await deleteRunCheckpoint(runId, log);
    return { ...empty, status: 'failed', error: reason };
  }

  log(`Продолжаем прогон ${runId} с точки «${checkpoint.phase}» (попытка ${checkpoint.resumeAttempts + 1})`);
  await logAudit('outreachos.run.resumed', 'OutreachOS run resumed from checkpoint', {
    runId,
    phase: checkpoint.phase,
    attempt: checkpoint.resumeAttempts + 1,
  });
  return executeRun({
    db,
    config,
    runId,
    log,
    pollIntervalMs: opts.pollIntervalMs ?? POLL_INTERVAL_MS,
    checkpoint,
  });
}

async function executeRun(ctx: RunContext): Promise<OutreachOsRunResult> {
  const { db, config, runId, log } = ctx;

  const finishRun: FinishRun = async (patch) => {
    await db
      .from('outreachos_pipeline_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runId);
  };

  // Состояние 2GIS top-up'а (фазы 8t.*): объявлено ДО try, чтобы catch мог
  // записать частичные счётчики в run-строку при сбое (напр. упал GIS-джоб).
  const gis: GisRunState = {
    executed: false,
    counters: { pulled: 0, afterDedup: 0, validContacts: 0, llmKept: 0, appended: 0 },
  };
  const gisRunPatch = (): Record<string, unknown> =>
    gis.executed
      ? {
          gis_pulled: gis.counters.pulled,
          gis_after_dedup: gis.counters.afterDedup,
          gis_valid_contacts: gis.counters.validContacts,
          gis_llm_kept: gis.counters.llmKept,
          gis_appended: gis.counters.appended,
        }
      : {};

  try {
    const checkpoint = ctx.checkpoint;
    if (checkpoint?.phase === 'upload') {
      gis.executed = checkpoint.payload.gis.executed;
      gis.counters = { ...checkpoint.payload.gis.counters };
      log(`Лиды из контрольной точки: ${checkpoint.payload.keptLeads.length}, повторяем запись seen и заливку`);
      return await uploadAndFinish(ctx, checkpoint.payload, gis, finishRun);
    }
    const hh = checkpoint?.phase === 'constructor'
      ? await restoreHhPhase(ctx, checkpoint.payload)
      : await runHhPhase(ctx);
    const { totals, fresh, suppression } = hh;

    // 7. Сетка → лиды (с suppression-рубежом по почте/домену внутри).
    const leads = gridToLeadPayloads(hh.finalGrid ?? [], suppression);
    log(`Валидных контактов на выходе конструктора: ${leads.length}`);

    // MEASURE-режим: только меряем воронку (parsed→new→valid). НЕ заливаем в
    // Instantly и НЕ пишем seen — замер неразрушающий и повторяемый, go-live
    // не «засевается». Ранний выход до append/seen, независимо от числа лидов.
    const measureOnly = config.measure_only === true;
    if (measureOnly) {
      await finishRun({
        status: 'completed',
        parsed: totals.parsed,
        after_icp: totals.afterIcp,
        new_employers: totals.newEmployers,
        base_job_id: totals.baseJobId,
        valid_contacts: leads.length,
        appended: 0,
        skipped: 0,
      });
      await deleteRunCheckpoint(runId, log);
      log(`MEASURE: parsed=${totals.parsed} new=${totals.newEmployers} valid=${leads.length} (без заливки, seen не тронут)`);
      return {
        runId,
        status: 'completed',
        parsed: totals.parsed,
        newEmployers: totals.newEmployers,
        validContacts: leads.length,
        appended: 0,
        skipped: 0,
      };
    }

    // Сюда попадаем только в live-режиме (measureOnly=false), верхний гард
    // гарантирует, что campaign_id задан.
    if (!config.campaign_id) {
      throw new Error('campaign_id отсутствует в live-режиме (не должно случаться)');
    }

    // 7b. LLM-отсев B2C/ИП/гос (ТРЕТИЙ рубеж, только live): структурные правила
    //     ловят ~4%, но онлайн-школа с нейтральным доменом от B2B неотличима.
    //     Классифицируем УНИКАЛЬНЫЕ компании (не лиды), выкидываем лиды шумовых.
    //     Fail-open: сбой LLM = едем без этого фильтра, лиды не теряем.
    //     Шумовые компании остаются в fresh → попадут в markSeen как skipped.
    //     После 45 дней их снова классифицирует LLM.
    // Контекст HH по домену: индустрии/описание/вакансия из fresh (HhEmployer[])
    // — они не доходят до грида (тот несёт только Компания/Сайт/Город/Email),
    // поэтому классификатору их отдаём отдельным маппингом по домену сайта.
    // Это резко сокращает «unclear»: «Смарт» → +индустрия +описание = ясный B2B.
    const hhContext = new Map<string, { industries: string[]; description?: string; vacancyTitle?: string }>();
    for (const e of fresh) {
      const d = deriveDomain(e.siteUrl);
      if (d && !hhContext.has(d)) {
        hhContext.set(d, { industries: e.industries ?? [], description: e.description, vacancyTitle: e.vacancyTitle });
      }
    }

    const uniqueCompanies: CompanyForClassify[] = [];
    const companyIdxByKey = new Map<string, number>();
    const leadCompanyIdx: number[] = [];
    for (const l of leads) {
      const key = `${(l.company_name ?? '').trim().toLowerCase()}|${(l.website ?? '').trim().toLowerCase()}`;
      let idx = companyIdxByKey.get(key);
      if (idx === undefined) {
        idx = uniqueCompanies.length;
        companyIdxByKey.set(key, idx);
        const hhCtx = hhContext.get(deriveDomain(l.website ?? null) ?? '');
        uniqueCompanies.push({
          name: l.company_name ?? '',
          website: l.website ?? '',
          industries: hhCtx?.industries,
          description: hhCtx?.description,
          vacancyTitle: hhCtx?.vacancyTitle,
        });
      }
      leadCompanyIdx.push(idx);
    }
    const llm = await llmClassifyNoise(uniqueCompanies, (m) => log(`[llm] ${m}`));
    // let: в live-режиме топ-апа к HH keptLeads добавляются GIS keptLeads (8t.5).
    let keptLeads = leads.filter((_, i) => !llm.noise.has(leadCompanyIdx[i]));
    log(
      `LLM-отсев: компаний ${uniqueCompanies.length}, вердиктов ${llm.classified}, ` +
        `шум ${llm.noise.size} (рефьют спас ${llm.refuted}), лидов ${leads.length} → ${keptLeads.length}` +
        (llm.failedBatches > 0 ? ` (батчей без фильтра: ${llm.failedBatches})` : '') +
        (llm.guardTripped ? ' [ПРЕДОХРАНИТЕЛЬ: фильтр отключён на этот прогон]' : ''),
    );
    // Известное ограничение: кап catch-all ≤20% посчитан в gridToLeadPayloads ДО
    // этого отсева; если LLM выкинул преимущественно ok-компании, доля catch-all
    // в финальной пачке может слегка превысить 20% (статусов у лидов здесь уже
    // нет — пересчитать нечем). При штатном шуме ~10-14% overshoot ≤ ~2 п.п.

    // Домены LLM-шума — для честного статуса в seen-журнале ('skipped', не
    // 'no_email': почты у них НАЙДЕНЫ, мы их отсеяли сами).
    const noiseDomains = new Set<string>();
    for (const idx of llm.noise) {
      const d = deriveDomain(uniqueCompanies[idx].website || null);
      if (d) noiseDomains.add(d);
    }

    // ── 8t. 2GIS TOP-UP (дизайн-док 2026-08-11-outreachos-2gis-topup §3.2) ──
    // Самостоятельная ежедневная цель из 2gis_dataset СВЕРХ результата HH:
    // keptLeads не уменьшает запрос GIS, даже если HH уже дал 200+ контактов.
    // Один батч с прежним лимитом кандидатов; цель не гарантирует число
    // принятых контактов после обработки и дедупов.
    // gis_topup_measure_only=true: фазы 8t.1–8t.4 выполняются, счётчики пишутся
    // в run, но GIS-лиды НЕ объединяются, seen по ним НЕ пишется (HH-ветка
    // работает как обычно — замер относится только к топ-апу).
    const gisMeasureOnly = config.gis_topup_measure_only;
    const gisQualified: GisTopupCandidate[] = []; // кандидаты, ушедшие в конструктор (аналог fresh)
    let gisKeptLeads: LeadCreatePayload[] = [];   // GIS-лиды после LLM (аналог keptLeads)
    const gisNoiseDomains = new Set<string>();
    const gisTarget = config.gis_topup_target_appended;
    let gisCheckpoint: GisScanCheckpoint | null = null;
    const gisRubricGroups = normalizeTwoGisFilters({
      rubricGroups: toTwoGisRubricGroups(config.gis_topup_rubric_groups),
    }).rubricGroups ?? [];

    if (!config.gis_topup_enabled) {
      log('[gis-topup] выключен (gis_topup_enabled=false) — пропускаем');
    } else if (gisTarget <= 0) {
      log('[gis-topup] ежедневная цель GIS равна нулю — пропускаем');
    } else if (gisRubricGroups.length === 0) {
      log('[gis-topup] пустой gis_topup_rubric_groups — нечего тянуть, пропускаем');
    } else {
      gis.executed = true;
      // 8t.1 PULL: latest snapshot, rubric_groups, hasWebsite=true,
      // Лимит рассчитывается из цели GIS с запасом на потери, затем режется cap.
      const pullLimit = computeGisPullLimit(gisTarget, config.gis_topup_daily_cap);
      const snapshotId = await getLatestTwoGisSnapshotId();
      // §4.1.2: домены gis_signal_seen_companies — fail-closed (null): сбой
      // чтения кросс-журнала = топ-ап пропускаем, повторное письмо компании
      // GIS-пайплайна недопустимо. HH-ветка от этого не зависит.
      const gisSignalSeenDomains = await loadGisSignalSeenDomains();
      const scanState = await loadGisScanState(log);
      if (!snapshotId) {
        log('[gis-topup] снапшот 2gis_dataset недоступен (TWOGIS_DATASET_DB_URL?) — топ-ап пропущен, HH-ветка продолжается');
        gis.executed = false;
      } else if (!gisSignalSeenDomains) {
        log('[gis-topup] не удалось прочитать gis_signal_seen_companies (fail-closed) — топ-ап пропущен, HH-ветка продолжается');
        gis.executed = false;
      } else if (!scanState) {
        log('[gis-topup] позиция обхода недоступна — топ-ап пропущен, HH-ветка продолжается');
        gis.executed = false;
      } else {
        const rubricKey = gisScanRubricKey(gisRubricGroups);
        const cursor = gisScanStartCursor(scanState, snapshotId, rubricKey);
        if (scanState.snapshot_id !== snapshotId || scanState.rubric_key !== rubricKey) {
          log('[gis-topup] новый снапшот или набор рубрик — обход с начала');
        }
        // Дедуп-матрица §4.1: (а) seen OutreachOS 45д + (б) gis_signal seen +
        // (в) домены сегодняшнего HH+SJ батча; (г) внутренний — в pull'е.
        // При продолжении с точки seen-окно со старта HH не сохранено — читаем заново.
        const seen = hh.seen ?? await loadRecentlySeen();
        const excludeDomains = new Set<string>([
          ...seen.domains,
          ...gisSignalSeenDomains,
          ...hh.batchDomains,
        ]);
        const pull = await pullGisTopupCandidates({
          rubricGroups: gisRubricGroups,
          limit: pullLimit,
          snapshotId,
          excludeDomains,
          suppression,
          cursor,
          log: (m) => log(`[gis-topup] ${m}`),
        });
        gisCheckpoint = { previous: scanState, snapshotId, rubricKey, afterId: pull.nextCursor };
        gis.counters.pulled = pull.pulled;
        log(
          `[gis-topup] 8t.1 pull: цель GIS=${gisTarget} сверх HH=${keptLeads.length}, лимит=${pullLimit}, ` +
            `взято=${pull.pulled} (кросс-дедуп -${pull.excludedDropped}, B2C -${pull.b2cDropped}, ` +
            `suppression -${pull.suppressed}, scanned=${pull.scanned}) → кандидатов ${pull.candidates.length}; ` +
            `позиция=${cursor ?? 'начало'} → ${pull.nextCursor ?? 'начало следующего прохода'}, остановка=${pull.stopReason}`,
        );

        // 8t.2 B2C и suppression проверены внутри pull ДО заполнения лимита.
        gisQualified.push(...pull.candidates);
        gis.counters.afterDedup = gisQualified.length;

        if (gisQualified.length === 0) {
          log('[gis-topup] после дедупов/B2C/suppression кандидатов нет — топ-ап завершён');
        } else {
          // 8t.3 Второй base_constructor_job: те же selected_steps/step_config,
          //      тот же poll-цикл и терминальные статусы. Ошибка джоба = ошибка
          //      прогона (throw — как у основного джоба): seen к этому моменту
          //      ещё не писался → HH- и GIS-компании корректно ретраятся.
          const gisGrid = gisCandidatesToGrid(gisQualified);
          const { jobId: gisJobId, finalGrid: gisFinalGrid } = await runBaseConstructorJob(db, {
            userId: config.client_user_id,
            fileName: `outreachos-${totals.runDate}-gis-topup`,
            grid: gisGrid,
            selectedSteps: config.selected_steps,
            pollTimeoutMinutes: config.job_poll_timeout_minutes,
            pollIntervalMs: ctx.pollIntervalMs,
            log,
          });
          log(`[gis-topup] 8t.3 конструктор ${gisJobId} завершён`);

          // 8t.4 Сетка → лиды (тот же gridToLeadPayloads) → ОТДЕЛЬНЫЙ LLM-отсев
          //      (тот же вызов llmClassifyNoise, но свои компании/счётчики —
          //      объединять с HH-компаниями по ключу name|website не нужно).
          //      Контекст компании: industries = [category, subcategory] рубрик
          //      2GIS (description/vacancyTitle у 2GIS нет). Предохранитель
          //      guard логируем отдельно.
          const gisLeads = gridToLeadPayloads(gisFinalGrid ?? [], suppression);
          gis.counters.validContacts = gisLeads.length;
          log(`[gis-topup] 8t.4 валидных контактов на выходе конструктора: ${gisLeads.length}`);

          if (gisLeads.length > 0) {
            const gisIndustries = buildGisClassifyIndustries(gisQualified);
            const gisCompanies: CompanyForClassify[] = [];
            const gisCompanyIdxByKey = new Map<string, number>();
            const gisLeadCompanyIdx: number[] = [];
            for (const l of gisLeads) {
              const key = `${(l.company_name ?? '').trim().toLowerCase()}|${(l.website ?? '').trim().toLowerCase()}`;
              let idx = gisCompanyIdxByKey.get(key);
              if (idx === undefined) {
                idx = gisCompanies.length;
                gisCompanyIdxByKey.set(key, idx);
                gisCompanies.push({
                  name: l.company_name ?? '',
                  website: l.website ?? '',
                  industries: gisIndustries.get(deriveDomain(l.website ?? null) ?? ''),
                });
              }
              gisLeadCompanyIdx.push(idx);
            }
            const gisLlm = await llmClassifyNoise(gisCompanies, (m) => log(`[gis-topup][llm] ${m}`));
            gisKeptLeads = gisLeads.filter((_, i) => !gisLlm.noise.has(gisLeadCompanyIdx[i]));
            gis.counters.llmKept = gisKeptLeads.length;
            log(
              `[gis-topup] LLM-отсев: компаний ${gisCompanies.length}, вердиктов ${gisLlm.classified}, ` +
                `шум ${gisLlm.noise.size} (рефьют спас ${gisLlm.refuted}), лидов ${gisLeads.length} → ${gisKeptLeads.length}` +
                (gisLlm.failedBatches > 0 ? ` (батчей без фильтра: ${gisLlm.failedBatches})` : '') +
                (gisLlm.guardTripped ? ' [ПРЕДОХРАНИТЕЛЬ: фильтр отключён на этот прогон]' : ''),
            );
            for (const idx of gisLlm.noise) {
              const d = deriveDomain(gisCompanies[idx].website || null);
              if (d) gisNoiseDomains.add(d);
            }
          }
        }
      }
    }

    // 8t.5 Объединение с HH keptLeads ПЕРЕД шагом 8 (только live-режим топ-апа):
    //     дальше — общий markSeen (§4.3), общий дедуп против своих кампаний (8b),
    //     общий A/B-сплит по домену компании и append — без изменений в этих шагах.
    //     В measure_only-режиме топ-апа GIS-лиды НЕ объединяются (замер без заливки).
    //     hhKeptCount фиксирует HH-only счётчик ДО объединения — колонка llm_kept
    //     в runs исторически означает HH-ветку (GIS имеет свои колонки gis_*).
    const hhKeptCount = keptLeads.length;
    if (gis.executed && gisKeptLeads.length > 0) {
      if (gisMeasureOnly) {
        log(`[gis-topup] MEASURE: GIS-лиды (${gisKeptLeads.length}) НЕ объединяем — замер без заливки и seen`);
      } else {
        keptLeads = keptLeads.concat(gisKeptLeads);
        log(`[gis-topup] 8t.5 объединено: HH ${hhKeptCount} + GIS ${gisKeptLeads.length} → ${keptLeads.length}`);
      }
    }

    // Статусы seen считаются здесь, пишутся на шаге 8 (uploadAndFinish).
    const leadDomains = new Set(
      keptLeads.map((l) => deriveDomain(l.website ?? null)).filter((d): d is string => !!d),
    );
    // §4.3: GIS-компании пишем в тот же журнал с hh_employer_id=NULL (дедуп-ось
    // — domain), статусы по тем же правилам, что HH-ветка (appended/skipped/
    // no_email). markSeen строго ДО append — как у HH.
    const gisSeenRows =
      gis.executed && !gisMeasureOnly ? gisQualified.map(toGisSeen(leadDomains, gisNoiseDomains)) : [];

    const upload: UploadPayload = {
      version: CHECKPOINT_VERSION,
      ...totals,
      validContacts: leads.length,
      llm: {
        noise: llm.noise.size,
        kept: hhKeptCount,
        failedBatches: llm.failedBatches,
        guardTripped: llm.guardTripped,
      },
      keptLeads,
      seenRows: fresh.map(toSeen(leadDomains, noiseDomains, 'no_email')).concat(gisSeenRows),
      gis: {
        executed: gis.executed,
        measureOnly: gisMeasureOnly,
        counters: { ...gis.counters },
        scanCheckpoint: gisCheckpoint,
        keptLeadCount: gisKeptLeads.length,
        keptDomains: [
          ...new Set(gisKeptLeads.map((l) => deriveDomain(l.website ?? null)).filter((d): d is string => !!d)),
        ],
        qualified: gisQualified.map((c) => ({ twogisId: c.twogisId, name: c.name, site: c.site })),
      },
    };
    // Точка «upload»: seen ещё не записан, в Instantly ничего не ушло. Процесс,
    // убитый дальше, продолжится отсюда без повторных LLM, 2GIS и конструктора.
    await saveRunCheckpoint(runId, { phase: 'upload', payload: upload }, log);
    return await uploadAndFinish(ctx, upload, gis, finishRun);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Здесь seen НЕ трогаем. Сбои ДО шага 8 (HH/конструктор, в т.ч. GIS-джоб
    // 8t.3) seen не писали → компании корректно ретраятся на следующем прогоне.
    // Сбои НА/ПОСЛЕ шага 8 (append) уже прошли markSeen (шаг 8 выше append) →
    // компании зафиксированы в окне и НЕ будут пере-залиты, даже если append
    // упал частично. Так блокер «залито в Instantly, но не записано в seen →
    // дубль в окне» закрыт. Частичные gis_* счётчики пишем — сбой GIS-джоба
    // иначе был бы невидим в run-строке.
    await finishRun({ status: 'failed', error_message: message, ...gisRunPatch() });
    await deleteRunCheckpoint(runId, log);
    await logError('outreachos.run.failed', err, { runId });
    return { ...emptyResult(), runId, status: 'failed', error: message };
  }
}

/** HH-фаза свежего прогона: парс, фильтры, задание конструктора, точка «constructor». */
async function runHhPhase(ctx: RunContext): Promise<HhPhase> {
  const { db, config, runId, log } = ctx;

  // 3. HH-парс + ICP-фильтр.
  // Sink в общий hh_vacancies (см. lib/parsers/hhArchiveSink.ts). Пайплайн
  // общий для агентства, per-client user_id нет — используем служебного
  // outreachos@test.ru как «владельца» sink parser_job. Если у него в
  // profiles email не совпадает или юзер удалён — sinkJobId=null, парсер
  // отдаёт данные только клиенту (сохранённое поведение).
  const outreachosSinkOwnerEmail = process.env.OUTREACHOS_SINK_OWNER_EMAIL ?? 'outreachos@test.ru';
  const sinkOwnerId = await getUserIdByEmail(outreachosSinkOwnerEmail);
  const sinkJobId = sinkOwnerId ? await ensureArchiveSinkJob(sinkOwnerId) : null;
  const onVacancies = buildHhArchiveSinkCallback(sinkJobId);

  // Перезапуск убитого прогона берёт то же окно HH, что и он: иначе вакансии
  // между его стартом и перезапуском выпали бы из обоих дней.
  const windowEnd = ctx.anchorStartedAt ? Date.parse(ctx.anchorStartedAt) : Date.now();
  const since = new Date(windowEnd - config.window_hours * 3600_000);
  if (ctx.anchorStartedAt) {
    log(`Перезапуск убитого прогона: HH с окна прежнего старта, с ${since.toISOString()}`);
  }
  const seen = await loadRecentlySeen();
  const employers = await findNewHhEmployers({
    since,
    area: config.area,
    industries: config.industries.length > 0 ? config.industries : undefined,
    excludePatterns: buildExcludePatterns(config.extra_exclude),
    maxEmployees: config.max_employees ?? undefined,
    limit: config.daily_limit,
    exhaustive: true,
    skipEmployerIds: seen.ids,
    log: (m) => log(`[hh] ${m}`),
    onVacancies,
  });
  log(`HH вернул ${employers.length} работодателей (после ICP-фильтра)`);

  // 3b. Структурный B2C/ИП-отсев по названию+домену (excludeB2c.ts): школы,
  //     отели, ИП-ФИО, .shop и т.п. — ДО конструктора, чтобы не жечь скрейп
  //     на компании, которым мы всё равно не пишем. Отсев только наш,
  //     общий конструктор/HH-парсер не меняются.
  const b2cFiltered = employers.filter(
    (e) => !isOutreachOsB2cCompany(e.name ?? '', e.siteUrl ?? ''),
  );
  if (b2cFiltered.length < employers.length) {
    log(`B2C/ИП-отсев: -${employers.length - b2cFiltered.length} → ${b2cFiltered.length}`);
  }

  // 3c. SUPPRESSION: наши клиенты (AMO) не должны получать self-outreach
  //     НИКОГДА. Fail-closed: не смогли прочитать список — роняем прогон
  //     (пропущенный день лучше письма собственному клиенту); сбой ДО шага 8,
  //     так что завтра всё ретраится. Компании клиентов отсеиваются по домену
  //     сайта ДО конструктора; рубеж по почте — в gridToLeadPayloads.
  const suppression = await loadSuppression(db);
  log(`Suppression-список: ${suppression.emails.size} почт, ${suppression.domains.size} доменов`);
  const icp = b2cFiltered.filter((e) => !isSuppressedCompany(e.siteUrl ?? '', suppression));
  if (icp.length < b2cFiltered.length) {
    log(`Suppression-отсев клиентов: -${b2cFiltered.length - icp.length} → ${icp.length}`);
  }

  // 4. Дедуп по статусному окну: для отправленных и LLM-шума —
  //    RECONTACT_AFTER_DAYS, для no_email — короткий срок повторной проверки.
  //    Проверяем HH id И домен сайта.
  const fresh = icp.filter((e) => {
    if (seen.ids.has(e.id)) return false;
    const d = deriveDomain(e.siteUrl);
    return !(d && seen.domains.has(d));
  });
  log(`Доступных после seen-дедупа (отправленные: ${RECONTACT_AFTER_DAYS}д): ${fresh.length}`);

  // 5. Сетка → base_constructor_jobs (чистка/валидация без ta_scoring/persona).
  //    Пустой HH не блокирует цель GIS.
  const runDate = new Date().toISOString().slice(0, 10);
  let baseJobId: string | null = null;
  if (fresh.length > 0) {
    baseJobId = await createBaseConstructorJob(db, {
      userId: config.client_user_id,
      fileName: `outreachos-${runDate}`,
      grid: employersToGrid(fresh),
      selectedSteps: config.selected_steps,
      log,
    });
    // Сразу в run-строку: иначе убитый прогон теряет ссылку на готовую выгрузку.
    const { error } = await db.from('outreachos_pipeline_runs').update({ base_job_id: baseJobId }).eq('id', runId);
    if (error) log(`[checkpoint] base_job_id не записан в прогон: ${error.message}`);
  }

  const totals: HhPhaseTotals = {
    runDate,
    parsed: employers.length,
    afterIcp: icp.length,
    newEmployers: fresh.length,
    baseJobId,
  };
  const batchDomains = new Set(
    employers.map((e) => deriveDomain(e.siteUrl)).filter((d): d is string => Boolean(d)),
  );
  // Точка «constructor»: погибший дальше процесс продолжится отсюда, не
  // повторяя HH и конструктор (он доработает задание и без нас).
  await saveRunCheckpoint(runId, {
    phase: 'constructor',
    payload: {
      version: CHECKPOINT_VERSION,
      ...totals,
      fresh: fresh.map(compactEmployer),
      batchDomains: [...batchDomains],
    },
  }, log);

  const finalGrid = baseJobId
    ? await waitForBaseConstructorJob(db, baseJobId, {
        pollTimeoutMinutes: config.job_poll_timeout_minutes,
        pollIntervalMs: ctx.pollIntervalMs,
      })
    : null;
  return { totals, fresh, batchDomains, suppression, seen, finalGrid };
}

/** Продолжение с точки «constructor»: HH уже собран, ждём то же задание. */
async function restoreHhPhase(ctx: RunContext, cp: ConstructorPayload): Promise<HhPhase> {
  const { db, config, log } = ctx;
  // Suppression читаем заново и так же fail-closed: клиенты могли добавиться.
  const suppression = await loadSuppression(db);
  log(`Suppression-список: ${suppression.emails.size} почт, ${suppression.domains.size} доменов`);
  const fresh = cp.fresh.map(restoreEmployer);
  log(
    `HH из контрольной точки: работодателей ${cp.parsed}, после ICP ${cp.afterIcp}, новых ${fresh.length}` +
      (cp.baseJobId ? `; ждём задание конструктора ${cp.baseJobId}` : ''),
  );
  const finalGrid = cp.baseJobId
    ? await waitForBaseConstructorJob(db, cp.baseJobId, {
        pollTimeoutMinutes: config.job_poll_timeout_minutes,
        pollIntervalMs: ctx.pollIntervalMs,
      })
    : null;
  return {
    totals: {
      runDate: cp.runDate,
      parsed: cp.parsed,
      afterIcp: cp.afterIcp,
      newEmployers: cp.newEmployers,
      baseJobId: cp.baseJobId,
    },
    fresh,
    batchDomains: new Set(cp.batchDomains),
    suppression,
    seen: null,
    finalGrid,
  };
}

/** Шаги 8–9: seen, дедуп против своих кампаний, заливка, итог прогона. */
async function uploadAndFinish(
  ctx: RunContext,
  upload: UploadPayload,
  gis: GisRunState,
  finishRun: FinishRun,
): Promise<OutreachOsRunResult> {
  const { config, runId, log } = ctx;
  const campaignId = config.campaign_id;
  if (!campaignId) {
    throw new Error('campaign_id отсутствует в live-режиме (не должно случаться)');
  }
  const keptLeads = upload.keptLeads;

  // 8. ФИКСИРУЕМ seen-окно ДО append. append необратим (лиды улетают в
  //    Instantly, возможно несколькими chunk'ами по 1000); если он затем
  //    частично/полностью упадёт, эти компании НЕЛЬЗЯ пере-залить на следующем
  //    прогоне (клиент чистит кампанию → skip_if_in_campaign не спасёт). Поэтому
  //    окно seen ставится РАНЬШЕ, чем хоть один лид попал в Instantly.
  //    Ранние сбои (HH/конструктор, выше) сюда не доходят → корректно ретраятся.
  //    Если markSeen упадёт — append (ниже) не выполнится → компании ретраятся,
  //    в Instantly чисто. Цена: при чистом полном сбое append (ничего не залито)
  //    кандидатов с email на 45 дней не трогаем — осознанно (под-контакт ОК,
  //    пере-контакт — нет; требование «не чаще раза в 1.5 месяца»).
  //    При продолжении с точки «upload» запись повторяется: upsert идемпотентен.
  await markSeen(upload.seenRows);
  // Продвигаем только обработанный участок после seen. Сбой конструктора
  // или markSeen оставляет позицию для ретрая; GIS measure_only её не меняет.
  if (upload.gis.scanCheckpoint && !upload.gis.measureOnly) {
    await saveGisScanState(upload.gis.scanCheckpoint, log);
  }

  // 8b. ДЕДУП ПРОТИВ СВОИХ КАМПАНИЙ (до Instantly). Мы шлём с
  //     skip_if_in_campaign=false, потому что этот флаг у Instantly работает
  //     на весь воркспейс и режет наши лиды по пересечению с ЧУЖИМИ клиентскими
  //     кампаниями (у нас параллельно крутятся клиенты «под ключ»). Раз
  //     воркспейс-дедуп выключен — сами не допускаем дубль в СВОИХ A/B (иначе
  //     ре-контакт спустя 45д без чистки кампании создал бы вторую копию лида).
  //     Он же отсекает лиды, которые успела залить убитая попытка прогона.
  //     Fail-soft: не смогли прочитать кампании — шлём как есть (риск редкого
  //     дубля лучше потери прогона; seen уже зафиксирован).
  const campaignIdB = config.campaign_id_b;
  const ourCampaigns = [campaignId, ...(campaignIdB ? [campaignIdB] : [])];
  let existingEmails = new Set<string>();
  try {
    if (keptLeads.length > 0) {
      existingEmails = await fetchExistingCampaignEmails(config.client_user_id, ourCampaigns);
    }
  } catch (err) {
    log(`[dedup] не удалось прочитать свои кампании (${err instanceof Error ? err.message : String(err)}) — шлём без дедупа против своих`);
  }
  const sendLeads = keptLeads.filter((l) => !existingEmails.has(l.email.trim().toLowerCase()));
  if (sendLeads.length < keptLeads.length) {
    log(`Дедуп против своих кампаний: -${keptLeads.length - sendLeads.length} (уже в наших A/B) → ${sendLeads.length}`);
  }

  // 9. Добор в кампании Instantly. При заданной campaign_id_b — A/B-сплит
  //    офферов: лиды делятся 50/50 детерминированно по домену КОМПАНИИ
  //    (hash%2), чтобы все почты одной компании попали в ОДНУ кампанию (одна
  //    фирма не должна получить два разных оффера) и чтобы при ретраях лид не
  //    мигрировал между кампаниями. GIS-лиды top-up'а идут тем же сплитом —
  //    отдельная кампания C не заводится (решение §7.2 дизайн-дока).
  const batches: { campaign: string; label: 'A' | 'B'; leads: typeof sendLeads; accepted: number }[] = [];
  if (campaignIdB) {
    const a: typeof sendLeads = [];
    const b: typeof sendLeads = [];
    for (const l of sendLeads) (splitBucket(l.website ?? '', l.email) === 0 ? a : b).push(l);
    batches.push({ campaign: campaignId, label: 'A', leads: a, accepted: 0 });
    batches.push({ campaign: campaignIdB, label: 'B', leads: b, accepted: 0 });
    log(`A/B-сплит по домену компании: A=${a.length} B=${b.length}`);
  } else {
    batches.push({ campaign: campaignId, label: 'A', leads: sendLeads, accepted: 0 });
  }

  let acceptedA = 0;
  let acceptedB = 0;
  let skippedTotal = 0;
  const appendErrors: string[] = [];
  for (const batch of batches) {
    if (batch.leads.length === 0) continue;
    try {
      const res = await appendLeadsToClientCampaign({
        userId: config.client_user_id,
        campaignId: batch.campaign,
        leads: batch.leads,
        contextLabel: `OutreachOS daily (${batch.label})`,
        // false: Instantly НЕ режет по пересечению с чужими клиентскими
        // кампаниями (флаг у него воркспейс-широкий). Свой дедуп — шаг 8b.
        skipIfInCampaign: false,
      });
      batch.accepted = res.accepted;
      if (batch.label === 'A') acceptedA = res.accepted;
      else acceptedB = res.accepted;
      skippedTotal += res.skipped;
      log(`Instantly [${batch.label}]: accepted=${res.accepted} skipped=${res.skipped}`);
    } catch (err) {
      // Сбой одной кампании не отменяет вторую: seen уже зафиксирован (шаг 8),
      // пере-заливки этих компаний не будет — фиксируем ошибку и продолжаем.
      appendErrors.push(`[${batch.label}] ${err instanceof Error ? err.message : String(err)}`);
      await logError('outreachos.append.failed', err, { runId, campaign: batch.campaign });
    }
  }
  const totalAccepted = acceptedA + acceptedB;
  const runStatus: 'completed' | 'failed' = appendErrors.length > 0 ? 'failed' : 'completed';

  // §4.3: gis_signal_seen_companies («залитые навсегда») — пишем ТОЛЬКО
  //    GIS-компании, чей ≥1 контакт реально ушёл в Instantly, ПОСЛЕ успешного
  //    append (зеркально gisSignalOutreach/pipelineRunner шагу 5; at-least-once:
  //    append упал → журнал не пишем → компания ретраится). append режет хвост
  //    по тарифному остатку (slice-префикс) — залиты ровно первые accepted
  //    лидов каждого батча. Если append GIS-лидов упал (appendErrors), их нет
  //    в этом журнале (ретрай), НО в outreachos_seen_employers они уже записаны
  //    шагом 8 — осознанная цена, как в HH-ветке (компания будет пропущена 45д,
  //    а GIS-пайплайн её не тронет благодаря обратному кросс-дедупу §4.2).
  if (gis.executed && !upload.gis.measureOnly && upload.gis.keptLeadCount > 0) {
    const gisKeptDomains = new Set(upload.gis.keptDomains);
    const appendedGisDomains = new Set<string>();
    for (const batch of batches) {
      if (batch.accepted <= 0) continue;
      for (const l of batch.leads.slice(0, batch.accepted)) {
        const d = deriveDomain(l.website ?? null);
        if (d && gisKeptDomains.has(d)) {
          appendedGisDomains.add(d);
          gis.counters.appended += 1;
        }
      }
    }
    const gisSeenCompanyRows = upload.gis.qualified
      .filter((c) => {
        const d = deriveDomain(c.site);
        return d !== null && appendedGisDomains.has(d);
      })
      .map((c) => ({
        twogis_id: c.twogisId,
        domain: deriveDomain(c.site),
        company_name: c.name || null,
      }));
    if (gisSeenCompanyRows.length > 0) {
      await markGisSignalSeen(gisSeenCompanyRows);
    }
    log(`[gis-topup] appended=${gis.counters.appended}, в gis_signal_seen_companies записано компаний: ${gisSeenCompanyRows.length}`);
  }

  await finishRun({
    status: runStatus,
    parsed: upload.parsed,
    after_icp: upload.afterIcp,
    new_employers: upload.newEmployers,
    base_job_id: upload.baseJobId,
    valid_contacts: upload.validContacts,
    // LLM-отсев персистится (миграция 20260706_0001): без этого разница
    // valid_contacts↔appended в БД неотличима от отказов Instantly, а
    // деградация модели (шум 90%) незаметна до ручного чтения логов.
    // llm_kept — HH-only счётчик ДО объединения с GIS (у GIS свои gis_* колонки).
    llm_noise: upload.llm.noise,
    llm_kept: upload.llm.kept,
    llm_failed_batches: upload.llm.failedBatches,
    llm_guard_tripped: upload.llm.guardTripped,
    appended: acceptedA,
    appended_b: acceptedB,
    skipped: skippedTotal,
    // Телеметрия 2GIS top-up'а (миграция 20260811_0001); NULL, если топ-ап не запускался.
    ...(gis.executed
      ? {
          gis_pulled: gis.counters.pulled,
          gis_after_dedup: gis.counters.afterDedup,
          gis_valid_contacts: gis.counters.validContacts,
          gis_llm_kept: gis.counters.llmKept,
          gis_appended: gis.counters.appended,
        }
      : {}),
    ...(appendErrors.length > 0 ? { error_message: appendErrors.join('; ') } : {}),
  });
  await deleteRunCheckpoint(runId, log);

  await logAudit('outreachos.run.completed', 'OutreachOS daily pipeline completed', {
    runId,
    parsed: upload.parsed,
    newEmployers: upload.newEmployers,
    validContacts: upload.validContacts,
    llmNoise: upload.llm.noise,
    llmKept: upload.llm.kept,
    llmFailedBatches: upload.llm.failedBatches,
    llmGuardTripped: upload.llm.guardTripped,
    appendedA: acceptedA,
    appendedB: acceptedB,
    appendErrors: appendErrors.length,
    ...(gis.executed
      ? {
          gisPulled: gis.counters.pulled,
          gisAfterDedup: gis.counters.afterDedup,
          gisValidContacts: gis.counters.validContacts,
          gisLlmKept: gis.counters.llmKept,
          gisAppended: gis.counters.appended,
          gisMeasureOnly: upload.gis.measureOnly,
        }
      : {}),
  });

  return {
    runId,
    status: runStatus,
    parsed: upload.parsed,
    newEmployers: upload.newEmployers,
    validContacts: upload.validContacts,
    appended: totalAccepted,
    skipped: skippedTotal,
    ...(gis.executed
      ? {
          gisTopup: {
            pulled: gis.counters.pulled,
            afterDedup: gis.counters.afterDedup,
            validContacts: gis.counters.validContacts,
            llmKept: gis.counters.llmKept,
            appended: gis.counters.appended,
          },
        }
      : {}),
    ...(appendErrors.length > 0 ? { error: appendErrors.join('; ') } : {}),
  };
}

/**
 * Читает suppression-список целиком (пагинация по 1000 — PostgREST режет
 * большие выборки). 3 попытки, затем throw: suppression обязателен (fail-closed).
 */
async function loadSuppression(
  db: NonNullable<typeof supabaseAdmin>,
): Promise<OutreachOsSuppression> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const emails = new Set<string>();
      const domains = new Set<string>();
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from('outreachos_suppression')
          .select('kind, value')
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as { kind: string; value: string }[];
        for (const r of rows) {
          const v = (r.value ?? '').trim().toLowerCase();
          if (!v) continue;
          if (r.kind === 'email') emails.add(v);
          else if (r.kind === 'domain') domains.add(v);
        }
        if (rows.length < PAGE) break;
      }
      return { emails, domains };
    } catch (err) {
      if (attempt === 3) {
        throw new Error(
          `suppression load failed (клиентам писать нельзя — прогон остановлен): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(2000 * attempt);
    }
  }
  return EMPTY_SUPPRESSION; // недостижимо, для типов
}

/**
 * Детерминированный сплит 50/50 для A/B офферов: bucket по домену КОМПАНИИ
 * (сайт; fallback — домен почты). djb2-hash % 2 — стабилен между прогонами
 * (одна компания всегда в одной кампании) и не зависит от порядка лидов.
 */
export function splitBucket(website: string, email: string): 0 | 1 {
  const key =
    deriveDomain(website.trim() || null) ??
    email.slice(email.indexOf('@') + 1).toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return (h % 2) as 0 | 1;
}

/**
 * Фабрика маппера HhEmployer → SeenEmployerUpsert. Статусы: домен в leadDomains
 * → 'appended'; в skippedDomains (LLM-шум: почты найдены, отсеяли сами) →
 * 'skipped'; иначе fallback ('no_email' = скрейп реально не нашёл почту).
 */
function toSeen(
  leadDomains: Set<string>,
  skippedDomains: Set<string>,
  fallback: SeenEmployerUpsert['status'],
): (e: HhEmployer) => SeenEmployerUpsert {
  return (e) => {
    const domain = deriveDomain(e.siteUrl);
    const status: SeenEmployerUpsert['status'] = !domain
      ? fallback
      : leadDomains.has(domain)
        ? 'appended'
        : skippedDomains.has(domain)
          ? 'skipped'
          : fallback;
    return {
      hh_employer_id: e.id,
      hh_employer_name: e.name ?? null,
      domain,
      site_url: e.siteUrl,
      status,
    };
  };
}

/**
 * Фабрика маппера GisTopupCandidate → SeenEmployerUpsert (§4.3 дизайн-дока).
 * Те же правила статусов, что toSeen для HH-ветки; hh_employer_id = NULL (у
 * карточки 2GIS нет hh id — дедуп-ось domain). Вызывается только в live-режиме
 * топ-апа, markSeen строго ДО append — как у HH.
 */
function toGisSeen(
  leadDomains: Set<string>,
  gisNoiseDomains: Set<string>,
): (c: GisTopupCandidate) => SeenEmployerUpsert {
  return (c) => {
    const domain = deriveDomain(c.site);
    const status: SeenEmployerUpsert['status'] = !domain
      ? 'no_email'
      : leadDomains.has(domain)
        ? 'appended'
        : gisNoiseDomains.has(domain)
          ? 'skipped'
          : 'no_email';
    return {
      hh_employer_id: null,
      hh_employer_name: c.name || null,
      domain,
      site_url: c.site || null,
      status,
    };
  };
}

/** Вставка base_constructor_jobs; возвращает id задания. */
async function createBaseConstructorJob(
  db: Db,
  opts: {
    userId: string;
    fileName: string;
    grid: string[][];
    selectedSteps: string[];
    log: Logger;
  },
): Promise<string> {
  const { data: jobRow, error: jobErr } = await db
    .from('base_constructor_jobs')
    .insert({
      user_id: opts.userId,
      workload_origin: 'automation',
      file_name: opts.fileName,
      data: opts.grid,
      selected_steps: opts.selectedSteps,
      // find_emails пишет прямо в колонку Email (а не в отдельную «Найденный
      // Email» с последующим merge) — убираем неявную зависимость от порядка
      // шагов: даже без промежуточных шагов почты сразу в Email.
      step_config: { find_emails_target: 'same' },
      initial_row_count: opts.grid.length - 1,
      total_steps: opts.selectedSteps.length,
    })
    .select('id')
    .single();
  if (jobErr || !jobRow) {
    throw new Error(`base job insert failed: ${jobErr?.message}`);
  }
  const jobId = (jobRow as { id: string }).id;
  opts.log(`Создан base_constructor_job ${jobId} (${opts.grid.length - 1} строк, шаги: ${opts.selectedSteps.join(',')})`);
  return jobId;
}

/**
 * Poll-цикл ожидания задания (общий для HH-джоба шага 5, GIS top-up джоба 8t.3
 * и продолжения с точки «constructor»): не-completed или таймаут = throw =
 * ошибка прогона. В цикле тянем ТОЛЬКО status (data-блоб может быть
 * мегабайтами), финальную сетку забираем один раз по завершении.
 */
async function waitForBaseConstructorJob(
  db: Db,
  jobId: string,
  opts: { pollTimeoutMinutes: number; pollIntervalMs: number },
): Promise<string[][] | null> {
  const deadline = Date.now() + opts.pollTimeoutMinutes * 60_000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`base job ${jobId} не завершился за ${opts.pollTimeoutMinutes} мин`);
    }
    await sleep(opts.pollIntervalMs);
    const { data: js } = await db
      .from('base_constructor_jobs')
      .select('status, error_message')
      .eq('id', jobId)
      .maybeSingle();
    const status = (js as { status?: string } | null)?.status;
    if (!status || !TERMINAL_STATUSES.has(status)) continue;
    if (status !== 'completed') {
      const em = (js as { error_message?: string } | null)?.error_message;
      throw new Error(`base job ${jobId} завершился со status=${status}: ${em ?? 'no message'}`);
    }
    const { data: full } = await db
      .from('base_constructor_jobs')
      .select('data')
      .eq('id', jobId)
      .maybeSingle();
    return (full as { data?: string[][] } | null)?.data ?? null;
  }
}

/** Создать задание и дождаться его (GIS top-up джоб 8t.3). */
async function runBaseConstructorJob(
  db: Db,
  opts: {
    userId: string;
    fileName: string;
    grid: string[][];
    selectedSteps: string[];
    pollTimeoutMinutes: number;
    pollIntervalMs: number;
    log: Logger;
  },
): Promise<{ jobId: string; finalGrid: string[][] | null }> {
  const jobId = await createBaseConstructorJob(db, opts);
  return { jobId, finalGrid: await waitForBaseConstructorJob(db, jobId, opts) };
}
