/**
 * HH Archive Job Runner — оркестратор: читает конфиг job'а из БД, ищет
 * подходящие вакансии в локальном архиве `hh_vacancies`, пишет результаты
 * в `hh_archive_results`, обновляет прогресс.
 *
 * Запускается из `app/worker/hh.ts` (общий HH-воркер).
 *
 * До 27.07.2026: ходил в api.hh.ru и рекурсивно партиционировал даты, чтобы
 * обойти лимит 2000 на запрос. Проблема — HH API отдаёт только последние
 * ~60 дней, поэтому за 2023-2025 всегда возвращал 0 (см. инцидент
 * 27.07.2026). Теперь ищем локально в накопленной истории `hh_vacancies`
 * (обычный парсер спецов + auto-pipeline Mailganer льют туда всё, что
 * парсят). Плюс: работает мгновенно, без прокси и rate-limit; минус:
 * граница снизу — самая старая запись в hh_vacancies (~04.02.2026).
 *
 * Логика упростилась радикально:
 *   1. Для каждого search_query — SELECT из hh_vacancies с фильтрами.
 *   2. Дедуп по vacancy_id между разными query.
 *   3. Batch-INSERT в hh_archive_results.
 *   4. cancelled-check между query'ями (юзер мог нажать «отменить»).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveHhEmployerId } from '@/lib/parsers/hhEmployerId';
import { parseAreas } from './parser';
import { fetchVacanciesLocal, type LocalVacancyRow } from './localSearch';

interface HHArchiveJobRow {
  id: string;
  user_id: string;
  search_queries: string[];
  area: string;
  date_from: string;
  date_to: string;
  archived: boolean;
  chunk_strategy: string;
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
  const { error } = await db.from('hh_archive_jobs').update(patch).eq('id', jobId);
  if (error) console.error(`[hh-archive][${jobId}] updateJob failed:`, error.message);
}

async function insertBatch(
  db: SupabaseClient,
  jobId: string,
  query: string,
  rows: LocalVacancyRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((v) => ({
    job_id: jobId,
    vacancy_id: v.vacancy_id,
    title: v.name ?? '',
    company: v.company_name ?? '',
    company_site_url: v.company_site_url ?? '',
    area: v.area ?? '',
    employer_id: resolveHhEmployerId(v.employer_id, v.company_url),
    published_at: v.published_at,
    // archived_at у нас в hh_vacancies не хранится — фиксируем момент,
    // когда мы вытащили запись в архив.
    archived_at: null,
    raw_query: query,
  }));

  // ON CONFLICT DO NOTHING имитируем через upsert по уникальному (job_id, vacancy_id).
  // Дубли между разными query внутри одного job'а — нормально: юзер видит
  // «какой query нашёл эту вакансию», но в архив её пишем один раз.
  const { error } = await db
    .from('hh_archive_results')
    .upsert(payload, { onConflict: 'job_id,vacancy_id', ignoreDuplicates: true });
  if (error) {
    console.error(`[hh-archive][${jobId}] insertBatch error:`, error.message);
    return 0;
  }
  return payload.length;
}

export async function runHHArchiveJob(db: SupabaseClient, jobId: string): Promise<void> {
  console.log(`[hh-archive][${jobId}] starting (local-search mode)`);

  const { data: job, error } = await db
    .from('hh_archive_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle<HHArchiveJobRow>();

  if (error || !job) {
    console.error(`[hh-archive][${jobId}] job not found:`, error?.message);
    return;
  }

  const maxResults = job.max_results;
  const areaIds = parseAreas(job.area || '113');
  const queries = Array.isArray(job.search_queries) ? job.search_queries : [];

  await updateJob(db, jobId, {
    status: 'processing',
    started_at: new Date().toISOString(),
    errors_count: 0,
    error_message: null,
    total_chunks: queries.length,
    processed_chunks: 0,
    found_total: 0,
    saved_total: 0,
  });

  // Глобальный дедуп между разными query — одна вакансия могла подпасть
  // под несколько ключевиков, в архив пишем один раз (тем query'ем, что
  // нашёл её первым).
  const seenVacancyIds = new Set<string>();
  let savedTotal = 0;
  let foundTotal = 0;
  let errorsCount = 0;

  try {
    for (let i = 0; i < queries.length; i += 1) {
      if (savedTotal >= maxResults) {
        console.log(`[hh-archive][${jobId}] hit max_results=${maxResults}, stopping`);
        break;
      }
      if (await isCancelled(db, jobId)) {
        console.log(`[hh-archive][${jobId}] cancelled by user`);
        return;
      }

      const query = queries[i];
      const remaining = maxResults - savedTotal;

      let rows: LocalVacancyRow[];
      try {
        rows = await fetchVacanciesLocal(
          {
            query,
            areaIds,
            dateFrom: job.date_from,
            dateTo: job.date_to,
          },
          // С запасом: часть отвалится дедупом с ранее набранными query.
          Math.min(remaining * 2, remaining + 5000),
        );
      } catch (e) {
        errorsCount += 1;
        console.error(`[hh-archive][${jobId}] query "${query}" failed:`, (e as Error).message);
        rows = [];
      }

      foundTotal += rows.length;

      // Дедуп против уже сохранённых из предыдущих query.
      const fresh: LocalVacancyRow[] = [];
      for (const r of rows) {
        if (seenVacancyIds.has(r.vacancy_id)) continue;
        seenVacancyIds.add(r.vacancy_id);
        fresh.push(r);
        if (savedTotal + fresh.length >= maxResults) break;
      }

      const insertedCount = await insertBatch(db, jobId, query, fresh);
      savedTotal += insertedCount;

      await updateJob(db, jobId, {
        processed_chunks: i + 1,
        found_total: foundTotal,
        saved_total: savedTotal,
        errors_count: errorsCount,
      });

      console.log(
        `[hh-archive][${jobId}] query ${i + 1}/${queries.length} "${query}": found=${rows.length}, saved+=${insertedCount}, total_saved=${savedTotal}`,
      );
    }

    await updateJob(db, jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      found_total: foundTotal,
      saved_total: savedTotal,
      errors_count: errorsCount,
      processed_chunks: queries.length,
    });
    console.log(
      `[hh-archive][${jobId}] completed: saved ${savedTotal}/${foundTotal} (${errorsCount} errors)`,
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
