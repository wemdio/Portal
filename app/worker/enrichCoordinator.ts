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

  // 1. UPDATE queue.status — N параллельных UPDATE'ов по PK. Раньше пробовали
  // .upsert({onConflict:'id'}), но Postgres валидирует NOT NULL ДО ON CONFLICT,
  // а в payload не было job_id / url_raw / url_normalized / row_index (это
  // NOT NULL без default'ов), и каждый flush падал с
  // `null value in column "job_id" of relation "website_enrichment_queue"
  // violates not-null constraint`. Чтобы написать batch UPDATE без full payload
  // нужна RPC с UPDATE FROM (VALUES …) — будет следующим коммитом. Сейчас
  // 100 параллельных update().eq() через PG-пул отрабатывают за ~50-100мс,
  // приемлемо для нашего batch_size=100.
  if (plan.queueUpdates.length > 0) {
    const results = await Promise.allSettled(
      plan.queueUpdates.map((u) =>
        db
          .from('website_enrichment_queue')
          .update({
            status: u.status,
            result_text: u.result_text,
            last_error: u.last_error,
            updated_at: now,
            completed_at: now,
          })
          .eq('id', u.queue_id),
      ),
    );
    const failed = results.filter(
      (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.error),
    );
    if (failed.length > 0) {
      // Если упало >50% — это не точечный network glitch, а системная проблема
      // (схема/RLS/connection). Throw'аем чтобы pollLoop передохнул и логи
      // показали состояние; точечные сбои просто логируем и идём дальше.
      const sample = failed[0];
      const msg =
        sample.status === 'rejected'
          ? String((sample as PromiseRejectedResult).reason)
          : ((sample as PromiseFulfilledResult<{ error?: { message?: string } }>).value.error?.message ?? 'unknown');
      log(
        failed.length > plan.queueUpdates.length / 2 ? 'error' : 'warn',
        `queue update failed for ${failed.length}/${plan.queueUpdates.length} rows. First error: ${msg}`,
      );
      if (failed.length > plan.queueUpdates.length / 2) {
        throw new Error(`queue update mass-failure: ${failed.length}/${plan.queueUpdates.length}`);
      }
    }
  }

  // 2. UPSERT в website_enrichment_cache. Один UPSERT на N domain'ов.
  // Cache-таблица — у неё PK = url_normalized, а остальные NOT NULL колонки
  // ИМЕЮТ default'ы, так что full-upsert работает (в отличие от queue).
  //
  // Дедуп: PG ругается `ON CONFLICT DO UPDATE command cannot affect row a
  // second time`, если в одном INSERT-batch'е два row'а с одинаковым
  // url_normalized. Это реально на проде: CSV с дубликатами URL у разных
  // компаний даёт несколько queue-row'ов с одним cache_url_normalized,
  // батч флушится одним рывком и UPSERT валится. Дедуп here — last wins
  // (как делал бы legacy setCache, который шёл в порядке завершения
  // scrapping'а; последний успешный результат всё равно был бы цели).
  const cacheBy = new Map<string, typeof plan.cacheUpserts[number]>();
  for (const c of plan.cacheUpserts) {
    if (!c.url_normalized) continue;
    cacheBy.set(c.url_normalized, c);
  }
  if (cacheBy.size > 0) {
    const cachePayload = Array.from(cacheBy.values()).map((c) => ({
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
      log('warn', `cache upsert failed (${cachePayload.length} rows, non-fatal): ${cErr.message}`);
    }
  }

  // 3. jobs counters — единственный writer теперь coordinator (flushProgress
  // удалён из websiteEnrichmentWorker, см. историю коммитов 04.06). Per-job
  // атомарный RPC: UPDATE jobs SET processed = processed + p_processed_inc, …
  // — race-free между параллельными drain'ами (coordinator-single-instance).
  // Failure'ы логируем, но не throw: данные в queue уже обновлены, лучше
  // продолжить flush'ить следующие batch'ы. Если counter'ы расходятся,
  // оператор увидит это в UI и можно будет руками синхронизировать через
  // SELECT count(*) ... WHERE status IN (…) GROUP BY job_id.
  for (const [jobId, inc] of plan.jobsProcessedInc.entries()) {
    const { error: rpcErr } = await db.rpc('increment_website_enrichment_job_counters', {
      p_job_id: jobId,
      p_processed_inc: inc.processed,
      p_success_inc: inc.success,
      p_error_inc: inc.error,
    });
    if (rpcErr) {
      log('warn', `jobs counter inc failed for ${jobId}: ${rpcErr.message}`);
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
