/**
 * Enrich Coordinator worker — единый writer для результатов scraping'а.
 *
 * Контекст. С coordinator pattern N scraper-воркеров пишут результаты в
 * `website_enrichment_results_buffer` (одна строка на URL, fast INSERT без
 * lock contention). Этот воркер — единственный consumer: drain'ит buffer
 * пачками и flush'ит в `website_enrichment_queue` / `website_enrichment_cache`
 * / `website_enrichment_jobs` батч-апсёртом. См. lib/enrich/enrichBuffer.ts
 * для деталей про producer/consumer API.
 *
 * Запускается отдельным docker-сервисом `worker-enrich-coordinator`
 * (1 replica). WORKER_KIND=enrich-coordinator подхватывается worker/runner.ts.
 *
 * Безопасность: drain_enrich_results_buffer (RPC) делает SELECT FOR UPDATE
 * SKIP LOCKED + DELETE returning в одной транзакции. Если запустить 2+
 * coordinator-реплики, они не съедят одни и те же строки. Но больше одной
 * реплики смысла нет: серия batch-flush'ей всё равно serializesь на jobs
 * counter UPDATE. Запуск 2-й реплики только разделит throughput пополам.
 *
 * При сбое после drain'а, до flush'а — строки потеряны. Mitigated тем что:
 *   • flush идемпотентен (UPDATE queue.status='completed' WHERE id=$1 ok
 *     если уже completed; jobs.processed считается по queue COUNT снаружи)
 *   • drain batch'и маленькие (100 строк, ~0.5 сек на flush)
 *   • продакшен SIGTERM воркера ждёт inflight'а через stop_grace_period
 */

import {
  drainEnrichBuffer,
  getEnrichBufferDepth,
  planFlush,
  type EnrichBufferDrainedRow,
  type FlushPlan,
} from '@/lib/enrich/enrichBuffer';
import {
  createWorkerLogger,
  pollLoop,
  requireSupabaseAdmin,
  setupGracefulShutdown,
} from './_shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '1000');

/** Сколько строк brать за один drain. 100 — компромисс между латентностью
 *  результата (UI прогресс) и КПД batch-апсёрта. */
const DRAIN_BATCH_SIZE = Number(process.env.ENRICH_COORDINATOR_BATCH ?? '100');

/** TTL'и для domain-кэша. Дублируют константы websiteEnrichmentWorker, потому
 *  что coordinator пишет cache на основе buffer-row, а не из scraper'а. */
const CACHE_SUCCESS_DAYS = Number(process.env.WEBSITE_ENRICHMENT_CACHE_DAYS ?? '7');
const CACHE_ERROR_HOURS = Number(process.env.WEBSITE_ENRICHMENT_ERROR_TTL_HOURS ?? '6');

const WORKER_ID = `enrich-coordinator-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

// ---- Stats (для healthcheck/визуализации) ---------------------------------

let totalDrained = 0;
let totalFlushed = 0;
let lastDrainAt = 0;
let lastBackpressureWarnAt = 0;

function cacheTtlMs(text: string | null | undefined): number {
  // Если есть текст — длинный TTL (положительный кэш). Если только ошибка —
  // короткий TTL, чтобы не зафиксировать transient ban'а навечно.
  return text && text.length > 0
    ? CACHE_SUCCESS_DAYS * 24 * 60 * 60 * 1000
    : CACHE_ERROR_HOURS * 60 * 60 * 1000;
}

// ---- Batch flush ---------------------------------------------------------

/**
 * Сделать атомарный flush одного drain'а: queue UPDATE, cache UPSERT, jobs
 * counter increment. Все три — раздельные SQL-вызовы, но каждый batch'ит
 * 50-100 row'ов одной командой. Если падает в середине — следующий drain
 * подхватит свои строки (drain + flush идемпотентны: UPDATE queue.status
 * к одному и тому же значению no-op, UPSERT cache по PK no-op, counter
 * jobs read-modify-write изолирован per-job).
 */
async function flushBatch(db: SupabaseClient, rows: EnrichBufferDrainedRow[]): Promise<void> {
  const plan: FlushPlan = planFlush(rows);
  const now = new Date().toISOString();

  // 1. UPDATE queue.status одним запросом на терминальный статус.
  // Группируем по status, чтобы один UPDATE сделал N строк с одинаковыми
  // полями. result_text/last_error разные у разных row'ов — придётся
  // делать UPDATE через CASE WHEN, что неудобно в supabase-js. Вместо
  // этого делаем N UPSERT'ов одной операцией через .upsert на PK queue.id.
  if (plan.queueUpdates.length > 0) {
    const queuePayload = plan.queueUpdates.map((u) => ({
      id: u.queue_id,
      status: u.status,
      result_text: u.result_text,
      last_error: u.last_error,
      updated_at: now,
      completed_at: now,
    }));
    // upsert {onConflict:'id'} = UPDATE существующей row'и (PK), вставка
    // не произойдёт потому что строки уже есть (создаются при enqueue job'а).
    const { error: qErr } = await db
      .from('website_enrichment_queue')
      .upsert(queuePayload, { onConflict: 'id' });
    if (qErr) {
      log('error', `queue upsert failed (${plan.queueUpdates.length} rows): ${qErr.message}`);
      throw qErr;
    }
  }

  // 2. UPSERT в website_enrichment_cache. Один UPSERT на N domain'ов.
  if (plan.cacheUpserts.length > 0) {
    const cachePayload = plan.cacheUpserts.map((c) => ({
      url_normalized: c.url_normalized,
      text: c.text,
      last_error: c.last_error,
      fetched_at: now,
      expires_at: new Date(Date.now() + cacheTtlMs(c.text)).toISOString(),
      source_url: c.source_url,
    }));
    const { error: cErr } = await db
      .from('website_enrichment_cache')
      .upsert(cachePayload, { onConflict: 'url_normalized' });
    if (cErr) {
      // Cache write — best-effort, не блокирует основной flush.
      log('warn', `cache upsert failed (${plan.cacheUpserts.length} rows, non-fatal): ${cErr.message}`);
    }
  }

  // 3. jobs counters. Делаем RPC-инкремент, чтобы было атомарно для каждого
  //    job_id и не race'ило с другими источниками jobs.processed (старый
  //    websiteEnrichmentWorker.flushProgress тоже пишет туда).
  //    Если RPC ещё нет — фоллбекаем на read-modify-write.
  if (plan.jobsProcessedInc.size > 0) {
    for (const [jobId, inc] of plan.jobsProcessedInc.entries()) {
      const { error: rpcErr } = await db.rpc('increment_website_enrichment_job_counters', {
        p_job_id: jobId,
        p_processed_inc: inc.processed,
        p_success_inc: inc.success,
        p_error_inc: inc.error,
      });
      if (rpcErr) {
        // Fallback: legacy путь — websiteEnrichmentWorker сам пересчитает
        // processed по COUNT'у queue при следующем flushProgress. Не критично.
        log('warn', `jobs counter inc failed for ${jobId} (will recover on next worker flush): ${rpcErr.message}`);
      }
    }
  }

  totalFlushed += rows.length;
}

// ---- Main loop -----------------------------------------------------------

async function pollOnce(): Promise<boolean> {
  const db = requireSupabaseAdmin(log);
  let rows: EnrichBufferDrainedRow[];
  try {
    rows = await drainEnrichBuffer(db, DRAIN_BATCH_SIZE);
  } catch (err) {
    log('error', `drain failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (rows.length === 0) return false;

  lastDrainAt = Date.now();
  totalDrained += rows.length;

  try {
    await flushBatch(db, rows);
  } catch (err) {
    log('error', `flush failed for ${rows.length} rows: ${err instanceof Error ? err.message : String(err)}`);
    // Возвращаем true чтобы pollLoop не ушёл в долгую паузу — попробуем
    // снова. Если падение перманентное — увидим в логах поток ошибок и
    // alert'нём. Drain уже DELETE-нул эти строки из буфера, и они
    // действительно потеряны для retry — единственный путь восстановления
    // это COUNT-recovery в websiteEnrichmentWorker.flushProgress.
    return false;
  }

  // Backpressure-сигнал: если в буфере >5×batch_size значит scrapers
  // пишут быстрее чем мы flush'им. Логируем не чаще раза в минуту, чтобы
  // не зашуметь, но достаточно часто чтобы оператор заметил.
  if (Date.now() - lastBackpressureWarnAt > 60_000) {
    try {
      const depth = await getEnrichBufferDepth(db);
      if (depth > DRAIN_BATCH_SIZE * 5) {
        log('warn', `coordinator behind: buffer depth=${depth} (>5x batch). Consider raising ENRICH_COORDINATOR_BATCH or check DB latency.`);
        lastBackpressureWarnAt = Date.now();
      }
    } catch {
      // Backlog-метрика — best-effort.
    }
  }

  // Если drain вернул full batch, скорее всего там есть ещё — крутимся снова
  // без задержки чтобы не отставать.
  return rows.length === DRAIN_BATCH_SIZE;
}

async function main(): Promise<void> {
  log('info', `Enrich coordinator starting (poll=${POLL_INTERVAL_MS}ms, batch=${DRAIN_BATCH_SIZE})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    // Realtime на buffer-таблицу: ускоряет wake-up когда scrapers начинают
    // писать в простаивающую систему (без realtime пришлось бы ждать polling
    // интервал, что добавляет до 1 сек латентности).
    realtimeTables: ['website_enrichment_results_buffer'],
  });
  log('info', `Enrich coordinator stopped. Drained=${totalDrained}, flushed=${totalFlushed}, last drain at ${new Date(lastDrainAt).toISOString()}`);
}

main().catch((err) => {
  log('error', `Coordinator crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
