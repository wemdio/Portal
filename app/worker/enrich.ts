/**
 * Воркер обогащения — три очереди в одном контейнере: обогащение сайтов
 * (`website_enrichment_jobs`), оценка ЦА (`brief_scoring_jobs`) и крипто-приходы
 * (`crypto_payment_jobs`). Реплик девять (docker-compose.prod.yml).
 *
 * 03.09.2026: на единый жизненный цикл задач (lib/jobs/lifecycle.ts) переведены
 * ТОЛЬКО крипто-приходы. Две другие очереди работают ровно как раньше — свой
 * захват, свой сброс при старте, свой сторож — и переезжают отдельной задачей
 * (этап 4, задача 8): там перевод меняет модель параллелизма (девять реплик
 * намеренно разбирают ОДНУ задачу построчно), и делать его надо отдельно.
 */

import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';
import { runBriefScoringJob } from '@/lib/briefScoring/briefScoringWorker';
import {
  runCryptoPaymentJob,
  type CryptoPaymentCheckpoint,
} from '@/lib/parsers/cryptoPaymentsWorker';
import { recoverStalePreparingWebsiteEnrichmentJobs } from '@/lib/enrich/websiteEnrichmentJobPublisher';
import { createJobRunner, type JobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
// MAX_CONCURRENCY — сколько job'ов одна реплика worker'а берёт параллельно.
// Был 5 hardcoded. Поднимаю до 8: на 50к-базах юзеры жаловались что job'ы
// от разных людей встают в очередь. Память: ~150-300MB на активный job
// (in-flight Map + cheerio HTML buffers), 8 × ~250MB = ~2GB max — попадает
// в обновлённый docker-compose limit. Env override доступен на случай
// если на конкретной реплике мало памяти.
const MAX_CONCURRENCY = Number(process.env.ENRICH_MAX_CONCURRENCY ?? '8');
const STALE_JOB_MINUTES = Number(process.env.ENRICH_STALE_JOB_MINUTES ?? '10');
const PREPARING_STALE_MINUTES = Number(process.env.ENRICH_PREPARING_STALE_MINUTES ?? '15');
const WATCHDOG_INTERVAL_MS = 60_000;
/**
 * Крипто-приходы: аренда — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые аренда/3 = 60 с. Время до перехвата
 * после краха/OOM/SIGKILL = аренда (3 мин) + один опрос соседа (30 с) ≈ 3,5 мин.
 * Тот же срок отвечает и за остановку пользователем: кнопка «Стоп» пишет
 * status='stopped', продление аренды такую строку уже не проходит (фильтр
 * status=running), библиотека взводит сигнал — то есть тело узнаёт об остановке
 * не позже одного тика продления, за минуту. До перевода оно опрашивало строку
 * раз в пачку, а пачка из десяти сайтов идёт до минуты (SITE_TIMEOUT_MS) —
 * счётчик у пользователя останавливается за то же время, что и раньше.
 */
const CRYPTO_LEASE_SECONDS = Math.max(60, Number(process.env.CRYPTO_PAYMENTS_LEASE_SECONDS ?? '180'));
/**
 * Порог простоя по колонке checked_count — признак живости РАБОТЫ.
 *
 * Самый длинный ЗАКОННЫЙ промежуток между её записями — одна пачка: PERSIST_INTERVAL
 * равен BATCH_SIZE (10), то есть счётчик пишется после КАЖДОЙ пачки, а пачка из
 * десяти сайтов обходится параллельно и сверху ограничена SITE_TIMEOUT_MS = 60 с
 * (внутри — до семи страниц по 8 с). Итого законный максимум ≈ 1 минута.
 * Берём 5 минут — впятеро больше — и проверяем сумму цепочки починки:
 * 5 мин (простой) + не больше одной аренды (3 мин) + не больше одного опроса
 * (30 с) = 8,5 мин < 20 мин (HEALTH_JOB_STUCK_MIN, своего порога у этой таблицы
 * нет). Меняя слагаемое, сверяй сумму.
 *
 * Нижняя граница — 3 минуты, а не минута: минута РАВНА посчитанному законному
 * максимуму, и оператор, выкрутивший ручку в минимум, получал бы ложный простой
 * на каждой медленной пачке — с отобранной у живого исполнителя задачей и
 * потраченной попыткой. Пол обязан лежать выше законного молчания, а не на нём.
 *
 * НЕ updated_at, хотя монитор смотрит именно на него: продление аренды — это
 * UPDATE строки, и колонка, которую двигает продление, не может быть признаком
 * ни прогресса, ни жизни. Здесь это безопасно ровно потому, что updated_at
 * штампует само тело (триггера на таблице нет — миграция 20260402_0001), а ни
 * claimPatch, ни продление её не касаются.
 */
const CRYPTO_STALL_MS = Math.max(180_000, Number(process.env.CRYPTO_PAYMENTS_STALL_MINUTES ?? '5') * 60_000);
const WORKER_ID = `enrich-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();
const jobProgress = new Map<string, { processed: number; checkedAt: number }>();

async function recoverStalePreparingJobs(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const cutoff = new Date(Date.now() - PREPARING_STALE_MINUTES * 60_000).toISOString();
  try {
    const result = await recoverStalePreparingWebsiteEnrichmentJobs(db, cutoff);
    if (result.published || result.failed) {
      log(
        'warn',
        `Recovered stale preparing website jobs: published=${result.published}, failed=${result.failed}`,
      );
    }
  } catch (error) {
    log('warn', 'Stale preparing website job recovery failed', error);
  }
}

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  // Website enrichment — сбрасываем в 'pending' (воркер сам продолжит с места остановки)
  const { data: jobs, error } = await db
    .from('website_enrichment_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (error) log('warn', 'Startup recovery: website_enrichment_jobs update failed', error);
  else if (jobs?.length) log('info', `Startup recovery: reset ${jobs.length} website_enrichment_jobs to pending`);
  await recoverStalePreparingJobs();

  const { data: briefJobs, error: briefError } = await db
    .from('brief_scoring_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .select('id');
  if (briefError) log('warn', 'Startup recovery: brief_scoring_jobs update failed', briefError);
  else if (briefJobs?.length) log('info', `Startup recovery: reset ${briefJobs.length} brief_scoring_jobs to pending`);

  // Сброса crypto_payment_jobs здесь больше НЕТ: очередь на едином жизненном
  // цикле, и брошенную задачу определяет истёкшая (или обнулённая при штатной
  // остановке) аренда, а не факт чужого старта. Прежний сброс валил в pending
  // любую running-строку — в том числе ту, которую прямо сейчас выполняла живая
  // соседняя реплика из девяти, и делал это на каждом старте контейнера.
  // Две очереди выше остаются со сбросом: они переводятся в задаче 8 этапа 4.
}

// Track which jobs this replica is already running so we don't re-attach to
// the same job twice from the same process (would waste a concurrency slot).
const attachedJobs = new Set<string>();

async function claimEnrichJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);

  // Step 1: claim a brand-new pending job (atomic CAS pending→running).
  const { data: pending } = await db
    .from('website_enrichment_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (pending) {
    const { data: claimed } = await db
      .from('website_enrichment_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', pending.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimed?.id) {
      attachedJobs.add(claimed.id);
      return claimed.id;
    }
  }

  // Step 2: no pending job to claim — but a job may already be RUNNING with
  // pending items. Co-attach so this replica processes some of them in
  // parallel with the original claimer. Pre-fix: only the first replica that
  // hit the CAS in step 1 ever entered runWebsiteEnrichmentJob, the other
  // two replicas idled while a single core chewed through 75k items alone.
  // Items are claimed via `claim_website_enrichment_items` RPC which uses
  // FOR UPDATE SKIP LOCKED — so concurrent workers naturally split the work.
  const { data: runningJobs } = await db
    .from('website_enrichment_jobs')
    .select('id, total, processed')
    .eq('status', 'running')
    .order('created_at', { ascending: true })
    .limit(20);

  if (!runningJobs?.length) return null;

  for (const job of runningJobs) {
    if (attachedJobs.has(job.id)) continue;
    // Only co-attach when there's actual work left — (total - processed)
    // is a cheap upper bound on remaining items without a COUNT query.
    const remaining = (job.total ?? 0) - (job.processed ?? 0);
    if (remaining <= 0) continue;
    attachedJobs.add(job.id);
    log('info', `Co-attaching to running job ${job.id} (${remaining} items remaining)`);
    return job.id;
  }

  return null;
}

async function claimBriefScoringJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('brief_scoring_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('brief_scoring_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  return claimed?.id ?? null;
}

/**
 * Крипто-приходы — отдельный раннер единого жизненного цикла.
 *
 * concurrency: 1. До перевода эта очередь делила счётчик `running` с
 * обогащением (до восьми задач на реплику) и захватывалась обычным CAS, за
 * который бились все девять реплик. Одна задача на реплику здесь достаточна и
 * правильна: у пользователя одновременно активна одна задача (маршруты создания
 * и resume глушат остальные), девять реплик всё равно дают девять параллельных
 * задач на кластер, а каждая пачка — это десять сайтов по семь страниц в
 * полёте, и множить их в процессе, где рядом крутится обогащение, незачем.
 *
 * ПАМЯТЬ. Раннер живёт вне счётчика `running`, то есть скан приходов больше не
 * занимает слот обогащения, а ДОБАВЛЯЕТСЯ к восьми. Считаем добавку:
 *  - строка задачи целиком (select *). Замер по проду на 03.09.2026: всего
 *    шесть задач за всю историю, самая большая — 3131 позиция, 230 КБ JSON
 *    (max(length(items::text))), средняя — 1418 позиций. В объектах V8 это
 *    единицы мегабайт, не десятки;
 *  - matches — подмножество проверенного, максимум за историю 11 КБ;
 *  - буферы обхода: до десяти страниц в полёте по MAX_HTML_BYTES (1,2 МБ) плюс
 *    их же копия в нижнем регистре и список атрибутов — до ~30 МБ, и это
 *    короткоживущий пик внутри одной пачки.
 * Итого добавка ≈ 35 МБ, и даже файл в десять раз крупнее всего, что когда-либо
 * загружали, добавил бы к этому единицы мегабайт: доминирует не размер файла, а
 * десять HTML-буферов. Против замеренного пика КОНТЕЙНЕРА в 900–1100 МБ при
 * лимите 2048 МБ (docker-compose.prod.yml, там же арифметика) запас — около
 * 950 МБ, то есть добавка укладывается в него с многократным зазором. Оценка
 * «8 × 250 МБ = 2 ГБ» ниже по файлу — это ВЕРХНЯЯ граница на задачу, взятая при
 * подъёме concurrency с 5 до 8, а не одновременно достигаемая величина; замер
 * даёт ~110–140 МБ на активную задачу. Поэтому лимит памяти не поднимаем.
 */
const createCryptoRunner = (): JobRunner => createJobRunner<{ id: string; checked_count: number }, CryptoPaymentCheckpoint>({
  table: 'crypto_payment_jobs',
  workerId: WORKER_ID,
  // Статусы — из check-констрейнта таблицы (миграция 20260402_0001):
  // pending, running, completed, stopped, error. Отказ здесь называется
  // 'error', а не 'failed'; 'stopped' — остановка пользователем, библиотеке о
  // ней знать не нужно: её пишет маршрут, а тело узнаёт о ней через сигнал.
  statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'error' },
  leaseSeconds: CRYPTO_LEASE_SECONDS,
  concurrency: 1,
  // Терминальный статус (completed/error) пишет само тело: оно же дописывает
  // итоговые matches и текст ошибки, который видит человек.
  manageTerminalStatus: false,
  /**
   * maxAttempts: 3 — по умолчанию, и осознанно. Бюджет обнуляет и чекпойнт
   * (пишется после каждой пачки, то есть примерно раз в минуту), и движение
   * checked_count, так что живая задача до предела не дойдёт. Три подряд
   * потерянные аренды без единой пройденной пачки — это задача, которая роняет
   * контейнер на первом же шаге, и крутить её вечно незачем: повтор стоит
   * десяти обходов чужих сайтов.
   */
  maxAttempts: 3,
  progress: { column: 'checked_count', stalledAfterMs: CRYPTO_STALL_MS },
  // checked_count в выборке — чтобы точка отсчёта простоя бралась с момента
  // захвата, а не с первого тика продления.
  select: 'checked_count',
  /**
   * claimPatch НЕТ, и это главное решение этой очереди.
   *
   * Отсчитывать здесь нечего (колонки started_at у таблицы нет вовсе), а
   * единственный кандидат — updated_at — как раз то, на что смотрит монитор
   * (services/health-check/main.py: updated_column='updated_at',
   * started_column=None). claimPatch выполняется при ЛЮБОМ захвате, включая
   * перехват истёкшей аренды. Зависшая задача перехватывается примерно каждые
   * 3,5 минуты — то есть updated_at обновлялся бы бесконечно, и тревога «Долго
   * висит» (20 мин) не наступила бы никогда. Отметку ставит само тело: один раз
   * на старте и после каждой пачки.
   */
  failedPatch: (reason) => ({ error_message: reason, updated_at: new Date().toISOString() }),
  /**
   * Весь бюджет остановки — 5 секунд, телу из них достаётся остаток (см.
   * lib/jobs/lifecycle.ts: из бюджета сперва тратятся два прохода освобождения
   * аренды с паузой и контрольное чтение). Больше не нужно: сигнал рвёт
   * запросы к сайтам, и тело выходит на границе пачки почти сразу.
   */
  shutdownGraceMs: 5_000,
  log,
  run: async (job, ctx) => {
    log('info', `Running crypto payment job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
    await runCryptoPaymentJob(job.id, {
      signal: ctx.signal,
      runToken: ctx.runToken,
      saveCheckpoint: ctx.saveCheckpoint,
    });
  },
});

/**
 * Две непереведённые очереди воркера — обогащение сайтов и оценка ЦА. Логика
 * ровно та, что была: общий счётчик `running` на MAX_CONCURRENCY, собственный
 * захват у каждой и тот же порядок (обогащение вперёд оценки ЦА). Вынесено в
 * отдельную функцию только затем, чтобы её ранний выход «слоты заняты» не
 * уносил с собой опрос крипто-приходов.
 *
 * Что изменилось не в логике, а в ЧАСТОТЕ: пока идёт скан приходов, раннер на
 * каждом опросе отвечает «слоты заняты» = true, цикл не уходит спать свои 30
 * секунд, и эти две очереди опрашиваются примерно раз в полсекунды — то есть
 * раз в шестьдесят чаще обычного, всё время скана. Безвредно: лишний опрос
 * может найти только ту работу, которую всё равно взял бы следующим тиком, а
 * запросы захвата у обеих очередей индексные и однострочные. Само по себе это
 * не повод возвращать короткое замыкание — оно стоило бы голодания очереди.
 */
async function pollEnrichmentQueues(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true;
  }
  const jobId = await claimEnrichJob();
  if (jobId) {
    const task = (async () => {
      log('info', `Running website enrichment job ${jobId}`);
      try {
        await runWebsiteEnrichmentJob(jobId);
      } finally {
        // Allow this replica to re-attach to the same job later if it
        // resurfaces (the worker may finish its slice early while other
        // replicas still have items in flight).
        attachedJobs.delete(jobId);
      }
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return true;
  }

  const briefJobId = await claimBriefScoringJob();
  if (briefJobId) {
    const task = (async () => {
      log('info', `Running brief scoring job ${briefJobId}`);
      await runBriefScoringJob(briefJobId);
    })();
    running.add(task);
    void task.finally(() => running.delete(task));
    return true;
  }

  return false;
}

async function pollOnce(cryptoRunner: JobRunner): Promise<boolean> {
  // Опрашиваем ОБА пути и только потом складываем ответы. Короткое замыкание
  // (`a || b`) здесь — голодание: и ранний выход «слоты заняты» выше, и
  // pollOnce раннера отвечают true не только когда задачу взяли, но и когда
  // брать некуда (lifecycle.ts спит 500 мс и возвращает true, чтобы цикл не
  // ушёл ждать 30 секунд). Обогащение занимает все восемь слотов надолго —
  // часами на большой базе, — и до крипто-приходов опрос не доходил бы вовсе.
  // Эта ошибка уже была допущена на этапе 2, повторять её нельзя.
  const polled: boolean[] = [];
  polled.push(await pollEnrichmentQueues());
  polled.push(await cryptoRunner.pollOnce());
  return polled.some(Boolean);
}

async function watchdog(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  try {
    await recoverStalePreparingJobs();
    const { data: runningJobs } = await db
      .from('website_enrichment_jobs')
      .select('id, processed')
      .eq('status', 'running');

    if (!runningJobs?.length) {
      jobProgress.clear();
      return;
    }

    const staleMs = STALE_JOB_MINUTES * 60_000;
    const now = Date.now();

    for (const job of runningJobs) {
      const prev = jobProgress.get(job.id);
      if (prev && job.processed === prev.processed && now - prev.checkedAt > staleMs) {
        log('warn', `Watchdog: job ${job.id} stuck at ${job.processed} for ${STALE_JOB_MINUTES}+ min, resetting to pending`);
        await db
          .from('website_enrichment_jobs')
          .update({ status: 'pending' })
          .eq('id', job.id)
          .eq('status', 'running');
        jobProgress.delete(job.id);
      } else if (!prev || job.processed !== prev.processed) {
        jobProgress.set(job.id, { processed: job.processed, checkedAt: now });
      }
    }

    for (const id of jobProgress.keys()) {
      if (!runningJobs.some((j) => j.id === id)) jobProgress.delete(id);
    }
  } catch (err) {
    log('warn', 'Watchdog tick failed', err);
  }
}

async function main(): Promise<void> {
  log('info', `Starting Enrichment worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  const watchdogTimer = setInterval(() => { void watchdog(); }, WATCHDOG_INTERVAL_MS);
  // Раннер заводим ПОСЛЕ requireSupabaseAdmin: без ключа createJobRunner
  // бросает, а человеку полезнее внятная строка из requireSupabaseAdmin.
  const cryptoRunner = createCryptoRunner();

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: shutdown() ставит
      // флаг и сам, но полагаться на то, что он успеет до первого await внутри
      // библиотеки, нельзя — флаг читают из другого модуля. На две
      // непереведённые очереди он не влияет: этот флаг сегодня читают только
      // сама библиотека и конструктор баз (другой воркер).
      markShuttingDown();
      log('info', `${sig} received — releasing crypto payment leases for fast handoff`);
      void cryptoRunner.shutdown().catch((err) => log('error', 'crypto shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => pollOnce(cryptoRunner),
    realtimeTables: ['website_enrichment_jobs', 'brief_scoring_jobs', 'crypto_payment_jobs'],
  });

  await cryptoRunner.shutdown();
  clearInterval(watchdogTimer);
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

