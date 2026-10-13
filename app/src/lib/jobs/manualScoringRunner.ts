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
import { buildExcludePatterns } from './autoPipelineExclusions';
import { validateEmailForAutoPipeline } from './autoPipelineEmailValidation';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import type { DomainInfo } from '@/lib/emailValidation/shared';
import { manualDbRequest } from './manualScoringDbRequest';
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

export interface ProcessOptions {
  runId: string;
  endpoint: EndpointConfig;
  /** Прогресс-callback после каждого batch — даёт воркеру писать в БД. */
  onProgress?: (processed: number) => Promise<void>;
  /** Concurrency для Mailganer + scrape. Default 5. */
  concurrency?: number;
  /** Лимит на одну строку, чтобы не зависнуть. Default 60 сек. */
  perRowTimeoutMs?: number;
  /** Stop assigning rows; in-flight rows are drained before returning paused. */
  shouldStop?: () => boolean;
  /** Ownership checks fail closed. The worker owns lease release/reclaim. */
  assertOwnership?: () => Promise<void>;
  skipMarkProcessing?: boolean;
  updateRunState?: (patch: Record<string, unknown>) => Promise<void>;
  /** A claimed worker supplies its token-fenced row write here. */
  persistRow?: (rowId: number, payload: ManualProcessedRowPayload) => Promise<void>;
  /** The worker records a non-reclaimable routing phase before side effects. */
  beforeReconcile?: () => Promise<void>;
}

export interface ProcessResult {
  status: 'completed' | 'failed' | 'paused';
  total: number;
  buckets: Record<ManualBucket, number>;
  error?: string;
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
      buckets: { storage: 0, medium: 0, high: 0, top: 0, invalid: 0 },
      error: 'supabaseAdmin not initialized',
    };
  }

  const configuredConcurrency = opts.concurrency ?? 5;
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.floor(configuredConcurrency)) : 5;
  const paused = (): ProcessResult => ({
    status: 'paused', total: 0,
    buckets: { storage: 0, medium: 0, high: 0, top: 0, invalid: 0 },
  });
  const fail = (message: string) => markFailed(opts.runId, message, opts);
  const ownsRun = async (): Promise<boolean> => {
    try {
      await opts.assertOwnership?.();
      return true;
    } catch {
      // Never change run state after a lease has been lost.
      return false;
    }
  };
  const canContinue = async (): Promise<boolean> => {
    if (opts.shouldStop?.()) return false;
    return await ownsRun() && !opts.shouldStop?.();
  };
  if (!await canContinue()) return paused();

  // 1. Mark as processing
  if (!opts.skipMarkProcessing) {
    await updateManualRunState(opts.runId, { status: 'processing' }, opts);
  }

  const { data: runMode, error: runModeError } = await supabaseAdmin
    .from('client_manual_score_runs')
    .select('is_no_email_retry')
    .eq('id', opts.runId)
    .single();
  if (runModeError) return await fail(`Failed to load run mode: ${runModeError.message}`);
  const isNoEmailRetry = (runMode as { is_no_email_retry?: boolean } | null)?.is_no_email_retry === true;

  // 2. Берём все ещё не обработанные строки этого прогона
  const { data: rowsData, error: rowsErr } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('id, domain')
    .eq('run_id', opts.runId)
    .is('bucket', null)
    .order('id', { ascending: true });

  if (rowsErr) {
    return await fail(`Failed to load rows: ${rowsErr.message}`);
  }

  const rows = (rowsData ?? []) as Array<{ id: number; domain: string | null }>;
  if (isNoEmailRetry && rows.length > 100) {
    return await fail('No-email retry runs are limited to 100 rows');
  }
  if (rows.length === 0) {
    if (!await canContinue()) return paused();
    // Scoring already finished, but routing/snapshot persistence may have been
    // interrupted. Reconcile both before the run is allowed to complete.
    try {
      await opts.beforeReconcile?.();
      if (!await ownsRun()) return paused();
      await reconcileManualRoutingAndSnapshots(opts.runId, opts);
    } catch (err) {
      if (!await ownsRun()) return paused();
      return await fail(err instanceof Error ? err.message : 'routing reconciliation failed');
    }
    if (!await ownsRun()) return paused();
    return await finalize(opts.runId, opts);
  }

  // 3. Shared MX cache между всеми row'ами этого прогона — economy для повторяющихся
  //    доменов внутри одного файла (бывает).
  const domainInfoCache = new Map<string, DomainInfo>();

  // 4. Worker pool
  let cursor = 0;
  let processedSinceLastProgress = 0;
  let savedInThisInvocation = 0;
  let poolError: unknown;
  let stopped = false;
  const PROGRESS_FLUSH_EVERY = 25;

  async function worker(): Promise<void> {
    while (true) {
      if (poolError || stopped || !await canContinue()) {
        stopped = true;
        return;
      }
      // Ownership checks await; another loop may have failed meanwhile.
      if (poolError || stopped) return;
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];

      try {
        const result = await processOneRow(row, opts.endpoint, domainInfoCache);
        // Compute once. A retry reuses this exact result and timestamp, never
        // repeats Mailganer/scraping/validation or overwrites a saved row.
        await persistManualProcessedRow(row.id, result, new Date().toISOString(), {
          assertOwnership: opts.assertOwnership,
          write: opts.persistRow ? (payload) => opts.persistRow!(row.id, payload) : undefined,
        });
        savedInThisInvocation++;
      } catch (err) {
        poolError ??= err;
        return;
      }

      processedSinceLastProgress++;
      if (processedSinceLastProgress >= PROGRESS_FLUSH_EVERY) {
        const total = cursor; // приближённо
        if (opts.onProgress) {
          await opts.onProgress(total).catch(() => undefined);
        }
        processedSinceLastProgress = 0;
      }
    }
  }

  // Do not return on the first rejection: old async loops must not continue
  // writing after the outer worker has moved on to another run.
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, rows.length) }, worker),
  );
  for (const result of settled) {
    if (result.status === 'rejected') poolError ??= result.reason;
  }
  if (!await ownsRun()) return { ...paused(), total: savedInThisInvocation };
  if (poolError) {
    return await fail(poolError instanceof Error ? poolError.message : 'worker pool crashed');
  }
  if (stopped || opts.shouldStop?.()) return { ...paused(), total: savedInThisInvocation };

  // 4.5. Резолв названий (кэш ФНС) + чистка (AI как кнопка «Очистить названия»)
  //      + маршрутизация активных контактов в СУЩЕСТВУЮЩИЕ кампании авто-
  //      пайплайна по скорингу. Ошибка оставляет прогон retryable.
  try {
    await opts.beforeReconcile?.();
    if (!await ownsRun()) return { ...paused(), total: savedInThisInvocation };
    await reconcileManualRoutingAndSnapshots(opts.runId, opts);
  } catch (err) {
    if (!await ownsRun()) return { ...paused(), total: savedInThisInvocation };
    return await fail(err instanceof Error ? err.message : 'routing reconciliation failed');
  }

  if (!await ownsRun()) return { ...paused(), total: savedInThisInvocation };
  return await finalize(opts.runId, opts);
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

async function assertManualRunMayReconcile(options: ProcessOptions): Promise<void> {
  await options.assertOwnership?.();
  // Once routing starts, finish its receipts/snapshots even if SIGTERM arrives.
  // Stopping here could release a run with an ambiguous external append.
}

async function resolveNamesAndRoute(runId: string, options: ProcessOptions): Promise<Map<number, ManualRouteOutcome>> {
  await assertManualRunMayReconcile(options);
  const routedRows = new Map<number, ManualRouteOutcome>();
  const newlyRoutedRows = new Map<number, ManualRouteOutcome>();
  if (!supabaseAdmin) return routedRows;

  const { data: run } = await supabaseAdmin
    .from('client_manual_score_runs')
    .select('client_user_id, route_to_instantly, is_no_email_retry')
    .eq('id', runId)
    .single();
  const clientUserId = (run as { client_user_id?: string } | null)?.client_user_id;
  if (!clientUserId) return routedRows;
  // Тест-режим: route_to_instantly=false (дефолт) → прогон обрабатывается
  // полностью (скоринг/скрейп/валидация/чистка имён + CSV-выгрузки), но в
  // Instantly НЕ льётся. Включается явно (true) для боевых ручных доливов.
  const routeToInstantly =
    (run as { route_to_instantly?: boolean } | null)?.route_to_instantly === true;
  const isNoEmailRetry =
    (run as { is_no_email_retry?: boolean } | null)?.is_no_email_retry === true;

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
  const cleaned = await cleanCompanyNames(rows.map((r) => ({
    name:
      r.company_name?.trim() ||
      (r.domain ? nameByDomain.get(r.domain) : null) ||
      r.scraped_name ||
      (r.domain ? domainToNameCandidate(r.domain) : ''),
    domain: r.domain,
  })));

  // 3. Сохраняем company_name ('' = резолв выполнен, имени нет → идемпотентность).
  for (let i = 0; i < rows.length; i += 1) {
    await assertManualRunMayReconcile(options);
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
    .select('score_buckets, hh_extra_exclude_patterns')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  if (cfgError) throw new Error(cfgError.message);
  const exclusionPatterns = isNoEmailRetry
    ? buildExcludePatterns(
      ((cfg as { hh_extra_exclude_patterns?: string[] } | null)?.hh_extra_exclude_patterns ?? []),
    )
    : [];
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
    if (isNoEmailRetry && [
      name, r.domain, r.company_name, r.scraped_name, nameByDomain.get(r.domain),
    ].some((value) => value && exclusionPatterns.some((pattern) => pattern.test(value)))) continue;
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
    await assertManualRunMayReconcile(options);
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
  options?: ProcessOptions,
): Promise<void> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');

  const { data: run, error: runError } = await supabaseAdmin
    .from('client_manual_score_runs')
    .select('client_user_id, source_filename, is_no_email_retry')
    .eq('id', runId)
    .single();
  if (runError) throw new Error(`Failed to load manual score run: ${runError.message}`);
  const runDetails = run as {
    client_user_id?: string;
    source_filename?: string | null;
    is_no_email_retry?: boolean;
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

  if (options) await assertManualRunMayReconcile(options);
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
        isNoEmailRetry: runDetails?.is_no_email_retry === true,
        scoredAt: row.processed_at,
        routedCampaignId: route?.campaignId ?? null,
        routedCampaignName: route?.campaignName ?? null,
        routedAt: route?.routedAt ?? null,
      });
    }),
  );
}

async function reconcileManualRoutingAndSnapshots(runId: string, options: ProcessOptions): Promise<void> {
  try {
    const routedRows = await resolveNamesAndRoute(runId, options);
    await persistManualRunSnapshots(runId, routedRows, undefined, options);
  } catch (error) {
    if (error instanceof ManualPartialRouteError && error.routedRows.size > 0) {
      await persistManualRunSnapshots(
        runId,
        error.routedRows,
        new Set(error.routedRows.keys()),
        options,
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

export interface ManualProcessedRowPayload {
  domain: string | null;
  score: number | null;
  rating: string | null;
  spf: string | null;
  email: string | null;
  email_validation_status: string | null;
  email2: string | null;
  email2_validation_status: string | null;
  bucket: ManualBucket;
  error_message: string | null;
  scraped_name: string | null;
  processed_at: string;
}

export interface ManualRowSaveOptions {
  /** Writes, not scoring, are bounded. Delay 0 is supported by fast tests. */
  maxAttempts?: number;
  baseDelayMs?: number;
  assertOwnership?: () => Promise<void>;
  write?: (payload: ManualProcessedRowPayload) => Promise<void>;
}

export function isTransientManualDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const item = error as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
  const code = String(item.code ?? '').toUpperCase();
  const status = Number(item.status);
  // Auth, schema and invalid payload failures need a fix, not more writes.
  if (/^(?:22|23|28|42|MANUAL_)/.test(code) || [400, 401, 403, 404, 409, 422].includes(status)) return false;
  if ([408, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) return true;
  if (new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
    'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ]).has(code)) return true;
  return /invalid response was received from the upstream server|fetch failed|socket hang up|network|service unavailable|tim(?:ed|ing)?\s*out|timeout/i.test(String(item.message ?? ''))
    || (item.cause !== undefined && isTransientManualDbError(item.cause));
}

export function manualRowPayloadMatches(row: Record<string, unknown>, payload: ManualProcessedRowPayload): boolean {
  return Object.entries(payload).every(([key, expected]) => {
    if (key === 'processed_at') {
      return new Date(String(row[key])).getTime() === new Date(String(expected)).getTime();
    }
    return (row[key] ?? null) === expected;
  });
}

export async function persistManualProcessedRow(
  rowId: number,
  result: ProcessedRow,
  processedAt: string,
  options: ManualRowSaveOptions = {},
): Promise<void> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');
  const payload: ManualProcessedRowPayload = {
    domain: result.domain, score: result.score, rating: result.rating, spf: result.spf,
    email: result.email, email_validation_status: result.emailValidationStatus,
    email2: result.email2 ?? null, email2_validation_status: result.email2ValidationStatus ?? null,
    bucket: result.bucket, error_message: result.errorMessage,
    scraped_name: result.scrapedName, processed_at: processedAt,
  };
  const columns = Object.keys(payload).join(', ');
  const configuredAttempts = options.maxAttempts ?? 3;
  const attempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(5, Math.floor(configuredAttempts))) : 3;
  const configuredDelay = options.baseDelayMs ?? 250;
  const baseDelay = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 250;
  let lastError: unknown;
  const assertOwnership = async (): Promise<void> => {
    try {
      await options.assertOwnership?.();
    } catch (cause) {
      throw Object.assign(new Error('Manual scoring ownership is unavailable'), {
        code: 'MANUAL_OWNERSHIP_UNAVAILABLE', cause,
      });
    }
  };
  const readBack = async (): Promise<'saved' | 'pending'> => {
    await assertOwnership();
    const { data, error } = await manualDbRequest(supabaseAdmin!
      .from('client_manual_score_rows').select(columns).eq('id', rowId).maybeSingle());
    if (error) throw error;
    if (!data) throw new Error(`Manual score row ${rowId} no longer exists`);
    const saved = data as unknown as Record<string, unknown>;
    if (manualRowPayloadMatches(saved, payload)) return 'saved';
    if (saved.bucket != null) throw new Error(`Manual score row ${rowId} has a different saved result`);
    return 'pending';
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Keep this outside the retry catch: lease loss must never be retried.
    await assertOwnership();
    try {
      if (options.write) {
        await options.write(payload);
        return;
      }
      // A response may be lost after COMMIT. CAS prevents a retry from
      // overwriting a durable result; readback proves whether it was ours.
      const { data, error } = await manualDbRequest(supabaseAdmin
        .from('client_manual_score_rows').update(payload)
        .eq('id', rowId).is('bucket', null).select(columns).maybeSingle());
      if (error) throw error;
      if (data && manualRowPayloadMatches(data as unknown as Record<string, unknown>, payload)) return;
      if (await readBack() === 'saved') return;
      throw new Error(`Manual score row ${rowId} write returned no durable result`);
    } catch (error) {
      lastError = error;
      if (!isTransientManualDbError(error)) break;
      try {
        if (await readBack() === 'saved') return;
      } catch (readError) {
        lastError = readError;
        if (!isTransientManualDbError(readError)) break;
      }
      if (attempt < attempts && baseDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** (attempt - 1)));
      }
    }
  }
  const message = lastError instanceof Error
    ? lastError.message
    : String((lastError as { message?: unknown } | null)?.message ?? 'unknown database error');
  throw Object.assign(new Error(`Failed to persist manual score row ${rowId}: ${message}`), { cause: lastError });
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

  // 1. Score (использует кэш — для уже виденных доменов мгновенно)
  let scoreResult;
  try {
    scoreResult = await getOrFetchScore(domain, endpoint, 'manual');
  } catch (err) {
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
  }).catch(() => ({ emails: [] as string[], siteName: null as string | null }));
  const scrapedName = scraped.siteName ?? null;
  // До 2 почт с домена (как авто) — каждая станет отдельным лидом/строкой.
  const candidates = scraped.emails.slice(0, 2);
  const validateSafe = async (e: string): Promise<string | null> => {
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

async function updateManualRunState(
  runId: string,
  patch: Record<string, unknown>,
  options: Pick<ProcessOptions, 'assertOwnership' | 'updateRunState'> = {},
): Promise<void> {
  await options.assertOwnership?.();
  if (options.updateRunState) return options.updateRunState(patch);
  if (!supabaseAdmin) throw new Error('supabaseAdmin not initialized');
  const { error } = await supabaseAdmin.from('client_manual_score_runs').update(patch).eq('id', runId);
  if (error) throw Object.assign(new Error(`Failed to update manual run state: ${error.message}`), { cause: error });
}

async function markFailed(runId: string, message: string, options: ProcessOptions): Promise<ProcessResult> {
  if (supabaseAdmin) {
    await updateManualRunState(runId, {
      status: 'failed',
      error_message: message.slice(0, 500),
      finished_at: new Date().toISOString(),
    }, options);
  }
  return {
    status: 'failed',
    total: 0,
    buckets: { storage: 0, medium: 0, high: 0, top: 0, invalid: 0 },
    error: message,
  };
}

async function finalize(runId: string, options: ProcessOptions): Promise<ProcessResult> {
  if (!supabaseAdmin) {
    return {
      status: 'failed',
      total: 0,
      buckets: { storage: 0, medium: 0, high: 0, top: 0, invalid: 0 },
      error: 'supabaseAdmin gone',
    };
  }
  // Считаем breakdown по bucket'ам. ВАЖНО: активные тиры (medium/high/top)
  // считаем ТОЛЬКО готовых к аутричу — с почтой И названием. Высоко-
  // отскоренные «без почты» не контакты и в эти счётчики/файлы не идут.
  // storage/invalid считаем как есть. processed_count — все обработанные.
  const { data: bucketCounts, error: bucketError } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('bucket, email, email_validation_status, email2, email2_validation_status, company_name')
    .eq('run_id', runId);
  if (bucketError) {
    return markFailed(runId, `Failed to verify manual run completion: ${bucketError.message}`, options);
  }

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
    if (!r.bucket || !(r.bucket in buckets)) {
      return markFailed(runId, 'Manual run still has unprocessed rows; completion refused', options);
    }
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

  await updateManualRunState(runId, {
    status: 'completed',
    finished_at: new Date().toISOString(),
    processed_count: processed,
    bucket_storage_count: buckets.storage,
    bucket_medium_count: buckets.medium,
    bucket_high_count: buckets.high,
    bucket_top_count: buckets.top,
  }, options);

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
