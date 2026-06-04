/**
 * Enrich Coordinator pattern: producer/consumer API для буфера
 * `website_enrichment_results_buffer`.
 *
 * Сейчас N scraper-воркеров параллельно обогащают сайты и каждый сам пишет
 * результат в БД (queue.UPDATE + cache.UPSERT + jobs.UPDATE на каждую URL).
 * 3 воркера × 200 URL в полёте = ~600 параллельных SQL-запросов и lock
 * contention на счётчиках jobs. Добавление реплик упирается в пул соединений
 * Supabase pooler (~50-100 conn limit).
 *
 * Coordinator pattern меняет модель:
 *   • producer (scraper) пишет 1 INSERT на результат → быстрый, без локов
 *   • consumer (coordinator) drain'ит buffer пачками 50-100 и flush'ит в
 *     queue/cache/jobs батч-апсёртом — один UPDATE на 100 строк вместо 100
 *
 * Paths:
 *   • terminal статус (completed/failed/skipped) → writeEnrichResult в buffer
 *   • status='pending' (retry) → остаётся direct UPDATE через старый
 *     updateQueueItem, иначе claim_website_enrichment_items не подхватит item
 *     в текущем цикле scraper'а.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---- Public types ---------------------------------------------------------

/** Статус «что произошло на этой URL» (для coordinator'а). */
export type EnrichBufferStatus = 'completed' | 'failed' | 'skipped' | 'cache_only';

export interface EnrichBufferRow {
  queue_id: string;
  job_id: string;
  status: EnrichBufferStatus;
  /** Полный извлечённый текст. Только для status='completed'. */
  result_text?: string | null;
  /** Сообщение ошибки. Только для status='failed'/'skipped'. */
  last_error?: string | null;
  /**
   * Если задан — coordinator сделает UPSERT в website_enrichment_cache.
   * Хвост из scraper'а: setCache(urlNormalized, {text, error, sourceUrl}) —
   * cache_url_normalized = urlNormalized, source_url = sourceUrl.
   */
  cache_url_normalized?: string | null;
  cache_source_url?: string | null;
  /** Текущая попытка обработки этого queue-item'а. */
  attempt_count?: number;
}

/** Один row после drain'а — приходит из RPC. */
export interface EnrichBufferDrainedRow {
  id: number;
  queue_id: string;
  job_id: string;
  status: EnrichBufferStatus;
  result_text: string | null;
  last_error: string | null;
  cache_url_normalized: string | null;
  cache_source_url: string | null;
  attempt_count: number;
}

// ---- Producer (scraper side) ---------------------------------------------

/**
 * Записать результат scraping'а в буфер. Вызывается из scraper-воркера
 * вместо updateQueueItem + setCache + counter increment. ID воркера
 * пишется в written_by для диагностики (видно какой контейнер генерит
 * нагрузку).
 *
 * НЕ throw'ит при ошибке — возвращает {ok:false, error} чтобы scraper
 * сам решил что делать (fallback на legacy путь, лог, ретрай). Это
 * критично потому что иначе одна ошибка вставки положит весь круг
 * scraping'а.
 */
export async function writeEnrichResult(
  db: SupabaseClient,
  row: EnrichBufferRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const writtenBy = process.env.HOSTNAME ?? 'unknown';
  const payload = {
    queue_id: row.queue_id,
    job_id: row.job_id,
    status: row.status,
    result_text: row.result_text ?? null,
    last_error: row.last_error ?? null,
    cache_url_normalized: row.cache_url_normalized ?? null,
    cache_source_url: row.cache_source_url ?? null,
    attempt_count: row.attempt_count ?? 1,
    written_by: writtenBy,
  };
  const { error } = await db.from('website_enrichment_results_buffer').insert(payload);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---- Consumer (coordinator side) ------------------------------------------

/**
 * Атомарно drain'нуть batch из буфера. Под капотом — RPC
 * `drain_enrich_results_buffer(p_batch_size)`: SELECT FOR UPDATE SKIP
 * LOCKED + DELETE returning, в одной транзакции. Coordinator получает
 * строки и они уже удалены из буфера — другой coordinator (если запущено
 * 2+ инстанса) не возьмёт их повторно.
 *
 * При сбое coordinator'а ПОСЛЕ drain'а, но ДО flush'а в queue/cache/jobs,
 * данные ТЕРЯЮТСЯ. Поэтому drain должен идти В ОДНОЙ функции с flush'ом
 * и flush должен быть идемпотентным (см. flushDrained ниже — UPDATE
 * queue.status='completed' идемпотентен).
 */
export async function drainEnrichBuffer(
  db: SupabaseClient,
  batchSize = 100,
): Promise<EnrichBufferDrainedRow[]> {
  const { data, error } = await db.rpc('drain_enrich_results_buffer', {
    p_batch_size: batchSize,
  });
  if (error) throw new Error(`drain_enrich_results_buffer failed: ${error.message}`);
  return (data ?? []) as EnrichBufferDrainedRow[];
}

/**
 * Сколько сейчас в буфере. Polling-метрика для UI/healthcheck:
 * стабильное состояние = около нуля; рост = coordinator отстаёт, надо
 * либо поднять batch_size, либо проверить почему flush медленный.
 */
export async function getEnrichBufferDepth(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from('website_enrichment_results_buffer')
    .select('id', { count: 'exact', head: true });
  if (error) return 0;
  return count ?? 0;
}

// ---- Flush helpers (used by coordinator) ----------------------------------

/**
 * Группировка drained rows по типу side-effect'а для batch-flush'а:
 *   • queueUpdates — UPDATE queue.status='completed'/'failed'/'skipped'
 *   • cacheUpserts — UPSERT в website_enrichment_cache
 *   • jobsProcessedInc — счётчик processed/success/error по jobs
 *
 * Чистая функция, тестируется без БД. Coordinator вызывает её перед
 * batch-flush'ом, чтобы свести 100 строк в ≤3 SQL-запроса.
 */
export interface FlushPlan {
  queueUpdates: Array<{
    queue_id: string;
    status: 'completed' | 'failed' | 'skipped';
    result_text: string | null;
    last_error: string | null;
  }>;
  cacheUpserts: Array<{
    url_normalized: string;
    text: string | null;
    last_error: string | null;
    source_url: string | null;
  }>;
  /** Map<job_id, {processed, success, error}>. processed = success + error + skipped. */
  jobsProcessedInc: Map<string, { processed: number; success: number; error: number }>;
}

export function planFlush(rows: EnrichBufferDrainedRow[]): FlushPlan {
  const queueUpdates: FlushPlan['queueUpdates'] = [];
  const cacheUpserts: FlushPlan['cacheUpserts'] = [];
  const jobsProcessedInc: FlushPlan['jobsProcessedInc'] = new Map();

  for (const r of rows) {
    // 1. queue-row: «cache_only» не трогает queue (используется когда мы
    // хотим обновить domain-кэш как side-effect ретрая).
    if (r.status !== 'cache_only') {
      queueUpdates.push({
        queue_id: r.queue_id,
        status: r.status as 'completed' | 'failed' | 'skipped',
        result_text: r.status === 'completed' ? r.result_text : null,
        last_error: r.status === 'completed' ? null : r.last_error,
      });

      // 2. jobs-counter: processed = всегда +1; success/error по статусу.
      const cur = jobsProcessedInc.get(r.job_id) ?? { processed: 0, success: 0, error: 0 };
      cur.processed += 1;
      if (r.status === 'completed') cur.success += 1;
      else if (r.status === 'failed') cur.error += 1;
      // 'skipped' не считается ни success, ни error — но processed увеличиваем
      jobsProcessedInc.set(r.job_id, cur);
    }

    // 3. cache-upsert: пишем если scraper заполнил cache_url_normalized.
    // Coordinator решает TTL на основе наличия result_text (как делал
    // setCache в websiteEnrichmentWorker).
    if (r.cache_url_normalized) {
      cacheUpserts.push({
        url_normalized: r.cache_url_normalized,
        text: r.result_text,
        last_error: r.status === 'completed' ? null : r.last_error,
        source_url: r.cache_source_url,
      });
    }
  }

  return { queueUpdates, cacheUpserts, jobsProcessedInc };
}
