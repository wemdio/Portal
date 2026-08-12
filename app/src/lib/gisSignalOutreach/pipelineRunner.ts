/**
 * gisSignalOutreach daily pipeline orchestrator — 2GIS → сигналы → конструктор → Instantly.
 *
 * Поток (раз в сутки, см. worker/gisSignalOutreachCron.ts):
 *
 *   1. Загрузить singleton-конфиг + активные сегменты. Выключен → выйти.
 *      measure_only=true → полная воронка, но БЕЗ заливки в Instantly и БЕЗ
 *      записи seen (замер неразрушающий и повторяемый).
 *   2. Кандидаты из 2GIS по рубрикам сегментов (segments.ts): seen-дедуп,
 *      дедуп свежих проверок по архиву (окно RECHECK_AFTER_DAYS=30),
 *      cross-segment дедуп (первый по приоритету забирает), квота = daily_limit
 *      поровну на сегмент.
 *   3. 6-сигнальная квалификация сайта (signals.ts, конкурентность 5). КАЖДАЯ
 *      проверенная компания архивируется в gis_signal_company_signals (и pass,
 *      и fail — это аналитический срез дашборда). Дальше идут компании с
 *      signalsCount >= signal_min_count. Для сегментов с require_online=true
 *      дополнительно считается вердикт onlineFormat (по уже скачанным
 *      страницам, без лишних fetch'ей) и компания обязана иметь
 *      onlineFormat.hit — офлайн-only компании архивируются (evidence
 *      получает ключ online_format), но в конструктор НЕ идут.
 *   4. Сетка (точный заголовок референсного CSV, gridMapping.ts) → ОДИН
 *      base_constructor_jobs (user_id = config.client_user_id, шаги/step_config
 *      из конфига). Ждём, пока worker-baseconstructor доработает. Финальную
 *      сетку раскладываем обратно по сегментам через колонку id (= twogis_id).
 *   5. measure_only → журналируем воронку и ВЫХОДИМ (без заливки, без seen).
 *      Иначе per-сегментно: лиды → дедуп против уже лежащих в кампании сегмента
 *      → appendLeadsToClientCampaign. Сегмент без instantly_campaign_id
 *      пропускаем (лог + воронка). markSeen — ТОЛЬКО для компаний, чей ≥1
 *      контакт успешно залит (at-least-once: сбой append → компания ретраится).
 *   6. Финализируем run-строку: status completed/failed (CHECK constraint
 *      миграции: running/completed/failed) + funnel jsonb
 *      ({ perSegment: {...}, total: {...} }) для дашборда.
 *
 * ИЗОЛЯЦИЯ: ни одного импорта из autoPipelineRunner / mailganer* / outreachos.
 * Базовая квалификация сигнальная; сегменты со скоринг-профилем (legal)
 * фильтруются взвешенным скором 0–100 с грейдами A/B/C (scoring.ts).
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { appendLeadsToClientCampaign, fetchExistingCampaignEmails } from '@/lib/clientLaunch/appendLeads';
import { getBlockedEmailSet, filterBlockedLeads } from '@/lib/clientBlocklist/blockedContacts';
import { extractEmail } from '@/lib/tools/dfybUtils';
import { loadGisSignalConfig, loadGisSignalSegments, type GisSignalSegment } from './config';
import { getLatestTwoGisSnapshotId, pullSegmentCandidates, type SegmentCandidate } from './segments';
import { markSeen } from './seenCompanies';
import { detectOutreachSignals, type OutreachSignalsResult } from './signals';
import { companiesToGrid, gridToLeadPayloads } from './gridMapping';
import { computeSegmentScore, getSegmentScoringProfile } from './scoring';

/** Конкурентность проверки сайтов детектором сигналов. */
export const SIGNAL_CHECK_CONCURRENCY = 5;

const POLL_INTERVAL_MS = 10_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SIGNAL_ARCHIVE_CHUNK = 500;

export interface SegmentFunnel {
  pulled: number;
  signalsOk: number;
  /** Прошли online-гейт (require_online сегменты). Без гейта = signalsOk. */
  onlineOk: number;
  bcIn: number;
  validContacts: number;
  appended: number;
}

export interface GisSignalFunnel {
  perSegment: Record<string, SegmentFunnel>;
  total: SegmentFunnel;
}

export interface GisSignalRunResult {
  runId: string | number | null;
  status: 'completed' | 'failed' | 'skipped';
  pulled: number;
  signalsOk: number;
  onlineOk: number;
  validContacts: number;
  appended: number;
  error?: string;
}

type Logger = (msg: string) => void;

export interface RunOptions {
  /** Тесты подставляют ~0, чтобы не ждать реальный poll-интервал. */
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyFunnel(): SegmentFunnel {
  return { pulled: 0, signalsOk: 0, onlineOk: 0, bcIn: 0, validContacts: 0, appended: 0 };
}

/** Хост сайта (без протокола/www/пути), lowercase. null если не парсится. */
function domainOf(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Ограниченная конкурентность: пул воркеров по индексу, порядок результатов сохранён. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

export async function runGisSignalPipeline(
  log: Logger = () => {},
  opts: RunOptions = {},
): Promise<GisSignalRunResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const empty: GisSignalRunResult = {
    runId: null,
    status: 'skipped',
    pulled: 0,
    signalsOk: 0,
    onlineOk: 0,
    validContacts: 0,
    appended: 0,
  };

  if (!supabaseAdmin) {
    return { ...empty, status: 'failed', error: 'supabaseAdmin unavailable' };
  }
  const db = supabaseAdmin;

  // 1. Конфиг + сегменты.
  const config = await loadGisSignalConfig();
  if (!config) {
    log('Нет gis_signal_pipeline_config (id=1) — пропускаем');
    return { ...empty, error: 'no_config' };
  }
  if (!config.enabled) {
    log('Пайплайн выключен (enabled=false) — пропускаем');
    return empty;
  }
  const measureOnly = config.measure_only === true;
  if (!config.client_user_id) {
    log('Не задан client_user_id — некуда класть base_constructor_job, пропускаем');
    return { ...empty, error: 'no_client_user_id' };
  }
  if (config.selected_steps.length === 0) {
    log('Пустой selected_steps — нечего прогонять, пропускаем');
    return { ...empty, error: 'no_steps' };
  }
  const segments = await loadGisSignalSegments();
  if (segments.length === 0) {
    log('Нет активных сегментов (gis_signal_segments enabled=true) — пропускаем');
    return { ...empty, error: 'no_segments' };
  }
  if (!measureOnly && segments.every((s) => !s.instantly_campaign_id)) {
    log('Ни у одного сегмента не задан instantly_campaign_id (и не measure_only) — пропускаем');
    return { ...empty, error: 'no_campaigns' };
  }
  const clientUserId = config.client_user_id;
  // Сегменты с online-гейтом: компания обязана иметь onlineFormat.hit,
  // чтобы попасть в конструктор (напр. edu — только онлайн-школы).
  const requireOnlineSegments = new Set(
    segments.filter((s) => s.require_online).map((s) => s.key),
  );

  // 2. Run row.
  const { data: runRow, error: runErr } = await db
    .from('gis_signal_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) {
    return { ...empty, status: 'failed', error: `run insert failed: ${runErr?.message}` };
  }
  const runId = (runRow as { id: string | number }).id;

  const finishRun = async (patch: Record<string, unknown>): Promise<void> => {
    await db
      .from('gis_signal_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runId);
  };

  const funnel: GisSignalFunnel = { perSegment: {}, total: emptyFunnel() };
  for (const s of segments) funnel.perSegment[s.key] = emptyFunnel();

  try {
    // 3. Кандидаты из 2GIS. Снапшот нужен iterateTwoGisCards явно (стрим
    //    привязан к срезу датасета, импорт нового не ломает курсор).
    const snapshotId = await getLatestTwoGisSnapshotId();
    if (!snapshotId) {
      throw new Error('2GIS dataset snapshot недоступен (TWOGIS_DATASET_DB_URL?)');
    }
    const candidates = await pullSegmentCandidates(segments, {
      dailyLimit: config.daily_limit,
      snapshotId,
      log,
    });
    for (const c of candidates) funnel.perSegment[c.segmentKey].pulled += 1;
    funnel.total.pulled = candidates.length;
    log(`Кандидатов после seen/архив/cross-segment дедупа: ${candidates.length}`);

    if (candidates.length === 0) {
      await finishRun({ status: 'completed', funnel });
      return { ...empty, runId, status: 'completed' };
    }

    // 4. Сигнальная квалификация (конкурентность SIGNAL_CHECK_CONCURRENCY).
    //    Сбой одной компании не роняет прогон: пишем fail-строку с note.
    const signalResults = await mapWithConcurrency(
      candidates,
      SIGNAL_CHECK_CONCURRENCY,
      async (cand): Promise<OutreachSignalsResult> => {
        try {
          return await detectOutreachSignals({
            siteUrl: cand.site,
            twogisPhone: cand.phone || null,
            // twogisBranchCount: null — поле branches у карточки не выгружается;
            // можно подключить позже (count филиалов сети из датасета).
            twogisBranchCount: null,
            // Онлайн-формат — только для сегментов с require_online: вердикт
            // считается по уже скачанным страницам, лишних fetch'ей нет.
            checkOnlineFormat: requireOnlineSegments.has(cand.segmentKey),
          });
        } catch (err) {
          return {
            signals: {
              generalPhone: { hit: false, evidence: '' },
              contactForm: { hit: false, evidence: '' },
              salesDept: { hit: false, evidence: '' },
              targetVacancy: { hit: false, evidence: '' },
              highVolume: { hit: false, evidence: '' },
              multiOffice: { hit: false, evidence: '' },
              legalRelevance: { hit: false, evidence: '' },
              crmCalltracking: { hit: false, evidence: '' },
            },
            signalsCount: 0,
            note: `Signal check failed: ${err instanceof Error ? err.message : String(err)}`,
            ok: false,
          };
        }
      },
    );

    // 4a. СКОРИНГ: у сегментов с профилем (legal) считаем взвешенный скор
    //     0–100 и грейд по каждой компании — до архива, чтобы записать туда.
    const scoreInfos = candidates.map((cand, i) => {
      const profile = getSegmentScoringProfile(cand.segmentKey);
      return profile ? computeSegmentScore(profile, signalResults[i].signals) : null;
    });

    // 4b. АРХИВ: каждая проверенная компания (и pass, и fail) — аналитический
    //     срез. Пишем и в measure_only: замер как раз строит этот срез.
    const archiveRows = candidates.map((cand, i) => {
      const r = signalResults[i];
      const scoring = scoreInfos[i];
      const evidence: Record<string, unknown> = {};
      for (const [key, verdict] of Object.entries(r.signals)) {
        if (verdict.hit && verdict.evidence) evidence[key] = verdict.evidence;
      }
      // Вердикт онлайн-формата (require_online сегменты) — со смыслом hit,
      // чтобы видеть и отвалившиеся ТОЛЬКО на онлайне компании.
      if (r.onlineFormat) {
        evidence.online_format = { hit: r.onlineFormat.hit, evidence: r.onlineFormat.evidence };
      }
      return {
        twogis_id: cand.twogisId,
        site: cand.site,
        segment_key: cand.segmentKey,
        signal_general_phone: r.signals.generalPhone.hit,
        signal_contact_form: r.signals.contactForm.hit,
        signal_sales_dept: r.signals.salesDept.hit,
        signal_target_vacancy: r.signals.targetVacancy.hit,
        signal_high_volume: r.signals.highVolume.hit,
        signal_multi_office: r.signals.multiOffice.hit,
        // Скоринговые булевы — для всех сегментов (архив копит данные).
        signal_legal_relevance: r.signals.legalRelevance.hit,
        signal_crm_calltracking: r.signals.crmCalltracking.hit,
        // Скор/грейд — только scored-сегменты; у остальных NULL.
        score: scoring ? scoring.score : null,
        grade: scoring ? scoring.grade : null,
        evidence,
        signals_count: r.signalsCount,
        note: r.note,
        checked_at: new Date().toISOString(),
      };
    });
    // UPSERT по twogis_id: карточка может проверяться повторно (второй
    // measure_only-замер, re-pull ещё не seen компании), а на колонке UNIQUE-
    // индекс — plain insert убивал бы весь прогон конфликтом. Последняя
    // проверка перетирает сигналы/evidence/count/note/site/segment/checked_at.
    for (let i = 0; i < archiveRows.length; i += SIGNAL_ARCHIVE_CHUNK) {
      const { error } = await db
        .from('gis_signal_company_signals')
        .upsert(archiveRows.slice(i, i + SIGNAL_ARCHIVE_CHUNK), { onConflict: 'twogis_id' });
      if (error) throw new Error(`signal archive upsert failed: ${error.message}`);
    }

    // Квалификационный фильтр: сегмент со скоринг-профилем — score >= threshold
    // (скор ниже = нерелевантна, grade=null); остальные — signalsCount >=
    // signal_min_count, как раньше. scoring.ts считает оба скора заранее.
    const signalOkPairs = candidates
      .map((cand, i) => ({ cand, signals: signalResults[i], scoring: scoreInfos[i] }))
      .filter((p) =>
        p.scoring
          ? p.scoring.grade !== null
          : p.signals.signalsCount >= config.signal_min_count,
      );
    for (const p of signalOkPairs) funnel.perSegment[p.cand.segmentKey].signalsOk += 1;
    funnel.total.signalsOk = signalOkPairs.length;
    const scoredSegments = Array.from(
      new Set(signalOkPairs.map((p) => p.cand.segmentKey).filter((k) => getSegmentScoringProfile(k))),
    );
    log(
      `Прошли сигнальный фильтр (>=${config.signal_min_count}` +
        `${scoredSegments.length > 0 ? `; скоринг >= порога профиля для: ${scoredSegments.join(', ')}` : ''}` +
        `): ${signalOkPairs.length}/${candidates.length}`,
    );

    // 4c. ONLINE-гейт: сегменты с require_online пропускают только компании с
    //     onlineFormat.hit. У сегментов без флага onlineOk === signalsOk.
    //     Отвалившиеся ТОЛЬКО на онлайне уже заархивированы (шаг 4b, ключ
    //     online_format в evidence) — в конструктор они не идут.
    const qualifiedPairs = signalOkPairs.filter(
      (p) => !requireOnlineSegments.has(p.cand.segmentKey) || p.signals.onlineFormat?.hit === true,
    );
    const qualified = qualifiedPairs.map((p) => p.cand);
    for (const p of qualifiedPairs) funnel.perSegment[p.cand.segmentKey].onlineOk += 1;
    funnel.total.onlineOk = qualified.length;
    if (requireOnlineSegments.size > 0) {
      log(`Онлайн-гейт (${Array.from(requireOnlineSegments).join(', ')}): ${qualified.length}/${signalOkPairs.length}`);
    }

    if (qualified.length === 0) {
      await finishRun({ status: 'completed', funnel });
      return {
        ...empty,
        runId,
        status: 'completed',
        pulled: candidates.length,
        signalsOk: signalOkPairs.length,
      };
    }

    // 5. Сетка → ОДИН base_constructor_jobs. Раскладка по сегментам после
    //    прогона — через колонку id (twogis_id), позиции строк не сохраняются.
    const qualifiedById = new Map<string, { cand: SegmentCandidate; signals: OutreachSignalsResult }>();
    for (const p of qualifiedPairs) {
      qualifiedById.set(p.cand.twogisId, p);
    }
    const grid = companiesToGrid(
      qualifiedPairs.map((p) => ({
        candidate: p.cand,
        signals: p.signals,
        score: p.scoring?.score ?? null,
        grade: p.scoring?.grade ?? null,
      })),
    );
    for (const c of qualified) funnel.perSegment[c.segmentKey].bcIn += 1;
    funnel.total.bcIn = qualified.length;

    const today = new Date().toISOString().slice(0, 10);
    const { data: jobRow, error: jobErr } = await db
      .from('base_constructor_jobs')
      .insert({
        user_id: clientUserId,
        file_name: `gis-signals-${today}`,
        data: grid,
        selected_steps: config.selected_steps,
        // find_emails пишет прямо в колонку email (у 2GIS-карточек она почти
        // всегда пустая) — убираем зависимость от порядка шагов и лишнюю
        // «Найденный Email». Поверх — step_config из конфига (stop_at_first,
        // max_per_site, cap_emails_per_company.max и т.п.).
        step_config: { find_emails_target: 'same', ...config.step_config },
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

    // 6. Ждём завершения конструктора. В цикле тянем ТОЛЬКО status (не весь
    //    data-блоб — он может быть мегабайтами), сетку забираем один раз.
    const deadline = Date.now() + config.job_poll_timeout_minutes * 60_000;
    let finalGrid: string[][] | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`base job ${baseJobId} не завершился за ${config.job_poll_timeout_minutes} мин`);
      }
      await sleep(pollIntervalMs);
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

    // 7. Раскладка финальной сетки по сегментам + лиды. Строки, чей id не
    //    найден среди qualified (конструктор переименовал/мусор), пропускаем.
    const finalHeader = finalGrid?.[0] ?? [];
    const idIdx = finalHeader.findIndex((h) => (h ?? '').trim().toLowerCase() === 'id');
    const gridsBySegment = new Map<string, string[][]>();
    if (finalGrid && finalGrid.length > 1 && idIdx >= 0) {
      for (let r = 1; r < finalGrid.length; r++) {
        const row = finalGrid[r];
        const segKey = qualifiedById.get((row[idIdx] ?? '').trim())?.cand.segmentKey;
        if (!segKey) continue;
        const g = gridsBySegment.get(segKey);
        if (g) g.push(row);
        else gridsBySegment.set(segKey, [finalGrid[0], row]);
      }
    }

    const leadsBySegment = new Map<string, ReturnType<typeof gridToLeadPayloads>>();
    for (const segment of segments) {
      const segGrid = gridsBySegment.get(segment.key) ?? [finalHeader];
      const leads = gridToLeadPayloads(segGrid, segment.key);
      leadsBySegment.set(segment.key, leads);
      funnel.perSegment[segment.key].validContacts = leads.length;
      funnel.total.validContacts += leads.length;
    }
    log(`Валидных контактов на выходе конструктора: ${funnel.total.validContacts}`);

    // MEASURE-режим: только меряем воронку (pulled→signalsOk→valid). НЕ
    // заливаем в Instantly и НЕ пишем seen — замер неразрушающий и повторяемый.
    if (measureOnly) {
      await finishRun({ status: 'completed', funnel });
      log(`MEASURE: pulled=${funnel.total.pulled} signalsOk=${funnel.total.signalsOk} onlineOk=${funnel.total.onlineOk} valid=${funnel.total.validContacts} (без заливки, seen не тронут)`);
      return {
        runId,
        status: 'completed',
        pulled: funnel.total.pulled,
        signalsOk: funnel.total.signalsOk,
        onlineOk: funnel.total.onlineOk,
        validContacts: funnel.total.validContacts,
        appended: 0,
      };
    }

    // 8. Per-сегментная заливка. Дедуп против СВОЕЙ кампании делаем сами
    //    (skip_if_in_campaign=false — флаг у Instantly воркспейс-широкий и
    //    резал бы по пересечению с чужими клиентскими кампаниями). Fail-soft:
    //    не смогли прочитать кампанию — шлём без дедупа.
    //    markSeen — ТОЛЬКО после успешного append (at-least-once).
    //
    //    Чёрный список клиента применяем САМИ тем же helper'ом, что внутри
    //    appendLeadsToClientCampaign (getBlockedEmailSet/filterBlockedLeads):
    //    send-список обязан совпадать с тем, что append реально попытается
    //    залить — иначе markSeen сжигал бы компании, чьи лиды append молча
    //    отрезал блок-листом (accepted=0 при полном блоке).
    const blockedEmails = supabaseInstantly
      ? await getBlockedEmailSet(supabaseInstantly, clientUserId)
      : new Set<string>();
    const appendErrors: string[] = [];
    for (const segment of segments) {
      const leads = leadsBySegment.get(segment.key) ?? [];
      if (leads.length === 0) continue;

      if (!segment.instantly_campaign_id) {
        log(`[${segment.key}] instantly_campaign_id не задан — ${leads.length} лидов НЕ заливаем (сегмент в замере)`);
        continue;
      }
      const campaignId = segment.instantly_campaign_id;

      let existingEmails = new Set<string>();
      try {
        existingEmails = await fetchExistingCampaignEmails(clientUserId, [campaignId]);
      } catch (err) {
        log(`[${segment.key}] не удалось прочитать кампанию (${err instanceof Error ? err.message : String(err)}) — шлём без дедупа`);
      }
      const freshLeads = leads.filter((l) => !existingEmails.has(l.email.trim().toLowerCase()));
      if (freshLeads.length < leads.length) {
        log(`[${segment.key}] дедуп против кампании: -${leads.length - freshLeads.length} → ${freshLeads.length}`);
      }
      const { kept: sendLeads, blockedCount } = filterBlockedLeads(freshLeads, blockedEmails);
      if (blockedCount > 0) {
        log(`[${segment.key}] блок-лист клиента: -${blockedCount} → ${sendLeads.length}`);
      }
      if (sendLeads.length === 0) continue;

      let accepted = 0;
      try {
        const res = await appendLeadsToClientCampaign({
          userId: clientUserId,
          campaignId,
          leads: sendLeads,
          contextLabel: 'gis-signals',
          skipIfInCampaign: false,
        });
        accepted = res.accepted;
        funnel.perSegment[segment.key].appended = res.accepted;
        funnel.total.appended += res.accepted;
        log(`[${segment.key}] Instantly: accepted=${res.accepted} skipped=${res.skipped}`);
      } catch (err) {
        // Сбой одного сегмента не отменяет остальные: seen для него НЕ пишем
        // (компании ретраятся завтра), фиксируем ошибку и продолжаем.
        appendErrors.push(`[${segment.key}] ${err instanceof Error ? err.message : String(err)}`);
        await logError('gis_signal.append.failed', err, { runId, segment: segment.key });
        continue;
      }

      // markSeen: ТОЛЬКО компании первых accepted лидов send-списка —
      // appendLeadsToClientCampaign режет хвост по тарифному остатку
      // (slice-префикс), значит залиты ровно первые accepted. accepted=0 →
      // никого не помечаем: иначе сжигали бы компании, ни один лид которых
      // не дошёл до Instantly. Почта → twogis_id восстанавливаем по сегментной
      // сетке (email уникален после dedup в gridToLeadPayloads).
      if (accepted > 0) {
        const segGrid = gridsBySegment.get(segment.key) ?? [];
        const emailIdx = segGrid[0]?.findIndex((h) => (h ?? '').trim().toLowerCase() === 'email') ?? -1;
        const acceptedEmails = new Set(
          sendLeads.slice(0, accepted).map((l) => l.email.trim().toLowerCase()),
        );
        const seenIds = new Set<string>();
        if (idIdx >= 0 && emailIdx >= 0) {
          for (let r = 1; r < segGrid.length; r++) {
            const em = extractEmail(segGrid[r][emailIdx] ?? '')?.toLowerCase();
            if (em && acceptedEmails.has(em)) seenIds.add((segGrid[r][idIdx] ?? '').trim());
          }
        }
        const seenRows = Array.from(seenIds)
          .map((id) => qualifiedById.get(id))
          .filter((x): x is { cand: SegmentCandidate; signals: OutreachSignalsResult } => !!x)
          .map(({ cand }) => ({
            twogis_id: cand.twogisId,
            domain: domainOf(cand.site),
            company_name: cand.name || null,
            segment_key: cand.segmentKey,
          }));
        await markSeen(seenRows);
      }
    }

    const runStatus: 'completed' | 'failed' = appendErrors.length > 0 ? 'failed' : 'completed';
    await finishRun({
      status: runStatus,
      funnel,
      ...(appendErrors.length > 0 ? { error: appendErrors.join('; ') } : {}),
    });

    await logAudit('gis_signal.run.completed', 'gisSignalOutreach daily pipeline completed', {
      runId,
      ...funnel.total,
      appendErrors: appendErrors.length,
    });

    return {
      runId,
      status: runStatus,
      pulled: funnel.total.pulled,
      signalsOk: funnel.total.signalsOk,
      onlineOk: funnel.total.onlineOk,
      validContacts: funnel.total.validContacts,
      appended: funnel.total.appended,
      ...(appendErrors.length > 0 ? { error: appendErrors.join('; ') } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // seen здесь НЕ трогаем: markSeen пишется только сразу после успешного
    // append (шаг 8), так что сбой в любом другом месте оставляет компании
    // eligible — корректный ретрай на следующем прогоне.
    await finishRun({ status: 'failed', funnel, error: message });
    await logError('gis_signal.run.failed', err, { runId });
    return { ...empty, runId, status: 'failed', error: message };
  }
}
