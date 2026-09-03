/**
 * Manual scoring runner — обрабатывает один прогон.
 *
 * Используется воркером manualScoringWorker. Также может быть вызван
 * напрямую для тестирования.
 *
 * Bucket'ы фиксированные (по решению клиента — независимы от auto-pipeline
 * configs, который может меняться):
 *   storage:   0 ≤ score ≤ 1000     — «не пишем», только domain+score в CSV
 *   medium:    1001 ≤ score ≤ 15000 — enrich email + SMTP
 *   high:      15001 ≤ score ≤ 1M   — enrich email + SMTP
 *   top:       score > 1M           — enrich email + SMTP
 *   invalid:   score === null       — Mailganer не ответил / неверный domain
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOrFetchScore, normalizeDomain } from './mailganerScoreCache';
import { validateEmailForAutoPipeline } from './autoPipelineEmailValidation';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import type { DomainInfo } from '@/lib/emailValidation/shared';
import { cleanCompanyNames } from '@/lib/companyNameCleanupBatch';
import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import { partialAppendOutcome, selectAcceptedItems } from '@/lib/clientReports/appendOutcome';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  buildManualScoringDomainSnapshot,
  persistDomainSnapshots,
} from '@/lib/clientReports/domainSnapshots';

export type ManualBucket = 'storage' | 'medium' | 'high' | 'top' | 'invalid';

export function classifyScore(score: number | null): ManualBucket {
  if (score === null) return 'invalid';
  if (score <= 1000) return 'storage';
  if (score <= 15000) return 'medium';
  if (score <= 1_000_000) return 'high';
  return 'top';
}

/** Bucket'ы где нужно делать email-enrichment. */
const ACTIVE_BUCKETS = new Set<ManualBucket>(['medium', 'high', 'top']);

interface EndpointConfig {
  url: string;
  apiKey: string;
  authScheme: string;
  timeoutMs: number;
}

interface ProcessOptions {
  runId: string;
  endpoint: EndpointConfig;
  /**
   * Прогресс-callback после каждого batch — даёт воркеру писать в БД.
   *
   * Получает АБСОЛЮТНОЕ число обработанных строк прогона, а не число строк,
   * сделанных в этом захвате. Разница видна клиенту: тело берёт только строки
   * без бакета, поэтому счётчик от нуля означал бы «обработано 25 из 1000» на
   * прогоне, который сделан на девяносто процентов. Смещение считается из
   * uniqueCount ниже, дополнительного запроса не требуется.
   */
  onProgress?: (processed: number) => Promise<void>;
  /** Concurrency для Mailganer + scrape. Default 5. */
  concurrency?: number;
  /** Лимит на одну строку, чтобы не зависнуть. Default 60 сек. */
  perRowTimeoutMs?: number;
  /**
   * Сколько всего строк у прогона (client_manual_score_runs.unique_count).
   *
   * Издатель вставляет в client_manual_score_rows ровно столько строк, сколько
   * записал в unique_count (api/client/manual-scoring/upload/route.ts: при
   * частичной вставке прогон сразу переводится в failed). Значит смещение
   * «сколько уже оценено до этого захвата» = unique_count минус число
   * невыбранных строк, и лишний COUNT не нужен — воркер и так читает
   * unique_count при захвате.
   *
   * Без него смещение считается нулевым: прогресс тогда абсолютен только для
   * первого захвата, ровно как было до аренды.
   */
  uniqueCount?: number;
  /**
   * Сигнал прерывания от единого жизненного цикла задач (`ctx.signal`).
   *
   * Взводится на SIGTERM воркера и при потере аренды. С этого момента прогон
   * уже не наш, и любой платный запрос к внешнему сервису — работа за чужой
   * счёт. Тело обязано выйти БЕЗ терминального статуса: строка остаётся в
   * работе, аренду отпускает библиотека, а продолжит прогон следующий владелец
   * (возобновление по построению — берутся только строки с bucket IS NULL).
   *
   * Необязателен: без сигнала поведение прежнее. Сегодня вызывающий ровно
   * один — worker/manualScoringWorker.ts, и тестов на этот путь нет;
   * необязательность оставлена под гипотетический прямой вызов, а не потому,
   * что такой вызов уже где-то есть.
   */
  signal?: AbortSignal;
  /**
   * Жетон текущего захвата (`ctx.runToken`).
   *
   * Терминальный статус пишет само тело (manageTerminalStatus: false), значит
   * оградить эти записи библиотека не может. Без жетона прежний исполнитель
   * после перехвата прогона проштамповал бы completed/failed поверх работы
   * нового владельца. Необязателен по той же причине, что и signal.
   */
  runToken?: string | null;
}

interface ProcessResult {
  /**
   * interrupted — прогон прерван сигналом. Терминального статуса НЕ пишем:
   * строка остаётся в статусе «в работе», и её продолжит следующий владелец.
   */
  status: 'completed' | 'failed' | 'interrupted';
  total: number;
  buckets: Record<ManualBucket, number>;
  error?: string;
}

const EMPTY_BUCKETS = (): Record<ManualBucket, number> =>
  ({ storage: 0, medium: 0, high: 0, top: 0, invalid: 0 });

/**
 * Ограждение записей в строку прогона жетоном захвата.
 *
 * Один обёртывающий помощник на ВСЕ записи — тот же приём, что
 * `safeUpdateSearchJob` в lib/parsers/searchParserWorker.ts. Без жетона
 * фильтр не добавляется, и поведение остаётся ровно тем, что было до аренды;
 * это запас под гипотетический прямой вызов, а не описание существующего —
 * сегодня processManualRun зовут из одного места и всегда с жетоном.
 */
type RunFence = <T>(query: T) => T;

function makeRunFence(runToken: string | null | undefined): RunFence {
  // Тип билдера — any по той же причине, что в lib/jobs/lifecycle.ts: цепочка
  // PostgREST меняет форму на каждом шаге, а нам нужен от неё только .eq.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <T>(q: T): T => (runToken ? ((q as any).eq('run_token', runToken) as T) : q);
}

function interrupted(): ProcessResult {
  return { status: 'interrupted', total: 0, buckets: EMPTY_BUCKETS() };
}

/**
 * Обрабатывает все необработанные строки прогона.
 * Идемпотентно: повторный вызов берёт только строки где bucket IS NULL.
 */
export async function processManualRun(opts: ProcessOptions): Promise<ProcessResult> {
  if (!supabaseAdmin) {
    return {
      status: 'failed',
      total: 0,
      buckets: EMPTY_BUCKETS(),
      error: 'supabaseAdmin not initialized',
    };
  }

  const concurrency = opts.concurrency ?? 5;
  const fence = makeRunFence(opts.runToken);
  const signal = opts.signal;
  /**
   * Единственный признак прерывания. Решаем по СИГНАЛУ, а не по имени ошибки:
   * прерванный fetch и истёкший таймаут дают неотличимый AbortError, и разбор
   * по имени рано или поздно записал бы отказ там, где задачу просто отобрали.
   */
  const aborted = () => signal?.aborted === true;

  // 1. Mark as processing
  //    С единым жизненным циклом захват уже поставил этот статус, и запись
  //    здесь — тавтология для воркера, но она нужна прямому вызову (без
  //    аренды). Ограждена жетоном: если строку перехватили, тавтология не
  //    должна воскресить наш статус поверх чужой работы.
  await fence(
    supabaseAdmin
      .from('client_manual_score_runs')
      .update({ status: 'processing' })
      .eq('id', opts.runId),
  );

  // 2. Берём все ещё не обработанные строки этого прогона
  const { data: rowsData, error: rowsErr } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('id, domain')
    .eq('run_id', opts.runId)
    .is('bucket', null)
    .order('id', { ascending: true });

  if (rowsErr) {
    if (aborted()) return interrupted();
    return await markFailed(opts.runId, `Failed to load rows: ${rowsErr.message}`, fence);
  }

  const rows = (rowsData ?? []) as Array<{ id: number; domain: string | null }>;
  if (rows.length === 0) {
    // Scoring already finished, but routing/snapshot persistence may have been
    // interrupted. Reconcile both before the run is allowed to complete.
    if (aborted()) return interrupted();
    try {
      await reconcileManualRoutingAndSnapshots(opts.runId, signal);
    } catch (err) {
      if (aborted()) return interrupted();
      return await markFailed(
        opts.runId,
        err instanceof Error ? err.message : 'routing reconciliation failed',
        fence,
      );
    }
    if (aborted()) return interrupted();
    return await finalize(opts.runId, fence);
  }

  // 3. Shared MX cache между всеми row'ами этого прогона — economy для повторяющихся
  //    доменов внутри одного файла (бывает).
  const domainInfoCache = new Map<string, DomainInfo>();

  // 4. Worker pool
  let cursor = 0;
  let processedSinceLastProgress = 0;
  const PROGRESS_FLUSH_EVERY = 25;

  /**
   * Абсолютный счётчик для прогресс-бара клиента.
   *
   * Смещение — сколько строк прогона было оценено ДО этого захвата: тело
   * выбирает только строки без бакета, поэтому cursor считает с нуля на каждом
   * захвате. Пока брошенный прогон никто не подбирал, эта ветка была
   * недостижима; с арендой перехват стал штатным, и без смещения клиент видел
   * бы на прогоне 900/1000 внезапное «обработано 25».
   *
   * Клампим по rows.length: каждый поток пула ровно один раз увеличивает
   * cursor за пределы массива, прежде чем выйти, — при concurrency 2 полностью
   * пройденная сотня дала бы 102. Экран это число подрезает, но писать в
   * счётчик, который читает клиент, больше unique_count всё равно незачем.
   */
  const scoredBefore = Math.max(0, (opts.uniqueCount ?? rows.length) - rows.length);
  const absoluteProcessed = (c: number) => scoredBefore + Math.min(c, rows.length);

  async function worker(): Promise<void> {
    while (true) {
      // Граница строки — единственная точка кооперативной остановки в пуле.
      if (aborted()) return;
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];

      const result = await processOneRow(row, opts.endpoint, domainInfoCache, signal);

      // Прерванную строку НЕ записываем. Иначе домен, чей скоринг оборвал
      // SIGTERM, лёг бы с bucket='invalid' — а повтор берёт только строки с
      // bucket IS NULL, то есть его не переоценили бы уже никогда.
      if (aborted()) return;

      // Сохраняем результат — независимо от ошибки. bucket всегда выставляем,
      // чтобы при повторном вызове processManualRun row не выбралась снова.
      await persistManualProcessedRow(row.id, result, new Date().toISOString());

      processedSinceLastProgress++;
      if (processedSinceLastProgress >= PROGRESS_FLUSH_EVERY) {
        const total = absoluteProcessed(cursor); // приближённо
        if (opts.onProgress) {
          await opts.onProgress(total).catch(() => undefined);
        }
        processedSinceLastProgress = 0;
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, rows.length) }, worker),
    );
  } catch (err) {
    if (aborted()) return interrupted();
    return await markFailed(
      opts.runId,
      err instanceof Error ? err.message : 'worker pool crashed',
      fence,
    );
  }

  if (aborted()) return interrupted();

  // Отметка перед длинным хвостом. Она нужна не для возобновления (оно идёт по
  // строкам с bucket IS NULL), а чтобы продлить аренду и обнулить бюджет
  // попыток ПЕРЕД фазой, которая не пишет processed_count вовсе: чистка имён
  // через AI, заливка в Instantly и снапшоты идут пачками по всему прогону.
  if (opts.onProgress) {
    await opts.onProgress(absoluteProcessed(cursor)).catch(() => undefined);
  }
  if (aborted()) return interrupted();

  // 4.5. Резолв названий (кэш ФНС) + чистка (AI как кнопка «Очистить названия»)
  //      + маршрутизация активных контактов в СУЩЕСТВУЮЩИЕ кампании авто-
  //      пайплайна по скорингу. Ошибка оставляет прогон retryable.
  try {
    await reconcileManualRoutingAndSnapshots(opts.runId, signal);
  } catch (err) {
    if (aborted()) return interrupted();
    return await markFailed(
      opts.runId,
      err instanceof Error ? err.message : 'routing reconciliation failed',
      fence,
    );
  }

  if (aborted()) return interrupted();
  return await finalize(opts.runId, fence);
}

/** Имя-кандидат из домена (крайний фоллбек): "stripe.com" → "Stripe". */
function domainToNameCandidate(domain: string): string {
  const label = (domain.replace(/^www\./, '').split('.')[0] ?? '').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : domain;
}

/**
 * Для активных строк прогона: находит название компании (из кэша
 * mailganer_domain_scores, наполняемого BoB-скорером из базы ФНС), чистит его
 * тем же AI, что кнопка «Очистить названия», сохраняет в company_name и грузит
 * контакты в существующие Instantly-кампании авто-пайплайна по скорингу.
 *
 * Идемпотентно: берёт только активные строки с email и company_name IS NULL.
 * После резолва company_name всегда НЕ NULL (''=имени нет) → повтор не дублирует.
 *
 * Маршрутизация только если у клиента настроены кампании (bucket с
 * instantly_campaign_id и непустой цепочкой). Иначе — только CSV (как раньше).
 */
interface ManualRouteOutcome {
  campaignId: string;
  campaignName: string;
  routedAt: string;
}

class ManualPartialRouteError extends Error {
  readonly routedRows: ReadonlyMap<number, ManualRouteOutcome>;

  constructor(cause: unknown, routedRows: ReadonlyMap<number, ManualRouteOutcome>) {
    super(cause instanceof Error ? cause.message : 'manual routing partially failed');
    this.name = 'ManualPartialRouteError';
    this.routedRows = new Map(routedRows);
  }
}

async function resolveNamesAndRoute(
  runId: string,
  signal?: AbortSignal,
): Promise<Map<number, ManualRouteOutcome>> {
  const routedRows = new Map<number, ManualRouteOutcome>();
  const newlyRoutedRows = new Map<number, ManualRouteOutcome>();
  if (!supabaseAdmin) return routedRows;

  const { data: run } = await supabaseAdmin
    .from('client_manual_score_runs')
    .select('client_user_id, route_to_instantly')
    .eq('id', runId)
    .single();
  const clientUserId = (run as { client_user_id?: string } | null)?.client_user_id;
  if (!clientUserId) return routedRows;
  // Тест-режим: route_to_instantly=false (дефолт) → прогон обрабатывается
  // полностью (скоринг/скрейп/валидация/чистка имён + CSV-выгрузки), но в
  // Instantly НЕ льётся. Включается явно (true) для боевых ручных доливов.
  const routeToInstantly =
    (run as { route_to_instantly?: boolean } | null)?.route_to_instantly === true;

  const { data: rowsData, error: rowsError } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('id, domain, company_name, score, email, email_validation_status, email2, email2_validation_status, scraped_name')
    .eq('run_id', runId)
    .in('bucket', ['medium', 'high', 'top'])
    .not('email', 'is', null);
  if (rowsError) throw new Error(rowsError.message);
  const allRows = (rowsData ?? []) as Array<{
    id: number;
    domain: string | null;
    company_name: string | null;
    score: number | null;
    email: string | null;
    email_validation_status: string | null;
    email2: string | null;
    email2_validation_status: string | null;
    scraped_name: string | null;
  }>;
  if (allRows.length === 0) return routedRows;

  if (routeToInstantly) {
    const { data: routedSnapshots, error: routedSnapshotsError } = await supabaseAdmin
      .from('client_pipeline_domain_snapshots')
      .select('source_row_id, routed_campaign_id, routed_campaign_name_snapshot, routed_at')
      .eq('client_user_id', clientUserId)
      .eq('source_kind', 'manual_scoring')
      .eq('source_run_id', runId)
      .not('routed_campaign_id', 'is', null);
    if (routedSnapshotsError) {
      throw new Error(`Failed to load prior manual routes: ${routedSnapshotsError.message}`);
    }
    for (const snapshot of (routedSnapshots ?? []) as Array<{
      source_row_id: string | null;
      routed_campaign_id: string | null;
      routed_campaign_name_snapshot: string | null;
      routed_at: string | null;
    }>) {
      const rowId = Number(snapshot.source_row_id);
      if (!Number.isSafeInteger(rowId) || !snapshot.routed_campaign_id) continue;
      routedRows.set(rowId, {
        campaignId: snapshot.routed_campaign_id,
        campaignName: snapshot.routed_campaign_name_snapshot ?? snapshot.routed_campaign_id,
        routedAt: snapshot.routed_at ?? new Date().toISOString(),
      });
    }
  }

  const rows = routeToInstantly
    ? allRows.filter((row) => !routedRows.has(row.id))
    : allRows;
  if (rows.length === 0) return routedRows;

  // 1. Название из кэша (BoB-скорер кладёт company_name из ФНС по домену).
  const domains = [...new Set(rows.map((r) => r.domain).filter((d): d is string => !!d))];
  const nameByDomain = new Map<string, string>();
  for (let i = 0; i < domains.length; i += 500) {
    const chunk = domains.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from('mailganer_domain_scores')
      .select('domain, company_name')
      .in('domain', chunk)
      .not('company_name', 'is', null);
    for (const d of (data ?? []) as Array<{ domain: string; company_name: string | null }>) {
      if (d.company_name) nameByDomain.set(d.domain, d.company_name);
    }
  }

  // 2. Сырое имя по фоллбек-цепочке: ФНС-кэш → scraped_name (с сайта) → из
  //    домена. Затем AI-чистка (тот же механизм, что кнопка). Так название
  //    есть у КАЖДОГО живого контакта, даже если домена нет в базе ФНС.
  const cleaned = await cleanCompanyNames(
    rows.map((r) => ({
      name:
        r.company_name?.trim() ||
        (r.domain ? nameByDomain.get(r.domain) : null) ||
        r.scraped_name ||
        (r.domain ? domainToNameCandidate(r.domain) : ''),
      domain: r.domain,
    })),
    // Чистка идёт батчами по 100 через AI и умеет останавливаться между ними —
    // подаём ей тот же сигнал, что и всему прогону.
    signal ? async () => signal.aborted : undefined,
  );

  if (signal?.aborted) throw new Error('manual scoring interrupted');

  // 3. Сохраняем company_name ('' = резолв выполнен, имени нет → идемпотентность).
  //    Проверка сигнала внутри цикла, а не только перед ним: это тысячи
  //    последовательных запросов, самый длинный непрерываемый отрезок тела.
  //    Без неё цикл продолжал бы писать десятки секунд после того, как бюджет
  //    остановки вышел и аренда отпущена, — уже поверх нового владельца, без
  //    ограждения (эти записи идут в client_manual_score_rows, а не в строку
  //    прогона) и именами, которые AI между прогонами не обязан повторять.
  for (let i = 0; i < rows.length; i += 1) {
    if (signal?.aborted) throw new Error('manual scoring interrupted');
    const { error } = await supabaseAdmin
      .from('client_manual_score_rows')
      .update({ company_name: cleaned[i] || '' })
      .eq('id', rows[i].id);
    if (error) throw new Error(`Failed to persist resolved company name: ${error.message}`);
  }

  // Тест-режим — имена почищены и сохранены, но в Instantly НЕ льём.
  if (!routeToInstantly) {
    console.log(`[manual-scoring] run ${runId}: ТЕСТ-режим — routing в Instantly пропущен (${rows.length} строк обработано)`);
    return routedRows;
  }

  // 4. Маршрутизация в существующие кампании по скорингу — если настроены.
  const { data: cfg, error: cfgError } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('score_buckets')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  if (cfgError) throw new Error(cfgError.message);
  const buckets = ((cfg as { score_buckets?: unknown } | null)?.score_buckets ?? []) as Array<{
    score_min: number;
    score_max: number | null;
    instantly_campaign_id: string | null;
    sequence?: { steps?: unknown[] };
    label?: string;
  }>;
  if (!Array.isArray(buckets) || buckets.length === 0) return routedRows; // кампании не настроены → только CSV

  const groups = new Map<string, {
    campaignId: string;
    label: string;
    leads: LeadCreatePayload[];
    leadRowIds: number[];
  }>();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const name = cleaned[i];
    if (!name || !r.domain || r.score === null) continue;
    // Готовые почты (valid/role/free/catch_all) — каждая = отдельный лид.
    // Невалидные не берём (правило «почта валидная или catch-all»).
    const validEmails: string[] = [];
    if (r.email && isReadyEmailStatus(r.email_validation_status)) validEmails.push(r.email);
    if (r.email2 && isReadyEmailStatus(r.email2_validation_status)) validEmails.push(r.email2);
    if (validEmails.length === 0) continue; // нет валидной почты → не контакт
    const bucket = buckets.find(
      (b) => r.score! >= b.score_min && (b.score_max === null || r.score! <= b.score_max),
    );
    if (!bucket || !bucket.instantly_campaign_id) continue; // нет кампании для диапазона
    const hasSteps = Array.isArray(bucket.sequence?.steps) && bucket.sequence!.steps!.length > 0;
    if (!hasSteps) continue; // bucket без цепочки = склад, не шлём
    let g = groups.get(bucket.instantly_campaign_id);
    if (!g) {
      g = {
        campaignId: bucket.instantly_campaign_id,
        label: bucket.label ?? 'manual',
        leads: [],
        leadRowIds: [],
      };
      groups.set(bucket.instantly_campaign_id, g);
    }
    for (const addr of validEmails) {
      g.leads.push({
        email: addr,
        company_name: name,
        website: `https://${r.domain}`,
        custom_variables: {
          source: 'manual', score: String(r.score), domain: r.domain, source_row_id: String(r.id),
        },
      });
      g.leadRowIds.push(r.id);
    }
  }

  for (const g of groups.values()) {
    // Прерывание между кампаниями: уже залитые лиды обязаны попасть в снапшоты,
    // иначе следующий владелец зальёт их второй раз. Поэтому не тихий выход, а
    // ManualPartialRouteError — reconcile ниже сохранит по ним снапшоты и
    // пробросит ошибку, а processManualRun увидит взведённый сигнал и выйдет
    // без терминального статуса.
    if (signal?.aborted) {
      if (newlyRoutedRows.size > 0) {
        throw new ManualPartialRouteError(new Error('manual scoring interrupted'), newlyRoutedRows);
      }
      throw new Error('manual scoring interrupted');
    }
    const recordAcceptedRows = (outcome: Parameters<typeof selectAcceptedItems>[1]) => {
      const acceptedRowIds = selectAcceptedItems(g.leadRowIds, outcome);
      if (acceptedRowIds === null) {
        throw new Error(`Campaign ${g.campaignId} returned aggregate-only accepted identities`);
      }
      const routedAt = new Date().toISOString();
      for (const rowId of new Set(acceptedRowIds)) {
        const route = {
          campaignId: g.campaignId,
          campaignName: g.label,
          routedAt,
        };
        routedRows.set(rowId, route);
        newlyRoutedRows.set(rowId, route);
      }
    };

    try {
      const result = await appendLeadsToClientCampaign({
        userId: clientUserId,
        campaignId: g.campaignId,
        leads: g.leads,
        contextLabel: `manual:${g.label}`,
        ledgerSource: {
          kind: 'manual_scoring',
          runId,
          campaignName: g.label,
        },
      });
      recordAcceptedRows(result);
    } catch (err) {
      const partial = partialAppendOutcome(err);
      if (partial) {
        try {
          recordAcceptedRows(partial);
        } catch (identityError) {
          if (newlyRoutedRows.size > 0) {
            throw new ManualPartialRouteError(identityError, newlyRoutedRows);
          }
          throw identityError;
        }
      }
      if (newlyRoutedRows.size > 0) throw new ManualPartialRouteError(err, newlyRoutedRows);
      throw err;
    }
  }
  return routedRows;
}

async function persistManualRunSnapshots(
  runId: string,
  routedRows: ReadonlyMap<number, ManualRouteOutcome>,
  onlyRowIds?: ReadonlySet<number>,
): Promise<void> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');

  const { data: run, error: runError } = await supabaseAdmin
    .from('client_manual_score_runs')
    .select('client_user_id, source_filename')
    .eq('id', runId)
    .single();
  if (runError) throw new Error(`Failed to load manual score run: ${runError.message}`);
  const runDetails = run as {
    client_user_id?: string;
    source_filename?: string | null;
  } | null;
  const clientUserId = runDetails?.client_user_id;
  if (!clientUserId) throw new Error('Manual score run has no client owner');

  const { data, error } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select(
      'id, domain, company_name, score, rating, spf, email, email_validation_status, email2, email2_validation_status, processed_at',
    )
    .eq('run_id', runId)
    .not('processed_at', 'is', null);
  if (error) throw new Error(`Failed to load manual score rows: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: number;
    domain: string | null;
    company_name: string | null;
    score: number | null;
    rating: string | null;
    spf: string | null;
    email: string | null;
    email_validation_status: string | null;
    email2: string | null;
    email2_validation_status: string | null;
    processed_at: string;
  }>;
  const selectedRows = onlyRowIds
    ? rows.filter((row) => onlyRowIds.has(row.id))
    : rows;

  await persistDomainSnapshots(
    supabaseAdmin,
    selectedRows.map((row) => {
      const route = routedRows.get(row.id);
      return buildManualScoringDomainSnapshot({
        clientUserId,
        runId,
        rowId: row.id,
        domain: row.domain,
        companyName: row.company_name,
        score: row.score,
        rating: row.rating,
        spf: row.spf,
        email: row.email,
        emailValidationStatus: row.email_validation_status,
        email2: row.email2,
        email2ValidationStatus: row.email2_validation_status,
        sourceFilename: runDetails?.source_filename ?? null,
        scoredAt: row.processed_at,
        routedCampaignId: route?.campaignId ?? null,
        routedCampaignName: route?.campaignName ?? null,
        routedAt: route?.routedAt ?? null,
      });
    }),
  );
}

async function reconcileManualRoutingAndSnapshots(
  runId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const routedRows = await resolveNamesAndRoute(runId, signal);
    await persistManualRunSnapshots(runId, routedRows);
  } catch (error) {
    if (error instanceof ManualPartialRouteError && error.routedRows.size > 0) {
      await persistManualRunSnapshots(
        runId,
        error.routedRows,
        new Set(error.routedRows.keys()),
      );
    }
    throw error;
  }
}

export interface ProcessedRow {
  domain: string | null;
  score: number | null;
  rating: string | null;
  spf: string | null;
  email: string | null;
  emailValidationStatus: string | null;
  bucket: ManualBucket;
  errorMessage: string | null;
  /** Сырое название с сайта (og:site_name/<title>) — фоллбек к ФНС-имени. */
  scrapedName: string | null;
  /** Вторая почта с домена (до 2 на домен, как авто). Опционально. */
  email2?: string | null;
  email2ValidationStatus?: string | null;
}

export async function persistManualProcessedRow(
  rowId: number,
  result: ProcessedRow,
  processedAt: string,
): Promise<void> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');
  const { error } = await supabaseAdmin
    .from('client_manual_score_rows')
    .update({
      domain: result.domain,
      score: result.score,
      rating: result.rating,
      spf: result.spf,
      email: result.email,
      email_validation_status: result.emailValidationStatus,
      email2: result.email2 ?? null,
      email2_validation_status: result.email2ValidationStatus ?? null,
      bucket: result.bucket,
      error_message: result.errorMessage,
      scraped_name: result.scrapedName,
      processed_at: processedAt,
    })
    .eq('id', rowId);
  if (error) throw new Error(`Failed to persist manual score row ${rowId}: ${error.message}`);
}

/** Статусы, при которых почта считается готовой к аутричу (как isValid в авто). */
const READY_EMAIL_STATUSES = new Set(['valid', 'role_address', 'free_provider', 'catch_all']);
function isReadyEmailStatus(status: string | null | undefined): boolean {
  return !!status && READY_EMAIL_STATUSES.has(status);
}

async function processOneRow(
  row: { id: number; domain: string | null },
  endpoint: EndpointConfig,
  mxCache: Map<string, DomainInfo>,
  signal?: AbortSignal,
): Promise<ProcessedRow> {
  const domain = row.domain ? normalizeDomain(row.domain) : null;
  if (!domain) {
    return {
      domain: null,
      score: null,
      rating: null,
      spf: null,
      email: null,
      emailValidationStatus: null,
      bucket: 'invalid',
      errorMessage: 'invalid domain',
      scrapedName: null,
    };
  }

  // 1. Score (использует кэш — для уже виденных доменов мгновенно).
  //    Сигнал уходит и в ожидание суточного токена Mailganer, и в сам вызов:
  //    после потери аренды платить за этот домен уже не наше дело.
  let scoreResult;
  try {
    scoreResult = await getOrFetchScore(domain, { ...endpoint, signal }, 'manual');
  } catch (err) {
    // От вечного «домен невалиден» на прерывании защищает НЕ этот rethrow, а
    // проверка сигнала на границе строки в пуле: прерванный вызов к внешнему
    // сервису возвращает ok:false, а не бросает, и сюда обычно не доходит —
    // результат просто не записывается. Rethrow оставлен как страховка для
    // исключения из слоя кэша (запрос к БД за сохранённым score): без него
    // такая строка легла бы с bucket='invalid', а повтор берёт только строки
    // с bucket IS NULL, то есть переоценить её было бы уже некому.
    if (signal?.aborted) throw err;
    return {
      domain,
      score: null,
      rating: null,
      spf: null,
      email: null,
      emailValidationStatus: null,
      bucket: 'invalid',
      errorMessage: err instanceof Error ? err.message : 'mailganer error',
      scrapedName: null,
    };
  }

  const score = scoreResult.score;
  const rating =
    scoreResult.raw && typeof scoreResult.raw === 'object' && 'rating' in scoreResult.raw
      ? String((scoreResult.raw as Record<string, unknown>).rating ?? '')
      : null;
  const bucket = classifyScore(score);

  // 2. Если score ≤ 1000 (storage) или null (invalid) — НЕ обогащаем email
  if (!ACTIVE_BUCKETS.has(bucket)) {
    return {
      domain,
      score,
      rating: rating || null,
      spf: scoreResult.spf,
      email: null,
      emailValidationStatus: null,
      bucket,
      errorMessage: scoreResult.ok ? null : scoreResult.error || null,
      scrapedName: null,
    };
  }

  // 3. Активный bucket — scrape сайта (email + название) + SMTP-валидация.
  //    scrapedName (og:site_name/<title>) — фоллбек к ФНС-имени в resolveNamesAndRoute.
  const scraped = await scrapeEmails(`https://${domain}`, {
    timeout: 12_000,
    maxPages: 5,
    signal,
  }).catch(() => ({ emails: [] as string[], siteName: null as string | null }));
  const scrapedName = scraped.siteName ?? null;
  // До 2 почт с домена (как авто) — каждая станет отдельным лидом/строкой.
  const candidates = scraped.emails.slice(0, 2);
  // validateEmailForAutoPipeline сигнала не принимает (SMTP-слой общий с
  // валидацией почт), но каждая его проба ограничена собственным таймаутом, а
  // прерывание проверяем перед вызовом. Дороже этого прерывание здесь не
  // стоит: строка всё равно не будет записана — вызывающий выбросит результат,
  // увидев взведённый сигнал.
  const validateSafe = async (e: string): Promise<string | null> => {
    if (signal?.aborted) return null;
    try {
      return (await validateEmailForAutoPipeline(e, mxCache)).status;
    } catch {
      return null; // валидация упала — строку не фейлим
    }
  };
  const email = candidates[0] ?? null;
  const emailValidationStatus = email ? await validateSafe(email) : null;
  const email2 = candidates[1] ?? null;
  const email2ValidationStatus = email2 ? await validateSafe(email2) : null;

  return {
    domain,
    score,
    rating: rating || null,
    spf: scoreResult.spf,
    email,
    emailValidationStatus,
    email2,
    email2ValidationStatus,
    bucket,
    errorMessage: null,
    scrapedName,
  };
}

async function markFailed(
  runId: string,
  message: string,
  fence: RunFence,
): Promise<ProcessResult> {
  if (supabaseAdmin) {
    await fence(
      supabaseAdmin
        .from('client_manual_score_runs')
        .update({
          status: 'failed',
          error_message: message.slice(0, 500),
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId),
    );
  }
  return {
    status: 'failed',
    total: 0,
    buckets: EMPTY_BUCKETS(),
    error: message,
  };
}

async function finalize(runId: string, fence: RunFence): Promise<ProcessResult> {
  if (!supabaseAdmin) {
    return {
      status: 'failed',
      total: 0,
      buckets: EMPTY_BUCKETS(),
      error: 'supabaseAdmin gone',
    };
  }
  // Считаем breakdown по bucket'ам. ВАЖНО: активные тиры (medium/high/top)
  // считаем ТОЛЬКО готовых к аутричу — с почтой И названием. Высоко-
  // отскоренные «без почты» не контакты и в эти счётчики/файлы не идут.
  // storage/invalid считаем как есть. processed_count — все обработанные.
  const { data: bucketCounts } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('bucket, email, email_validation_status, email2, email2_validation_status, company_name')
    .eq('run_id', runId);

  const buckets: Record<ManualBucket, number> = {
    storage: 0,
    medium: 0,
    high: 0,
    top: 0,
    invalid: 0,
  };
  let processed = 0;
  for (const r of (bucketCounts ?? []) as Array<{
    bucket: ManualBucket | null;
    email: string | null;
    email_validation_status: string | null;
    email2: string | null;
    email2_validation_status: string | null;
    company_name: string | null;
  }>) {
    if (!r.bucket || !(r.bucket in buckets)) continue;
    processed += 1;
    if (r.bucket === 'storage' || r.bucket === 'invalid') {
      buckets[r.bucket] += 1;
      continue;
    }
    // Активный тир — считаем готовые КОНТАКТЫ: каждая валидная почта (с
    // названием) = отдельный контакт/лид. Домен с 2 валидными → +2.
    const hasName = !!r.company_name && r.company_name.trim().length > 0;
    if (!hasName) continue;
    if (r.email && isReadyEmailStatus(r.email_validation_status)) buckets[r.bucket] += 1;
    if (r.email2 && isReadyEmailStatus(r.email2_validation_status)) buckets[r.bucket] += 1;
  }

  await fence(
    supabaseAdmin
      .from('client_manual_score_runs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        processed_count: processed,
        bucket_storage_count: buckets.storage,
        bucket_medium_count: buckets.medium,
        bucket_high_count: buckets.high,
        bucket_top_count: buckets.top,
      })
      .eq('id', runId),
  );

  return { status: 'completed', total: processed, buckets };
}

/**
 * Парсит CSV/text-input и возвращает массив raw доменов (без нормализации,
 * нормализация будет в processOneRow).
 *
 * Поддерживаем:
 *   - 1 домен на строку (просто text-list)
 *   - CSV с первой колонкой = домен (заголовок 'domain' опционально)
 *   - URL'ы с/без http(s):// — оба ok
 *   - email'ы — берётся часть после @
 *
 * Возвращает максимум `maxRows` (default 50000).
 */
export function parseDomainsInput(raw: string, maxRows = 50_000): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result: string[] = [];
  for (const line of lines) {
    // Если строка похожа на CSV (есть запятая) — берём только первую колонку
    const first = line.split(',')[0].trim();
    if (!first) continue;
    // Если это похоже на header — пропускаем
    if (
      result.length === 0 &&
      /^(domain|domains|url|website|host)$/i.test(first)
    ) {
      continue;
    }
    // Удалить кавычки
    const cleaned = first.replace(/^["']|["']$/g, '');
    // Если выглядит как email — взять домен после @
    const emailMatch = cleaned.match(/@([^\s]+)$/);
    const candidate = emailMatch ? emailMatch[1] : cleaned;
    result.push(candidate);
    if (result.length >= maxRows) break;
  }
  return result;
}
