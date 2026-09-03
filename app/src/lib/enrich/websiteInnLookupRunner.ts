import { findByInn, hasDadataKey } from '@/lib/enrich/dadataClient';
import { fetchInnFromWebsite } from '@/lib/enrich/websiteParser';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { applyWebsiteInnLookupResults } from '@/lib/spreadsheet/applyJobResults';
import type { WebsiteInnLookupResult } from './websiteInnLookupShared';

const SITE_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_SIZE = 5;
const APPLY_RESULTS_INTERVAL = 100;
/**
 * С какого возраста строка «в работе» считается брошенной.
 *
 * Сброса строк при старте воркера больше нет (см. worker/websiteInnLookup.ts):
 * он валил в pending в том числе строки, которые прямо сейчас обрабатывал живой
 * контейнер. Вместо него — точечный возврат в очередь, и вот его цена ошибки:
 * слишком маленький порог отбирает пачку у ещё дорабатывающего прежнего
 * владельца (пересечение владельцев при передаче аренды), то есть до пяти
 * лишних платных обходов сайтов и запросов в DaData.
 *
 * Две минуты — заведомо больше самой длинной законной обработки одной пачки:
 * fetchInnFromWebsite ограничен таймаутами (10 с главная страница + 10 с
 * www-вариант + 4 волны юридических страниц по 6 с ≈ 44 с на строку), а пачка
 * идёт параллельно. И заведомо меньше, чем ждать нечего: прерванный владелец
 * отпускает свои строки сам, сразу (releaseItems), а этот порог — страховка на
 * грубую остановку (OOM/SIGKILL), где отпустить их было некому.
 */
const ITEM_STALE_MS = 2 * 60_000;
/** Пауза, пока чужие строки «в работе» не дорастут до ITEM_STALE_MS. */
const ITEM_COOLDOWN_POLL_MS = 5_000;

export type WebsiteInnLookupJob = {
  id: string;
  user_id: string;
  status: string;
  tab_id: string;
  url_column: number;
  inn_column: number;
  company_column: number;
  total: number;
  processed: number;
  found: number;
};

export type WebsiteInnLookupPendingItem = {
  id: string;
  row_index: number;
  url: string;
};

export type WebsiteInnLookupProgress = {
  processed: number;
  found: number;
};

/**
 * Контекст единого жизненного цикла задач (app/src/lib/jobs/lifecycle.ts).
 *
 * Необязателен: ядро прогоняется и без аренды (тесты, ручной вызов), и там
 * поведение обязано остаться прежним — без ограждения жетоном и без сигнала.
 */
export interface WebsiteInnLookupRunContext {
  /** Взводится на SIGTERM воркера и при потере аренды. */
  signal: AbortSignal;
  /**
   * Жетон текущего захвата. Им ограждаются ВСЕ записи в строку
   * website_inn_lookup_jobs: терминальный статус здесь пишет само тело
   * (manageTerminalStatus: false), и без жетона старый исполнитель после
   * перехвата задачи проштамповал бы completed/failed поверх работы нового.
   */
  runToken: string;
  /** false — задачу перехватили: прекратить работу. */
  saveCheckpoint(data: { processed: number }): Promise<boolean>;
}

export interface WebsiteInnLookupRunnerDeps {
  loadJob(jobId: string): Promise<WebsiteInnLookupJob | null>;
  isCancellationRequested(jobId: string): Promise<boolean>;
  listPendingItems(jobId: string, limit: number): Promise<WebsiteInnLookupPendingItem[]>;
  lookupItems(
    items: WebsiteInnLookupPendingItem[],
    signal?: AbortSignal,
  ): Promise<WebsiteInnLookupResult[]>;
  persistOutcomes(
    job: WebsiteInnLookupJob,
    outcomes: WebsiteInnLookupResult[],
    current: WebsiteInnLookupProgress,
  ): Promise<WebsiteInnLookupProgress>;
  /**
   * Вернуть в очередь строки, брошенные прежним владельцем задачи (старше
   * ITEM_STALE_MS). Второе число — сколько строк ещё числится «в работе» после
   * этого: они либо моложе порога, либо их прямо сейчас дописывает прежний
   * владелец, и завершать задачу, пока они есть, нельзя — иначе строки молча
   * потеряются, а итог покажет меньше обработанного, чем в базе.
   */
  reclaimAbandonedItems(jobId: string): Promise<{ reclaimed: number; stillRunning: number }>;
  /** Отпустить взятые в работу строки, результат по которым не записан. */
  releaseItems(jobId: string, ids: string[]): Promise<void>;
  applyResults(job: WebsiteInnLookupJob): Promise<boolean>;
  completeJob(job: WebsiteInnLookupJob, progress: WebsiteInnLookupProgress): Promise<void>;
  cancelJob(job: WebsiteInnLookupJob, progress: WebsiteInnLookupProgress): Promise<void>;
  failJob(
    job: WebsiteInnLookupJob,
    message: string,
    progress: WebsiteInnLookupProgress,
  ): Promise<void>;
}

/** Прерываемая пауза: остановку воркера нельзя пережидать. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Возобновляемое ядро worker'а. Browser state здесь намеренно отсутствует:
 * источником истины служат pending items в БД, поэтому закрытие вкладки не
 * влияет на цикл, а рестарт worker'а продолжает только незавершённые строки.
 *
 * Прерывание (SIGTERM, потеря аренды) НЕ пишет терминальный статус: задача
 * остаётся в running, аренду отпускает библиотека, а сосед продолжает с той же
 * построчной очереди. Решение принимается по ctx.signal.aborted, а НЕ по имени
 * ошибки — настоящий таймаут обязан остаться отказом.
 */
export async function executeWebsiteInnLookupJob(
  jobId: string,
  deps: WebsiteInnLookupRunnerDeps,
  options?: { batchSize?: number; ctx?: WebsiteInnLookupRunContext },
): Promise<void> {
  const ctx = options?.ctx;
  const signal = ctx?.signal;
  const interrupted = () => signal?.aborted === true;

  const job = await deps.loadJob(jobId);
  if (!job || !['pending', 'running'].includes(job.status)) return;

  const requestedBatchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(50, Math.floor(requestedBatchSize)))
    : DEFAULT_BATCH_SIZE;
  let progress: WebsiteInnLookupProgress = {
    processed: Math.max(0, job.processed),
    found: Math.max(0, job.found),
  };
  let lastAppliedProcessed = progress.processed;
  /** Строки, взятые в работу, но ещё не доведённые до результата. */
  let inflight: string[] = [];

  /**
   * Уйти, не трогая статус задачи: строку доиграет следующий владелец.
   * Взятые в работу строки отпускаем сразу — иначе сосед ждал бы ITEM_STALE_MS
   * впустую. Ошибку освобождения гасим: страховка по возрасту всё равно есть.
   */
  const handOff = async () => {
    const ids = inflight;
    inflight = [];
    if (ids.length > 0) await deps.releaseItems(job.id, ids).catch(() => {});
  };

  try {
    while (true) {
      if (interrupted()) { await handOff(); return; }

      if (await deps.isCancellationRequested(job.id)) {
        await deps.cancelJob(job, progress);
        return;
      }

      const pending = await deps.listPendingItems(job.id, batchSize);
      if (pending.length === 0) {
        // Пустая очередь — ещё не конец задачи: строки могли остаться «в
        // работе» после грубой остановки прежнего владельца. Завершить задачу,
        // не разобравшись с ними, значит потерять их молча.
        const { reclaimed, stillRunning } = await deps.reclaimAbandonedItems(job.id);
        if (reclaimed > 0) continue;
        if (stillRunning > 0) {
          await sleep(ITEM_COOLDOWN_POLL_MS, signal);
          continue;
        }
        await deps.completeJob(job, progress);
        return;
      }
      inflight = pending.map((item) => item.id);

      const outcomes = await deps.lookupItems(pending, signal);
      if (outcomes.length !== pending.length) {
        throw new Error(`INN lookup returned ${outcomes.length}/${pending.length} outcomes`);
      }
      // Результаты уже оплачены обходом сайтов — записываем их даже если
      // прерывание пришло только что: запись ограждена жетоном, а строки после
      // неё терминальны и переигрываться не будут.
      progress = await deps.persistOutcomes(job, outcomes, progress);
      inflight = [];

      // Чекпойнт здесь минимальный и по сути технический: настоящее
      // возобновление считается из построчной очереди (новый владелец берёт
      // только items со статусом pending), а не из него. Нужен он ради двух
      // побочных эффектов библиотеки — продлевает аренду и обнуляет бюджет
      // неудач, — и ради самого дешёвого способа узнать о перехвате.
      if (ctx && !(await ctx.saveCheckpoint({ processed: progress.processed }))) {
        // Задачу перехватили: терминального статуса не пишем, строк в работе
        // за нами нет (пачка только что записана).
        return;
      }

      // Построчные checkpoints сохраняются после каждого небольшого batch, но
      // compressed spreadsheet state большой. Переписывать его каждые 5 строк
      // для базы на несколько тысяч сайтов слишком дорого, поэтому применяем
      // промежуточные результаты раз в 100 строк. Финальный apply в любом
      // случае повторяется внутри complete/cancel/fail.
      if (
        progress.processed >= job.total
        || progress.processed - lastAppliedProcessed >= APPLY_RESULTS_INTERVAL
      ) {
        await deps.applyResults(job);
        lastAppliedProcessed = progress.processed;
      }
    }
  } catch (error) {
    // Исключение НА ПРЕРЫВАНИИ — не отказ задачи: прерванный запрос бросает
    // AbortError, и без этой проверки остановка воркера штамповала бы failed на
    // живой задаче, которую сосед готов продолжить.
    if (interrupted()) {
      await handOff();
      return;
    }
    await handOff();
    await deps.failJob(job, error instanceof Error ? error.message : String(error), progress);
  }
}

async function lookupOne(
  item: WebsiteInnLookupPendingItem,
  signal?: AbortSignal,
): Promise<WebsiteInnLookupResult> {
  try {
    const inn = await fetchInnFromWebsite(item.url, { timeout: SITE_TIMEOUT_MS, signal });
    let companyName: string | null = null;
    let dadataError: string | null = null;
    if (inn && hasDadataKey()) {
      try {
        const suggestion = await findByInn(inn, { signal });
        companyName = suggestion?.data.name?.short_with_opf ?? suggestion?.value ?? null;
      } catch (error) {
        if (signal?.aborted) throw error;
        dadataError = `DaData: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      id: item.id,
      row_index: item.row_index,
      url: item.url,
      status: 'completed',
      inn,
      company_name: companyName,
      error_message: dadataError ?? (inn ? null : 'ИНН на сайте не найден'),
    };
  } catch (error) {
    // Прерывание — не результат строки. Пробрасываем, чтобы пачка не легла в
    // базу как «не найдено»: строку вернёт в очередь handOff, и её проверит
    // следующий владелец. Решаем по signal.aborted, а не по имени ошибки.
    if (signal?.aborted) throw error;
    return {
      id: item.id,
      row_index: item.row_index,
      url: item.url,
      status: 'failed',
      inn: null,
      company_name: null,
      error_message: error instanceof Error ? error.message : String(error),
    };
  }
}

function requireDb() {
  if (!supabaseAdmin) throw new Error('supabaseAdmin is not configured');
  return supabaseAdmin;
}

function createProductionDeps(ctx?: WebsiteInnLookupRunContext): WebsiteInnLookupRunnerDeps {
  const db = requireDb();
  const runToken = ctx?.runToken ?? null;

  /**
   * Все записи в строку задачи идут через один ограждённый жетоном путь.
   * Без ctx (ручной прогон) фильтр не добавляется — поведение прежнее.
   */
  // Тип билдера — any по той же причине, что в lib/jobs/lifecycle.ts: цепочка
  // PostgREST меняет форму на каждом шаге, а нам нужен от неё только .eq.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fenced = <T>(q: T): T => (runToken ? ((q as any).eq('run_token', runToken) as T) : q);
  const updateJob = (jobId: string, patch: Record<string, unknown>) =>
    fenced(db.from('website_inn_lookup_jobs').update(patch).eq('id', jobId));

  const apply = (job: WebsiteInnLookupJob) =>
    applyWebsiteInnLookupResults(
      job.user_id,
      job.id,
      job.tab_id,
      job.url_column,
      job.inn_column,
      job.company_column,
    );

  const finish = async (
    job: WebsiteInnLookupJob,
    status: 'completed' | 'cancelled' | 'failed',
    progress: WebsiteInnLookupProgress,
    errorMessage: string | null,
  ) => {
    const applied = await apply(job);
    const now = new Date().toISOString();
    // Терминальная запись обнуляет владение: библиотека при
    // manageTerminalStatus:false снимает осадок и сама, но только после возврата
    // run(), а дежурный запрос «кто держит аренду» не должен показывать
    // закрытую задачу даже в окне между двумя записями.
    await updateJob(job.id, {
      status,
      processed: progress.processed,
      found: progress.found,
      error_message: errorMessage,
      completed_at: now,
      updated_at: now,
      results_applied_at: applied ? now : null,
      lease_until: null,
      run_token: null,
      worker_id: null,
    }).in('status', ['pending', 'running']);
  };

  return {
    async loadJob(jobId) {
      const { data, error } = await db
        .from('website_inn_lookup_jobs')
        .select(
          'id, user_id, status, tab_id, url_column, inn_column, company_column, total, processed, found',
        )
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as WebsiteInnLookupJob | null) ?? null;
    },

    async isCancellationRequested(jobId) {
      const { data, error } = await db
        .from('website_inn_lookup_jobs')
        .select('cancel_requested, status')
        .eq('id', jobId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !data || data.cancel_requested === true || data.status === 'cancelled';
    },

    async listPendingItems(jobId, limit) {
      const { data: selected, error: selectError } = await db
        .from('website_inn_lookup_items')
        .select('id, row_index, url')
        .eq('job_id', jobId)
        .eq('status', 'pending')
        .order('row_index', { ascending: true })
        .limit(limit);
      if (selectError) throw new Error(selectError.message);
      if (!selected?.length) return [];

      const ids = selected.map((item) => item.id);
      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await db
        .from('website_inn_lookup_items')
        .update({ status: 'running', started_at: now, updated_at: now })
        .in('id', ids)
        .eq('job_id', jobId)
        .eq('status', 'pending')
        .select('id, row_index, url');
      if (claimError) throw new Error(claimError.message);
      return (claimed ?? []) as WebsiteInnLookupPendingItem[];
    },

    async lookupItems(items, signal) {
      return Promise.all(items.map((item) => lookupOne(item, signal)));
    },

    async reclaimAbandonedItems(jobId) {
      const now = new Date().toISOString();
      const staleBefore = new Date(Date.now() - ITEM_STALE_MS).toISOString();
      const { data: reclaimed, error } = await db
        .from('website_inn_lookup_items')
        .update({ status: 'pending', started_at: null, updated_at: now })
        .eq('job_id', jobId)
        .eq('status', 'running')
        // started_at пустым быть не должен (его ставит захват строки), но если
        // он всё же пуст, строка обязана считаться брошенной: иначе она
        // навсегда останется «в работе» и задача не завершится никогда.
        .or(`started_at.is.null,started_at.lt."${staleBefore}"`)
        .select('id');
      if (error) throw new Error(error.message);
      const { count, error: countError } = await db
        .from('website_inn_lookup_items')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .eq('status', 'running');
      if (countError) throw new Error(countError.message);
      return { reclaimed: reclaimed?.length ?? 0, stillRunning: count ?? 0 };
    },

    async releaseItems(jobId, ids) {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      const { error } = await db
        .from('website_inn_lookup_items')
        .update({ status: 'pending', started_at: null, updated_at: now })
        .in('id', ids)
        .eq('job_id', jobId)
        .eq('status', 'running');
      if (error) throw new Error(error.message);
    },

    async persistOutcomes(job, outcomes, current) {
      const now = new Date().toISOString();
      const rows = outcomes.map((outcome) => ({
        id: outcome.id,
        job_id: job.id,
        row_index: outcome.row_index,
        url: outcome.url,
        status: outcome.status,
        inn: outcome.inn,
        company_name: outcome.company_name,
        error_message: outcome.error_message,
        completed_at: now,
        updated_at: now,
      }));
      const { error: itemError } = await db
        .from('website_inn_lookup_items')
        .upsert(rows, { onConflict: 'id' });
      if (itemError) throw new Error(itemError.message);

      const next = {
        processed: current.processed + outcomes.length,
        found: current.found + outcomes.filter((outcome) => Boolean(outcome.inn)).length,
      };
      // updated_at штампует здесь САМО ТЕЛО, и это единственный источник
      // «задача жива» для монитора здоровья (services/health-check/main.py,
      // спецификация website_inn_lookup_jobs: updated_column="updated_at").
      // Ни захват, ни продление аренды эту колонку не трогают — см. комментарий
      // в worker/websiteInnLookup.ts.
      const { error: jobError } = await updateJob(job.id, { ...next, updated_at: now })
        .eq('status', 'running');
      if (jobError) throw new Error(jobError.message);
      return next;
    },

    applyResults: apply,

    async completeJob(job, progress) {
      await finish(job, 'completed', progress, null);
    },

    async cancelJob(job, progress) {
      await finish(job, 'cancelled', progress, null);
    },

    async failJob(job, message, progress) {
      await finish(job, 'failed', progress, message.slice(0, 1000));
    },
  };
}

export async function runWebsiteInnLookupJob(
  jobId: string,
  ctx?: WebsiteInnLookupRunContext,
): Promise<void> {
  await executeWebsiteInnLookupJob(jobId, createProductionDeps(ctx), {
    batchSize: Number(process.env.WEBSITE_INN_LOOKUP_CONCURRENCY ?? DEFAULT_BATCH_SIZE),
    ctx,
  });
}
