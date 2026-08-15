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
 * вставлены фазы 8t.1–8t.5 — добор из 2gis_dataset при недоборе HH до
 * gis_topup_target_appended. GIS-лиды объединяются с HH keptLeads ПЕРЕД общим
 * markSeen, общим дедупом против своих кампаний и общим A/B-сплитом — отдельная
 * кампания C не заводится (решение §7.2 дизайн-дока
 * docs/design/2026-08-11-outreachos-2gis-topup.md).
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
import { toTwoGisRubricGroups } from '@/lib/twoGis/rubricGroups';
import { loadOutreachOsConfig } from './config';
import { buildExcludePatterns } from './excludePatterns';
import { isOutreachOsB2cCompany } from './excludeB2c';
import {
  EMPTY_SUPPRESSION,
  isSuppressedCompany,
  type OutreachOsSuppression,
} from './suppression';
import { llmClassifyNoise, type CompanyForClassify } from './classifyCompanies';
import { loadRecentlySeen, markSeen, RECONTACT_AFTER_DAYS, type SeenEmployerUpsert } from './seenEmployers';
import { employersToGrid, gridToLeadPayloads } from './gridMapping';
import {
  buildGisClassifyIndustries,
  computeGisPullLimit,
  computeGisTopupDeficit,
  gisCandidatesToGrid,
  loadGisSignalSeenDomains,
  markGisSignalSeen,
  pullGisTopupCandidates,
  type GisTopupCandidate,
} from './gisTopup';

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
}

type Logger = (msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOutreachOsDailyPipeline(
  log: Logger = () => {},
  opts: RunOptions = {},
): Promise<OutreachOsRunResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
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

  // Состояние 2GIS top-up'а (фазы 8t.*): объявлено ДО try, чтобы catch мог
  // записать частичные счётчики в run-строку при сбое (напр. упал GIS-джоб).
  const gisCounters = { pulled: 0, afterDedup: 0, validContacts: 0, llmKept: 0, appended: 0 };
  let gisExecuted = false;
  const gisRunPatch = (): Record<string, unknown> =>
    gisExecuted
      ? {
          gis_pulled: gisCounters.pulled,
          gis_after_dedup: gisCounters.afterDedup,
          gis_valid_contacts: gisCounters.validContacts,
          gis_llm_kept: gisCounters.llmKept,
          gis_appended: gisCounters.appended,
        }
      : {};

  try {
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

    const since = new Date(Date.now() - config.window_hours * 3600_000);
    const employers = await findNewHhEmployers({
      since,
      area: config.area,
      industries: config.industries.length > 0 ? config.industries : undefined,
      excludePatterns: buildExcludePatterns(config.extra_exclude),
      maxEmployees: config.max_employees ?? undefined,
      limit: config.daily_limit,
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

    // 4. Дедуп по окну: компании, контактированные за последние
    //    RECONTACT_AFTER_DAYS дней, пропускаем (не пишем одной компании чаще
    //    раза в 1.5 месяца). По hh_employer_id И по домену сайта. Компании
    //    старше окна — снова eligible (повторный аутрич разрешён).
    const seen = await loadRecentlySeen();
    const fresh = icp.filter((e) => {
      if (seen.ids.has(e.id)) return false;
      const d = deriveDomain(e.siteUrl);
      return !(d && seen.domains.has(d));
    });
    log(`Новых (не контактированы за ${RECONTACT_AFTER_DAYS}д): ${fresh.length}`);

    if (fresh.length === 0) {
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: icp.length,
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
    //    Вставка + poll-цикл вынесены в runBaseConstructorJob — тот же helper
    //    обслуживает второй (GIS top-up) джоб в фазе 8t.3.
    const grid = employersToGrid(fresh);
    const today = new Date().toISOString().slice(0, 10);
    const { jobId: baseJobId, finalGrid } = await runBaseConstructorJob(db, {
      userId: config.client_user_id,
      fileName: `outreachos-${today}`,
      grid,
      selectedSteps: config.selected_steps,
      pollTimeoutMinutes: config.job_poll_timeout_minutes,
      pollIntervalMs,
      log,
    });

    // 7. Сетка → лиды (с suppression-рубежом по почте/домену внутри).
    const leads = gridToLeadPayloads(finalGrid ?? [], suppression);
    log(`Валидных контактов на выходе конструктора: ${leads.length}`);

    // MEASURE-режим: только меряем воронку (parsed→new→valid). НЕ заливаем в
    // Instantly и НЕ пишем seen — замер неразрушающий и повторяемый, go-live
    // не «засевается». Ранний выход до append/seen, независимо от числа лидов.
    if (measureOnly) {
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: icp.length,
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
      await markSeen(fresh.map(toSeen(new Set(), new Set(), 'no_email')));
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: icp.length,
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

    // Сюда попадаем только в live-режиме (measureOnly=false), верхний гард
    // гарантирует, что campaign_id задан. Захватываем в const (тип → string).
    const campaignId = config.campaign_id;
    if (!campaignId) {
      throw new Error('campaign_id отсутствует в live-режиме (не должно случаться)');
    }

    // 7b. LLM-отсев B2C/ИП/гос (ТРЕТИЙ рубеж, только live): структурные правила
    //     ловят ~4%, но онлайн-школа с нейтральным доменом от B2B неотличима.
    //     Классифицируем УНИКАЛЬНЫЕ компании (не лиды), выкидываем лиды шумовых.
    //     Fail-open: сбой LLM = едем без этого фильтра, лиды не теряем.
    //     Шумовые компании остаются в fresh → попадут в markSeen (45д не трогаем
    //     — им и не надо писать; спустя окно их снова классифицирует LLM).
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
        const ctx = hhContext.get(deriveDomain(l.website ?? null) ?? '');
        uniqueCompanies.push({
          name: l.company_name ?? '',
          website: l.website ?? '',
          industries: ctx?.industries,
          description: ctx?.description,
          vacancyTitle: ctx?.vacancyTitle,
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
    // Добор из 2gis_dataset, когда HH+SJ не достаёт до цели. Точка решения —
    // ПОСЛЕ LLM (дефицит считается точно по keptLeads, а не прогнозно). В
    // «сытые» дни (deficit=0) и при выключенном флаге топ-ап не запускается
    // вовсе (второй конструктор-джоб не создаётся).
    // gis_topup_measure_only=true: фазы 8t.1–8t.4 выполняются, счётчики пишутся
    // в run, но GIS-лиды НЕ объединяются, seen по ним НЕ пишется (HH-ветка
    // работает как обычно — замер относится только к топ-апу).
    const gisMeasureOnly = config.gis_topup_measure_only;
    const gisQualified: GisTopupCandidate[] = []; // кандидаты, ушедшие в конструктор (аналог fresh)
    let gisKeptLeads: LeadCreatePayload[] = [];   // GIS-лиды после LLM (аналог keptLeads)
    const gisNoiseDomains = new Set<string>();
    const gisDeficit = computeGisTopupDeficit(config.gis_topup_target_appended, keptLeads.length);

    if (!config.gis_topup_enabled) {
      log('[gis-topup] выключен (gis_topup_enabled=false) — пропускаем');
    } else if (gisDeficit <= 0) {
      log(`[gis-topup] дефицита нет (kept=${keptLeads.length} ≥ target=${config.gis_topup_target_appended}) — пропускаем`);
    } else if (config.gis_topup_rubric_groups.length === 0) {
      log('[gis-topup] пустой gis_topup_rubric_groups — нечего тянуть, пропускаем');
    } else {
      gisExecuted = true;
      // 8t.1 PULL: latest snapshot, rubric_groups, hasWebsite=true,
      // лимит = min(cap, ceil(deficit / 0.45 * 1.3)).
      const pullLimit = computeGisPullLimit(gisDeficit, config.gis_topup_daily_cap);
      const snapshotId = await getLatestTwoGisSnapshotId();
      // §4.1.2: домены gis_signal_seen_companies — fail-closed (null): сбой
      // чтения кросс-журнала = топ-ап пропускаем, повторное письмо компании
      // GIS-пайплайна недопустимо. HH-ветка от этого не зависит.
      const gisSignalSeenDomains = await loadGisSignalSeenDomains();
      if (!snapshotId) {
        log('[gis-topup] снапшот 2gis_dataset недоступен (TWOGIS_DATASET_DB_URL?) — топ-ап пропущен, HH-ветка продолжается');
        gisExecuted = false;
      } else if (!gisSignalSeenDomains) {
        log('[gis-topup] не удалось прочитать gis_signal_seen_companies (fail-closed) — топ-ап пропущен, HH-ветка продолжается');
        gisExecuted = false;
      } else {
        // Дедуп-матрица §4.1: (а) seen OutreachOS 45д + (б) gis_signal seen +
        // (в) домены сегодняшнего HH+SJ батча; (г) внутренний — в pull'е.
        const batchDomains = new Set(
          employers.map((e) => deriveDomain(e.siteUrl)).filter((d): d is string => Boolean(d)),
        );
        const excludeDomains = new Set<string>([
          ...seen.domains,
          ...gisSignalSeenDomains,
          ...batchDomains,
        ]);
        const pull = await pullGisTopupCandidates({
          rubricGroups: toTwoGisRubricGroups(config.gis_topup_rubric_groups),
          limit: pullLimit,
          snapshotId,
          excludeDomains,
          log: (m) => log(`[gis-topup] ${m}`),
        });
        gisCounters.pulled = pull.pulled;
        log(
          `[gis-topup] 8t.1 pull: дефицит=${gisDeficit}, лимит=${pullLimit}, ` +
            `взято=${pull.pulled} (кросс-дедуп -${pull.excludedDropped}, scanned=${pull.scanned}) → кандидатов ${pull.candidates.length}`,
        );

        // 8t.2 Структурный B2C-отсев (тот же isOutreachOsB2cCompany, что шаг
        //     3b) → suppression (тот же сет шага 3c; fail-closed уже обеспечен
        //     загрузкой выше — здесь чистая фильтрация).
        const gisAfterB2c = pull.candidates.filter((c) => !isOutreachOsB2cCompany(c.name, c.site));
        if (gisAfterB2c.length < pull.candidates.length) {
          log(`[gis-topup] B2C/ИП-отсев: -${pull.candidates.length - gisAfterB2c.length} → ${gisAfterB2c.length}`);
        }
        gisQualified.push(
          ...gisAfterB2c.filter((c) => !isSuppressedCompany(c.site, suppression)),
        );
        if (gisQualified.length < gisAfterB2c.length) {
          log(`[gis-topup] Suppression-отсев клиентов: -${gisAfterB2c.length - gisQualified.length} → ${gisQualified.length}`);
        }
        gisCounters.afterDedup = gisQualified.length;

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
            fileName: `outreachos-${today}-gis-topup`,
            grid: gisGrid,
            selectedSteps: config.selected_steps,
            pollTimeoutMinutes: config.job_poll_timeout_minutes,
            pollIntervalMs,
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
          gisCounters.validContacts = gisLeads.length;
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
            gisCounters.llmKept = gisKeptLeads.length;
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
    if (gisExecuted && gisKeptLeads.length > 0) {
      if (gisMeasureOnly) {
        log(`[gis-topup] MEASURE: GIS-лиды (${gisKeptLeads.length}) НЕ объединяем — замер без заливки и seen`);
      } else {
        keptLeads = keptLeads.concat(gisKeptLeads);
        log(`[gis-topup] 8t.5 объединено: HH ${hhKeptCount} + GIS ${gisKeptLeads.length} → ${keptLeads.length}`);
      }
    }

    // 8. ФИКСИРУЕМ seen-окно ДО append. append необратим (лиды улетают в
    //    Instantly, возможно несколькими chunk'ами по 1000); если он затем
    //    частично/полностью упадёт, эти компании НЕЛЬЗЯ пере-залить на следующем
    //    прогоне (клиент чистит кампанию → skip_if_in_campaign не спасёт). Поэтому
    //    окно 45 дней ставится РАНЬШЕ, чем хоть один лид попал в Instantly.
    //    Ранние сбои (HH/конструктор, выше) сюда не доходят → корректно ретраятся.
    //    Если markSeen упадёт — append (ниже) не выполнится → компании ретраятся,
    //    в Instantly чисто. Цена: при чистом полном сбое append (ничего не залито)
    //    эти компании на 45 дней не трогаем — осознанно (под-контакт ОК,
    //    пере-контакт — нет; требование «не чаще раза в 1.5 месяца»).
    const leadDomains = new Set(
      keptLeads.map((l) => deriveDomain(l.website ?? null)).filter((d): d is string => !!d),
    );
    // §4.3: GIS-компании пишем в тот же журнал с hh_employer_id=NULL (дедуп-ось
    // — domain), статусы по тем же правилам, что HH-ветка (appended/skipped/
    // no_email). markSeen строго ДО append — как у HH.
    const gisSeenRows =
      gisExecuted && !gisMeasureOnly ? gisQualified.map(toGisSeen(leadDomains, gisNoiseDomains)) : [];
    await markSeen(fresh.map(toSeen(leadDomains, noiseDomains, 'no_email')).concat(gisSeenRows));

    // 8b. ДЕДУП ПРОТИВ СВОИХ КАМПАНИЙ (до Instantly). Мы шлём с
    //     skip_if_in_campaign=false, потому что этот флаг у Instantly работает
    //     на весь воркспейс и режет наши лиды по пересечению с ЧУЖИМИ клиентскими
    //     кампаниями (у нас параллельно крутятся клиенты «под ключ»). Раз
    //     воркспейс-дедуп выключен — сами не допускаем дубль в СВОИХ A/B (иначе
    //     ре-контакт спустя 45д без чистки кампании создал бы вторую копию лида).
    //     Fail-soft: не смогли прочитать кампании — шлём как есть (риск редкого
    //     дубля лучше потери прогона; seen уже зафиксирован).
    const campaignIdB = config.campaign_id_b;
    const ourCampaigns = [campaignId, ...(campaignIdB ? [campaignIdB] : [])];
    let existingEmails = new Set<string>();
    try {
      existingEmails = await fetchExistingCampaignEmails(config.client_user_id, ourCampaigns);
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
    if (gisExecuted && !gisMeasureOnly && gisKeptLeads.length > 0) {
      const gisKeptDomains = new Set(
        gisKeptLeads.map((l) => deriveDomain(l.website ?? null)).filter((d): d is string => !!d),
      );
      const appendedGisDomains = new Set<string>();
      for (const batch of batches) {
        if (batch.accepted <= 0) continue;
        for (const l of batch.leads.slice(0, batch.accepted)) {
          const d = deriveDomain(l.website ?? null);
          if (d && gisKeptDomains.has(d)) {
            appendedGisDomains.add(d);
            gisCounters.appended += 1;
          }
        }
      }
      const gisSeenCompanyRows = gisQualified
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
      log(`[gis-topup] appended=${gisCounters.appended}, в gis_signal_seen_companies записано компаний: ${gisSeenCompanyRows.length}`);
    }

    await finishRun({
      status: runStatus,
      parsed: employers.length,
      after_icp: icp.length,
      new_employers: fresh.length,
      base_job_id: baseJobId,
      valid_contacts: leads.length,
      // LLM-отсев персистится (миграция 20260706_0001): без этого разница
      // valid_contacts↔appended в БД неотличима от отказов Instantly, а
      // деградация модели (шум 90%) незаметна до ручного чтения логов.
      // llm_kept — HH-only счётчик ДО объединения с GIS (у GIS свои gis_* колонки).
      llm_noise: llm.noise.size,
      llm_kept: hhKeptCount,
      llm_failed_batches: llm.failedBatches,
      llm_guard_tripped: llm.guardTripped,
      appended: acceptedA,
      appended_b: acceptedB,
      skipped: skippedTotal,
      // Телеметрия 2GIS top-up'а (миграция 20260811_0001); NULL, если топ-ап не запускался.
      ...gisRunPatch(),
      ...(appendErrors.length > 0 ? { error_message: appendErrors.join('; ') } : {}),
    });

    await logAudit('outreachos.run.completed', 'OutreachOS daily pipeline completed', {
      runId,
      parsed: employers.length,
      newEmployers: fresh.length,
      validContacts: leads.length,
      llmNoise: llm.noise.size,
      llmKept: hhKeptCount,
      llmFailedBatches: llm.failedBatches,
      llmGuardTripped: llm.guardTripped,
      appendedA: acceptedA,
      appendedB: acceptedB,
      appendErrors: appendErrors.length,
      ...(gisExecuted
        ? {
            gisPulled: gisCounters.pulled,
            gisAfterDedup: gisCounters.afterDedup,
            gisValidContacts: gisCounters.validContacts,
            gisLlmKept: gisCounters.llmKept,
            gisAppended: gisCounters.appended,
            gisMeasureOnly,
          }
        : {}),
    });

    return {
      runId,
      status: runStatus,
      parsed: employers.length,
      newEmployers: fresh.length,
      validContacts: leads.length,
      appended: totalAccepted,
      skipped: skippedTotal,
      ...(gisExecuted
        ? {
            gisTopup: {
              pulled: gisCounters.pulled,
              afterDedup: gisCounters.afterDedup,
              validContacts: gisCounters.validContacts,
              llmKept: gisCounters.llmKept,
              appended: gisCounters.appended,
            },
          }
        : {}),
      ...(appendErrors.length > 0 ? { error: appendErrors.join('; ') } : {}),
    };
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
    await logError('outreachos.run.failed', err, { runId });
    return { ...empty, runId, status: 'failed', error: message };
  }
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

/**
 * Вставка base_constructor_jobs + poll-цикл ожидания (общий для HH-джоба шага 5
 * и GIS top-up джоба 8t.3 — одинаковые selected_steps/step_config, терминальные
 * статусы и семантика ошибок: не-completed или таймаут = throw = ошибка прогона).
 * В цикле тянем ТОЛЬКО status (data-блоб может быть мегабайтами), финальную
 * сетку забираем один раз по завершении.
 */
async function runBaseConstructorJob(
  db: NonNullable<typeof supabaseAdmin>,
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
  const { data: jobRow, error: jobErr } = await db
    .from('base_constructor_jobs')
    .insert({
      user_id: opts.userId,
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
    return { jobId, finalGrid: (full as { data?: string[][] } | null)?.data ?? null };
  }
}
