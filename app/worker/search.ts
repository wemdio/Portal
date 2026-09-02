/**
 * Search parser worker — парсер поисковой выдачи в отдельном контейнере.
 *
 * Владение задачей — единый жизненный цикл (lib/jobs/lifecycle.ts): захват
 * pending или строки с истёкшей/обнулённой арендой, продление аренды таймером,
 * на SIGTERM — обнуление аренды для быстрой передачи соседу.
 *
 * Сброса running→pending при старте больше НЕТ. Прежний startupRecovery валил в
 * pending любую running-строку, включая живую в соседнем контейнере, и делал
 * это ровно в тот момент, когда возобновление с места было бы дешевле всего.
 * Брошенную задачу теперь определяет истёкшая аренда, а не факт чужого старта.
 *
 * Продолжение с места у этого парсера БЫЛО и до миграции: runSearchParserJob
 * считает resumeFrom по колонке processed_queries и пишет её после каждого
 * запроса. Не хватало ровно одного — чтобы задача доживала до этого resume, а
 * не откатывалась в pending целиком. Чекпойнт {processed_queries} поверх той же
 * колонки нужен не как хранилище, а как способ обнулить бюджет неудач и узнать
 * о перехвате (см. комментарий в searchParserWorker.ts).
 *
 * Терминальный статус (completed/failed) пишет само тело — оно умеет отличать
 * «пусто из-за блокировки поисковика» от отказа и кладёт подсказку в
 * error_message. Поэтому manageTerminalStatus=false: библиотека держит аренду,
 * а в failed переводит только задачу, которую исполнитель терял три раза подряд
 * (crash/OOM), чтобы битая строка не крутилась вечно.
 */

import { runSearchParserJob } from '@/lib/parsers/searchParserWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Столько задач параллельно на реплике. Значение унаследовано от прежнего воркера. */
const MAX_CONCURRENCY = 5;
/**
 * Аренда — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок можно
 * держать коротким: 180 с ≈ три пропущенных продления. Время до перехвата после
 * краха/OOM/SIGKILL складывается из
 *     аренда (3 мин, она доживает свой срок сама)
 *   + один опрос соседа (5 с штатно; realtime будит только на status=pending,
 *     так что для брошенной running-строки считаем полный интервал опроса)
 *   ≈ 3 минуты — вшестеро ниже порога монитора «Долго висит»
 *   (HEALTH_JOB_STUCK_MIN, 20 мин, services/health-check/main.py).
 * Чистая остановка (деплой) аренду обнуляет сразу и порога не ждёт вовсе.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.SEARCH_LEASE_SECONDS ?? '180'));
const WORKER_ID = `search-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log(
    'info',
    `Starting Search worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`,
  );
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, { processed_queries: number }>({
    table: 'search_parser_jobs',
    workerId: WORKER_ID,
    // Статусы — из check-констрейнта таблицы (20260212_0001): pending, running,
    // completed, failed. Своих названий у этой очереди нет.
    statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    /**
     * progress НЕ включаем — сознательно, и вот арифметика.
     *
     * Порог простоя ограничен сверху монитором: сумма
     *     порог простоя + не больше одной аренды (3 мин) + один опрос (5 с)
     * обязана лечь заметно ниже HEALTH_JOB_STUCK_MIN (20 мин), то есть порог
     * простоя ≤ ~15 минут.
     *
     * А снизу его ограничивает самый длинный ЗАКОННЫЙ промежуток между
     * записями processed_queries — и он этот потолок пробивает с запасом.
     * Колонка двигается РОВНО РАЗ НА ЗАПРОС (finally в searchParserWorker.ts),
     * а один запрос при QUERY_CONCURRENCY=1 законно идёт десятками минут:
     *  - расширение источников: до 24 каталогов на запрос при параллельности 3,
     *    каждый — до 30 внутренних страниц с таймаутом 15 с, то есть до
     *    8 волн × 450 с ≈ 60 минут только на этот шаг;
     *  - обогащение почтами: бюджет 1000 сайтов НА ЗАДАЧУ при параллельности 2,
     *    и первый же запрос может выбрать его целиком — 500 волн по 3 страницы
     *    с таймаутом 8 с. Даже по 15 с на сайт это больше двух часов.
     * Порога, который влезает в 15 минут и не срабатывает на живом медленном
     * запросе, не существует: ложный перехват заставил бы соседа переигрывать
     * тот же запрос, пока прежнее тело его ещё скрейпит.
     *
     * Что защищает вместо progress:
     *  - мёртвый процесс аренду не продлевает — строку подберут через
     *    ≤ LEASE_SECONDS, и это главный сценарий;
     *  - зависшее ТЕЛО в живом процессе занимает один слот из пяти (ровно как
     *    и до миграции: прежний воркер держал такой промис в Set навсегда), а
     *    на ближайшем деплое shutdown() обнулит аренду строки независимо от
     *    того, осел ли промис, — и сосед продолжит её с processed_queries;
     *  - монитор здоровья по-прежнему смотрит на total_queries,
     *    processed_queries, total_results, progress_stage, progress_percent и
     *    позовёт человека через 20 минут без движения.
     *
     * Если понадобится настоящий детектор простоя, чинить надо не опцией, а
     * частотой отчётов: писать прогресс внутри обогащения, а не раз на запрос.
     */
    /**
     * Ждём тело 5 с и не больше. Бюджет: stop_grace_period 30 с, из них два
     * прохода освобождения аренды с паузой в секунду и контрольное чтение ≈ 3 с.
     * Больше ждать бессмысленно: тело смотрит на signal только на границе
     * запроса, а один запрос длится минуты — оно всё равно не доиграет и
     * продолжится с processed_queries в соседней реплике.
     */
    shutdownGraceMs: 5_000,
    /**
     * started_at на каждом захвате — в том числе на перехвате чужой аренды.
     * Монитор здоровья для search_parser_jobs его не читает (его отпечаток —
     * счётчики и progress_*), но UI показывает «в работе с …», и без этого
     * перехваченная строка уносила бы отметку прежнего владельца.
     */
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    // onCheckpointUnpersisted не подключаем: у поисковых задач нет своего
    // журнала, видимого пользователю (единственное поле — error_message, и
    // затирать им диагностику итога нельзя). Предупреждение библиотеки в stdout
    // контейнера — всё, что тут можно показать, и оно уже есть.
    log,
    run: async (job, ctx) => {
      log('info', `Running search parser job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      await runSearchParserJob(job.id, {
        signal: ctx.signal,
        // Жетон нужен телу, потому что терминальный статус пишет оно само:
        // при manageTerminalStatus=false библиотека эти записи оградить не
        // может, и без жетона старое тело после перехвата проштамповало бы
        // итог поверх работы нового владельца.
        runToken: ctx.runToken,
        saveCheckpoint: ctx.saveCheckpoint,
      });
    },
  });

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: shutdown() ставит
      // флаг и сам, но полагаться на то, что он успеет до первого await внутри
      // библиотеки, нельзя — флаг читают из другого модуля. Вызов
      // идемпотентный, флаг односторонний — лишним он быть не может.
      markShuttingDown();
      log('info', `${sig} received — releasing leases for fast handoff`);
      void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: () => runner.pollOnce(),
    realtimeTables: ['search_parser_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
