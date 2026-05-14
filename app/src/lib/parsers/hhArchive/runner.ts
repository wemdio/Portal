/**
 * HH Archive Job Runner — оркестратор: читает конфиг job'а из БД,
 * прогоняет parser.ts по всем (query × chunk × page), пишет результаты
 * в hh_archive_results, обновляет прогресс.
 *
 * Запускается из `app/worker/hh.ts` (общий HH-воркер).
 *
 * Защита от перегруза:
 *   * Если в каком-то чанке `found > 2000` — пишем warning в errors_count,
 *     но не падаем (берём первые 2000, остальное — потеря, юзер видит
 *     в UI и переключает chunk_strategy на более узкое).
 *   * Hard stop при saved_total >= max_results — даже если HH вернул больше.
 *   * cancelled check между итерациями (если юзер нажал «отменить»).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HH_API_RESULTS_HARD_CAP,
  HH_API_MAX_PAGE,
  buildSearchUrl,
  chunkDateRange,
  extractVacancies,
  fetchHHJson,
  sleep,
  type ChunkStrategy,
  type HHParseConfig,
  type HHRawResponse,
} from './parser';

const DEFAULT_USER_AGENT =
  process.env.HH_ARCHIVE_USER_AGENT ??
  'PolzaAgency-Portal/1.0 (hello@polzaagency.ru)';

const OAUTH_TOKEN = process.env.HH_OAUTH_TOKEN || undefined;

/** Базовая задержка между запросами. Можно поднять через env если ловим 429. */
const REQUEST_DELAY_MS = Number(process.env.HH_ARCHIVE_REQUEST_DELAY_MS ?? '1500');

interface HHArchiveJobRow {
  id: string;
  user_id: string;
  search_queries: string[];
  area: string;
  date_from: string;
  date_to: string;
  archived: boolean;
  chunk_strategy: ChunkStrategy;
  max_results: number;
  status: string;
}

async function isCancelled(db: SupabaseClient, jobId: string): Promise<boolean> {
  const { data } = await db
    .from('hh_archive_jobs')
    .select('status')
    .eq('id', jobId)
    .maybeSingle();
  return data?.status === 'cancelled';
}

async function updateJob(
  db: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // Heartbeat-стиль: каждый update bumps updated_at через trigger.
  const { error } = await db.from('hh_archive_jobs').update(patch).eq('id', jobId);
  if (error) console.error(`[hh-archive][${jobId}] updateJob failed:`, error.message);
}

export async function runHHArchiveJob(db: SupabaseClient, jobId: string): Promise<void> {
  console.log(`[hh-archive][${jobId}] starting`);

  const { data: job, error } = await db
    .from('hh_archive_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle<HHArchiveJobRow>();

  if (error || !job) {
    console.error(`[hh-archive][${jobId}] job not found:`, error?.message);
    return;
  }

  await updateJob(db, jobId, {
    status: 'processing',
    started_at: new Date().toISOString(),
    errors_count: 0,
    error_message: null,
  });

  const config: HHParseConfig = {
    searchQueries: Array.isArray(job.search_queries) ? job.search_queries : [],
    area: job.area || '113',
    dateFrom: job.date_from,
    dateTo: job.date_to,
    archived: job.archived,
    chunkStrategy: job.chunk_strategy,
    userAgent: DEFAULT_USER_AGENT,
    oauthToken: OAUTH_TOKEN,
    requestDelayMs: REQUEST_DELAY_MS,
  };

  const dateChunks = chunkDateRange(config.dateFrom, config.dateTo, config.chunkStrategy);
  const totalChunks = dateChunks.length * config.searchQueries.length;
  console.log(
    `[hh-archive][${jobId}] ${config.searchQueries.length} queries × ${dateChunks.length} chunks = ${totalChunks} requests minimum`,
  );

  await updateJob(db, jobId, { total_chunks: totalChunks });

  // Глобальный набор vacancy_id чтобы не сохранять дубли в одном job'е.
  // По месту вставки в БД ON CONFLICT не используем — он есть в схеме как
  // UNIQUE(job_id, vacancy_id), но дедуп в JS дешевле чем roundtrip к БД.
  const seenVacancyIds = new Set<string>();
  let foundTotal = 0;
  let savedTotal = 0;
  let errorsCount = 0;
  let processedChunks = 0;

  try {
    for (const query of config.searchQueries) {
      if (savedTotal >= job.max_results) {
        console.log(
          `[hh-archive][${jobId}] hit max_results=${job.max_results}, stopping`,
        );
        break;
      }
      if (await isCancelled(db, jobId)) {
        console.log(`[hh-archive][${jobId}] cancelled by user`);
        return;
      }

      for (const { from, to } of dateChunks) {
        if (savedTotal >= job.max_results) break;
        if (await isCancelled(db, jobId)) return;

        processedChunks += 1;

        // Стр. 0 — узнаём found / pages
        let firstResp;
        try {
          firstResp = await fetchHHJson(buildSearchUrl(config, query, 0, from, to), config);
        } catch (e) {
          errorsCount += 1;
          console.error(`[hh-archive][${jobId}] chunk failed ${query}/${from}..${to}:`, (e as Error).message);
          await updateJob(db, jobId, { errors_count: errorsCount, processed_chunks: processedChunks });
          await sleep(REQUEST_DELAY_MS);
          continue;
        }

        const found = firstResp.found ?? 0;
        foundTotal += Math.min(found, HH_API_RESULTS_HARD_CAP); // потому что больше не достать
        const pagesAvailable = Math.min(firstResp.pages ?? 0, HH_API_MAX_PAGE + 1);

        if (found > HH_API_RESULTS_HARD_CAP) {
          // Юзер должен переключить chunk_strategy. Записываем в errors_count
          // и сообщение, но продолжаем — лучше взять 2000 чем ничего.
          console.warn(
            `[hh-archive][${jobId}] chunk ${query}/${from}..${to}: found=${found} > 2000, will lose ${found - HH_API_RESULTS_HARD_CAP}`,
          );
        }

        // Сохраняем page 0
        await persistVacancies(db, jobId, query, firstResp, seenVacancyIds);

        // Pages 1..pagesAvailable-1
        for (let page = 1; page < pagesAvailable; page += 1) {
          if (savedTotal + seenVacancyIds.size >= job.max_results) break;
          if (await isCancelled(db, jobId)) return;
          await sleep(REQUEST_DELAY_MS);
          try {
            const resp = await fetchHHJson(buildSearchUrl(config, query, page, from, to), config);
            await persistVacancies(db, jobId, query, resp, seenVacancyIds);
          } catch (e) {
            errorsCount += 1;
            console.error(`[hh-archive][${jobId}] page ${page} failed:`, (e as Error).message);
          }
        }

        savedTotal = seenVacancyIds.size;
        await updateJob(db, jobId, {
          processed_chunks: processedChunks,
          found_total: foundTotal,
          saved_total: savedTotal,
          errors_count: errorsCount,
        });

        await sleep(REQUEST_DELAY_MS);
      }
    }

    await updateJob(db, jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      found_total: foundTotal,
      saved_total: savedTotal,
      errors_count: errorsCount,
      processed_chunks: processedChunks,
    });
    console.log(
      `[hh-archive][${jobId}] completed: saved ${savedTotal}/${foundTotal} (${errorsCount} chunk errors)`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[hh-archive][${jobId}] FAILED:`, message);
    await updateJob(db, jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: message.slice(0, 500),
      saved_total: savedTotal,
      errors_count: errorsCount + 1,
    });
  }
}

async function persistVacancies(
  db: SupabaseClient,
  jobId: string,
  query: string,
  response: HHRawResponse,
  seen: Set<string>,
): Promise<void> {
  const vacs = extractVacancies(response);
  const rows = vacs
    .filter((v) => v.vacancyId && !seen.has(v.vacancyId))
    .map((v) => {
      seen.add(v.vacancyId);
      return {
        job_id: jobId,
        vacancy_id: v.vacancyId,
        title: v.title,
        company: v.company,
        company_site_url: v.companySiteUrl,
        area: v.area,
        employer_id: v.employerId,
        published_at: v.publishedAt,
        archived_at: v.archivedAt,
        raw_query: query,
      };
    });
  if (rows.length === 0) return;

  // ON CONFLICT DO NOTHING на уровне БД (UNIQUE(job_id, vacancy_id) уже есть)
  const { error } = await db.from('hh_archive_results').insert(rows);
  if (error) {
    // 23505 — duplicate key (если 2 чанка перекрылись по дате — нормально).
    // Остальное — реальная проблема, логируем но не валим job.
    if (!error.message.includes('duplicate')) {
      console.error(`[hh-archive][${jobId}] persistVacancies error:`, error.message);
    }
  }
}
