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
 *
 * 02.09.2026 — единый жизненный цикл задач (app/src/lib/jobs/lifecycle.ts).
 * Из воркера функция вызывается с контекстом: после каждого чанка пишется
 * чекпойнт, при следующем захвате уже пройденные чанки пропускаются, а все
 * записи в строку задачи ограждены жетоном захвата. Без контекста (старые
 * вызовы) поведение прежнее.
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
  found_total: number | null;
  saved_total: number | null;
  errors_count: number | null;
}

/**
 * Курсор задачи: сколько поисковых запросов (чанков) уже пройдено.
 *
 * Позиционный курсор законен здесь ровно потому, что последовательность
 * чанков между заходами неизменна: чанки — это элементы массива
 * `hh_archive_jobs.search_queries`, сохранённого в самой строке задачи при её
 * создании. Никакой выборки из базы, никакого обхода Set/Map — порядок задан
 * JSON-массивом и воспроизводится дословно. Если когда-нибудь чанки начнут
 * получать запросом (или сортировкой по чему-то меняющемуся), этот курсор
 * станет тихой потерей данных, и его придётся якорить по значению.
 */
export interface HHArchiveCheckpoint {
  processed_chunks: number;
}

/**
 * Контекст исполнения под единым жизненным циклом. Необязателен: функция
 * зовётся и из мест без аренды, там всё работает как раньше.
 */
export interface HHArchiveRunContext {
  /** Взводится на SIGTERM, при потере аренды и при перехвате строки. */
  signal: AbortSignal;
  /** Жетон захвата: им ограждается КАЖДАЯ запись в строку задачи. */
  runToken: string;
  /** Чекпойнт прошлого захвата — с него продолжаем. */
  checkpoint?: HHArchiveCheckpoint | null;
  /** false — строку перехватили, работу надо прекратить. */
  saveCheckpoint(data: HHArchiveCheckpoint): Promise<boolean>;
}

/** Терминальная запись снимает владение вместе со статусом. */
const CLEAR_OWNERSHIP = { lease_until: null, run_token: null, worker_id: null };

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
  ctx?: HHArchiveRunContext,
): Promise<void> {
  const query = db.from('hh_archive_jobs').update(patch).eq('id', jobId);
  // Тип билдера — any по той же причине, что в lib/jobs/lifecycle.ts: цепочка
  // PostgREST меняет форму на каждом шаге, а нам от неё нужен только .eq.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (ctx ? (query as any).eq('run_token', ctx.runToken) : query);
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

export async function runHHArchiveJob(
  db: SupabaseClient,
  jobId: string,
  ctx?: HHArchiveRunContext,
): Promise<void> {
  const resumeFrom = Math.max(0, Number(ctx?.checkpoint?.processed_chunks ?? 0));
  console.log(
    `[hh-archive][${jobId}] starting (local-search mode)${resumeFrom > 0 ? `, RESUME from chunk ${resumeFrom}` : ''}`,
  );

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

  // При продолжении счётчики НЕ обнуляем: они уже описывают сделанную работу,
  // а max_results считается по ней же. started_at при захвате ставит раннер
  // (claimPatch), поэтому здесь его пишем только в вызовах без контекста.
  await updateJob(db, jobId, resumeFrom > 0
    ? { status: 'processing', error_message: null, total_chunks: queries.length }
    : {
      status: 'processing',
      ...(ctx ? {} : { started_at: new Date().toISOString() }),
      errors_count: 0,
      error_message: null,
      total_chunks: queries.length,
      processed_chunks: 0,
      found_total: 0,
      saved_total: 0,
    }, ctx);

  // Глобальный дедуп между разными query — одна вакансия могла подпасть
  // под несколько ключевиков, в архив пишем один раз (тем query'ем, что
  // нашёл её первым).
  //
  // При продолжении множество пустое: вакансии, найденные в прошлом заходе,
  // повторно попадут в fresh и будут посчитаны в found/saved. Данные от этого
  // не портятся — upsert по (job_id, vacancy_id) с ignoreDuplicates не создаёт
  // дублей; сдвигается только счётчик saved_total (в большую сторону) на
  // задаче, которую пришлось подобрать. Хранить весь список vacancy_id в
  // чекпойнте ради точности счётчика дороже, чем сам счётчик стоит.
  const seenVacancyIds = new Set<string>();
  let savedTotal = resumeFrom > 0 ? (job.saved_total ?? 0) : 0;
  let foundTotal = resumeFrom > 0 ? (job.found_total ?? 0) : 0;
  let errorsCount = resumeFrom > 0 ? (job.errors_count ?? 0) : 0;

  try {
    for (let i = resumeFrom; i < queries.length; i += 1) {
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
          ctx?.signal,
        );
      } catch (e) {
        // Остановку отличаем по СОСТОЯНИЮ СИГНАЛА, а не по имени ошибки:
        // AbortError мог прилететь и от чужого таймаута, и такой случай обязан
        // остаться настоящей ошибкой запроса. Выходим молча — терминальный
        // статус не пишем, строку с сохранённым чекпойнтом подберёт сосед.
        if (ctx?.signal.aborted) {
          console.log(`[hh-archive][${jobId}] stopped during query "${query}" — leaving job for reclaim`);
          return;
        }
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
      }, ctx);

      console.log(
        `[hh-archive][${jobId}] query ${i + 1}/${queries.length} "${query}": found=${rows.length}, saved+=${insertedCount}, total_saved=${savedTotal}`,
      );

      if (ctx) {
        const owned = await ctx.saveCheckpoint({ processed_chunks: i + 1 });
        // Строку перехватили: терминальный статус не наш, продолжит новый
        // владелец с этого же чанка.
        if (!owned) return;
      }
      // Остановка воркера: выходим без терминальной записи — аренду отпустит
      // библиотека, задачу подберёт соседняя реплика.
      if (ctx?.signal.aborted) return;
    }

    await updateJob(db, jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      found_total: foundTotal,
      saved_total: savedTotal,
      errors_count: errorsCount,
      processed_chunks: queries.length,
      ...CLEAR_OWNERSHIP,
    }, ctx);
    console.log(
      `[hh-archive][${jobId}] completed: saved ${savedTotal}/${foundTotal} (${errorsCount} errors)`,
    );
  } catch (e) {
    // Та же развилка, что и у прерванного запроса: судим по сигналу, а не по
    // тексту/имени ошибки. Иначе остановка воркера записалась бы пользователю
    // как падение задачи, а честный таймаут — как остановка.
    if (ctx?.signal.aborted) {
      console.log(`[hh-archive][${jobId}] stopped mid-run — leaving job for reclaim`);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[hh-archive][${jobId}] FAILED:`, message);
    await updateJob(db, jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: message.slice(0, 500),
      saved_total: savedTotal,
      errors_count: errorsCount + 1,
      ...CLEAR_OWNERSHIP,
    }, ctx);
  }
}
