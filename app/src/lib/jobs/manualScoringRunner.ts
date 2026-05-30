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
import type { LeadCreatePayload } from '@/lib/instantly/types';

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
  /** Прогресс-callback после каждого batch — даёт воркеру писать в БД. */
  onProgress?: (processed: number) => Promise<void>;
  /** Concurrency для Mailganer + scrape. Default 5. */
  concurrency?: number;
  /** Лимит на одну строку, чтобы не зависнуть. Default 60 сек. */
  perRowTimeoutMs?: number;
}

interface ProcessResult {
  status: 'completed' | 'failed';
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

  const concurrency = opts.concurrency ?? 5;

  // 1. Mark as processing
  await supabaseAdmin
    .from('client_manual_score_runs')
    .update({ status: 'processing' })
    .eq('id', opts.runId);

  // 2. Берём все ещё не обработанные строки этого прогона
  const { data: rowsData, error: rowsErr } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('id, domain')
    .eq('run_id', opts.runId)
    .is('bucket', null)
    .order('id', { ascending: true });

  if (rowsErr) {
    return await markFailed(opts.runId, `Failed to load rows: ${rowsErr.message}`);
  }

  const rows = (rowsData ?? []) as Array<{ id: number; domain: string | null }>;
  if (rows.length === 0) {
    // Нечего обрабатывать. Возможно прогон уже завершён или был пуст.
    return await finalize(opts.runId);
  }

  // 3. Shared MX cache между всеми row'ами этого прогона — economy для повторяющихся
  //    доменов внутри одного файла (бывает).
  const domainInfoCache = new Map<string, DomainInfo>();

  // 4. Worker pool
  let cursor = 0;
  let processedSinceLastProgress = 0;
  const PROGRESS_FLUSH_EVERY = 25;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];

      const result = await processOneRow(row, opts.endpoint, domainInfoCache);

      // Сохраняем результат — независимо от ошибки. bucket всегда выставляем,
      // чтобы при повторном вызове processManualRun row не выбралась снова.
      await supabaseAdmin!
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
          processed_at: new Date().toISOString(),
        })
        .eq('id', row.id);

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

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, rows.length) }, worker),
    );
  } catch (err) {
    return await markFailed(
      opts.runId,
      err instanceof Error ? err.message : 'worker pool crashed',
    );
  }

  // 4.5. Резолв названий (кэш ФНС) + чистка (AI как кнопка «Очистить названия»)
  //      + маршрутизация активных контактов в СУЩЕСТВУЮЩИЕ кампании авто-
  //      пайплайна по скорингу. Не валит прогон при сбое.
  try {
    await resolveNamesAndRoute(opts.runId);
  } catch (err) {
    console.error('[manual-scoring] resolveNamesAndRoute failed', err);
  }

  return await finalize(opts.runId);
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
async function resolveNamesAndRoute(runId: string): Promise<void> {
  if (!supabaseAdmin) return;

  const { data: run } = await supabaseAdmin
    .from('client_manual_score_runs')
    .select('client_user_id')
    .eq('id', runId)
    .single();
  const clientUserId = (run as { client_user_id?: string } | null)?.client_user_id;
  if (!clientUserId) return;

  const { data: rowsData } = await supabaseAdmin
    .from('client_manual_score_rows')
    .select('id, domain, score, email, email_validation_status, email2, email2_validation_status, scraped_name')
    .eq('run_id', runId)
    .in('bucket', ['medium', 'high', 'top'])
    .not('email', 'is', null)
    .is('company_name', null);
  const rows = (rowsData ?? []) as Array<{
    id: number;
    domain: string | null;
    score: number | null;
    email: string | null;
    email_validation_status: string | null;
    email2: string | null;
    email2_validation_status: string | null;
    scraped_name: string | null;
  }>;
  if (rows.length === 0) return;

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
        (r.domain ? nameByDomain.get(r.domain) : null) ||
        r.scraped_name ||
        (r.domain ? domainToNameCandidate(r.domain) : ''),
      domain: r.domain,
    })),
  );

  // 3. Сохраняем company_name ('' = резолв выполнен, имени нет → идемпотентность).
  for (let i = 0; i < rows.length; i += 1) {
    await supabaseAdmin
      .from('client_manual_score_rows')
      .update({ company_name: cleaned[i] || '' })
      .eq('id', rows[i].id);
  }

  // 4. Маршрутизация в существующие кампании по скорингу — если настроены.
  const { data: cfg } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('score_buckets')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  const buckets = ((cfg as { score_buckets?: unknown } | null)?.score_buckets ?? []) as Array<{
    score_min: number;
    score_max: number | null;
    instantly_campaign_id: string | null;
    sequence?: { steps?: unknown[] };
    label?: string;
  }>;
  if (!Array.isArray(buckets) || buckets.length === 0) return; // кампании не настроены → только CSV

  const groups = new Map<string, { campaignId: string; label: string; leads: LeadCreatePayload[] }>();
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
      g = { campaignId: bucket.instantly_campaign_id, label: bucket.label ?? 'manual', leads: [] };
      groups.set(bucket.instantly_campaign_id, g);
    }
    for (const addr of validEmails) {
      g.leads.push({
        email: addr,
        company_name: name,
        website: `https://${r.domain}`,
        custom_variables: { source: 'manual', score: String(r.score), domain: r.domain },
      });
    }
  }

  for (const g of groups.values()) {
    try {
      await appendLeadsToClientCampaign({
        userId: clientUserId,
        campaignId: g.campaignId,
        leads: g.leads,
        contextLabel: `manual:${g.label}`,
      });
    } catch (err) {
      console.error('[manual-scoring] append to campaign failed', g.campaignId, err);
    }
  }
}

interface ProcessedRow {
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

async function markFailed(runId: string, message: string): Promise<ProcessResult> {
  if (supabaseAdmin) {
    await supabaseAdmin
      .from('client_manual_score_runs')
      .update({
        status: 'failed',
        error_message: message.slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
  }
  return {
    status: 'failed',
    total: 0,
    buckets: { storage: 0, medium: 0, high: 0, top: 0, invalid: 0 },
    error: message,
  };
}

async function finalize(runId: string): Promise<ProcessResult> {
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

  await supabaseAdmin
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
    .eq('id', runId);

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
