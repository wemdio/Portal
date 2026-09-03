/**
 * Website INN lookup worker — «Найти ИНН по сайту» в отдельном контейнере.
 *
 * Владение задачей — единый жизненный цикл (lib/jobs/lifecycle.ts): захват
 * pending или строки с истёкшей/обнулённой арендой, продление аренды таймером,
 * на SIGTERM — обнуление аренды для быстрой передачи соседу.
 *
 * Сброса при старте больше НЕТ — ни для задач, ни для построчной очереди.
 * Прежний startupRecovery валил в pending любую running-строку и любую строку
 * «в работе», включая те, что прямо сейчас обрабатывал живой соседний
 * контейнер: до пяти лишних платных обходов сайтов и запросов в DaData на
 * каждый рестарт. Брошенную задачу теперь определяет истёкшая аренда, а
 * брошенную СТРОКУ — её возраст (websiteInnLookupRunner.ts, ITEM_STALE_MS);
 * прерванный владелец к тому же отпускает свои строки сам, не дожидаясь порога.
 *
 * Возобновление у этой очереди построчное и было всегда: работа лежит в
 * website_inn_lookup_items, новый владелец берёт только строки pending, уже
 * проверенные сайты не переигрываются. Чекпойнт {processed} — не хранилище, а
 * способ продлить аренду, обнулить бюджет неудач и узнать о перехвате.
 *
 * Терминальный статус (completed/cancelled/failed) пишет само тело: оно умеет
 * отличить отмену пользователем (cancel_requested) от отказа и применяет
 * результаты в spreadsheet перед закрытием задачи. Поэтому
 * manageTerminalStatus=false — библиотека держит аренду, а в failed переводит
 * только задачу, которую исполнитель терял maxAttempts раз подряд (crash/OOM).
 *
 * ── ПОЧЕМУ updated_at НЕЛЬЗЯ ТРОГАТЬ ЗАХВАТУ И ПРОДЛЕНИЮ ────────────────────
 * Монитор здоровья для этой таблицы смотрит именно на updated_at
 * (services/health-check/main.py, JobMonitorSpec("website_inn_lookup_jobs", …,
 * updated_column="updated_at")): простой считается как now() - updated_at.
 * Триггера, который штамповал бы эту колонку, на таблице НЕТ — проверено по
 * миграциям (20260824_0001 создаёт таблицу без триггеров, ни одна другая
 * миграция триггера на неё не вешает). Колонку пишет САМО ТЕЛО задачи:
 * persistOutcomes после каждой пачки и finish на закрытии
 * (lib/enrich/websiteInnLookupRunner.ts).
 * Значит updated_at обязан остаться записью тела. Попади он в claimPatch или в
 * продление аренды — а продление это UPDATE строки раз в LEASE/3 = 60 с, —
 * монитор видел бы «прогресс» вечно, тревога «Долго висит» не сработала бы
 * никогда, и намертво вставшая задача выглядела бы здоровой. Ровно та же
 * ловушка, что у hh_archive_jobs и yandex_direct_jobs, только там её создаёт
 * триггер, а здесь создали бы мы сами.
 */

import { runWebsiteInnLookupJob } from '@/lib/enrich/websiteInnLookupRunner';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const PREPARING_STALE_MS = 10 * 60 * 1000;
const PREPARING_RECOVERY_INTERVAL_MS = 60 * 1000;
/** Столько задач параллельно на реплике. Значение унаследовано от прежнего воркера. */
const MAX_CONCURRENCY = 1;
/**
 * Аренда — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок можно
 * держать коротким: 180 с ≈ три пропущенных продления. Время до перехвата после
 * краха/OOM/SIGKILL складывается из
 *     аренда (3 мин, она доживает свой срок сама)
 *   + один опрос соседа (30 с: realtime будит только на status=pending, а
 *     простаивающий цикл ждёт Math.max(pollIntervalMs, 30_000) —
 *     effectiveFallback в app/worker/_shared.ts, не WORKER_POLL_INTERVAL_MS)
 *   ≈ 3,5 минуты — вшестеро ниже порога монитора «Долго висит»
 *   (HEALTH_JOB_STUCK_MIN, 20 мин, своего порога у этой таблицы нет).
 * Чистая остановка (деплой) аренду обнуляет сразу и порога не ждёт вовсе.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.WEBSITE_INN_LOOKUP_LEASE_SECONDS ?? '180'));
/**
 * Порог остановки прогресса — признак живости РАБОТЫ, отдельный от аренды.
 * Колонка processed, её пишет persistOutcomes после КАЖДОЙ пачки.
 *
 * Снизу порог ограничен самой длинной ЗАКОННОЙ тишиной между записями
 * processed. Это одна пачка плюс изредка применение результатов:
 *  - пачка из WEBSITE_INN_LOOKUP_CONCURRENCY (5) строк идёт параллельно, и
 *    каждая строка ограничена таймаутами fetchInnFromWebsite: 10 с главная
 *    страница + 10 с www-вариант + 4 волны юридических страниц по 6 с ≈ 44 с;
 *    запрос в DaData теперь тоже прерываемый (findByInn получает signal) и
 *    идёт единицы секунд — итого ≈ 1 минута на пачку;
 *  - раз в 100 строк добавляется applyResults: чтение и перезапись сжатого
 *    spreadsheet state с CAS-повторами — секунды, в худшем случае десятки
 *    секунд.
 * То есть законный максимум ≈ 2 минуты.
 *
 * Сверху — монитор. Вся цепочка починки обязана уложиться в его порог, а
 * считает он по updated_at, которую после перехвата НИКТО не двигает, пока
 * новый владелец не запишет первую пачку. Сумма:
 *     порог простоя (10 мин)
 *   + не больше одной аренды (3 мин: аренда после «простоя» не отпускается, она
 *     истекает сама)
 *   + один опрос соседа (30 с)
 *   + первая пачка нового владельца (≈ 1 мин)
 *   = 14,5 мин < 20 мин (HEALTH_JOB_STUCK_MIN).
 * Запас пятикратный снизу и пятиминутный сверху. Поднимать порог монитора для
 * этой таблицы (поле stuck_minutes появилось в этапе 3) не потребовалось.
 * Меняя любое слагаемое — пересчитай сумму.
 *
 * Ради чего это вообще: без детектора простоя здоровый процесс с зависшим телом
 * продлевал бы аренду вечно, и задачу не подобрал бы никто.
 */
const STALL_MS = Math.max(
  60_000,
  Number(process.env.WEBSITE_INN_LOOKUP_STALL_MINUTES ?? '10') * 60_000,
);
const WORKER_ID = `websiteinnlookup-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
let nextPreparingRecoveryAt = 0;

/**
 * Починка задач, застрявших в состоянии «готовится», — забота ИЗДАТЕЛЯ, а не
 * исполнителя, и потому она живёт рядом с опросом, а не внутри run().
 *
 * API публикует очередь в две фазы: preparing → insert all items → pending.
 * Если API-контейнер умер между фазами, worker не должен ни взять частичную
 * очередь, ни оставить пользователя заблокированным навсегда (на таблице висит
 * уникальный индекс «одна активная задача на пользователя»). Свежие preparing
 * не трогаем: их ещё может наполнять живой API request.
 *
 * С арендой эта починка не пересекается по построению:
 *  - раннер захватывает только pending и running (statuses ниже), а чинятся
 *    строки в preparing — то есть строку под живой арендой она не видит вовсе;
 *  - на всякий случай запись дополнительно требует lease_until is null: если
 *    строка в preparing когда-нибудь окажется чьей-то, починка отойдёт в
 *    сторону, а не отберёт её;
 *  - CAS по updated_at из снимка оставлен на месте: между чтением и записью
 *    API мог дописать очередь и сам перевести задачу в pending.
 */
async function recoverStalePreparingJobs(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const preparingCutoff = new Date(Date.now() - PREPARING_STALE_MS).toISOString();
  const { data: stalePreparing, error: preparingError } = await db
    .from('website_inn_lookup_jobs')
    .select('id, total, updated_at')
    .eq('status', 'preparing')
    .lt('updated_at', preparingCutoff);
  if (preparingError) {
    log('warn', 'Preparing job recovery scan failed', preparingError);
    return;
  }

  for (const job of stalePreparing ?? []) {
    const { count, error: countError } = await db
      .from('website_inn_lookup_items')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', job.id);
    if (countError) {
      log('warn', `Could not count items for preparing job ${job.id}`, countError);
      continue;
    }

    const persisted = count ?? 0;
    const complete = persisted === job.total;
    const recoveredAt = new Date().toISOString();
    const { data: recovered, error: recoveryError } = await db
      .from('website_inn_lookup_jobs')
      .update(complete
        ? { status: 'pending', updated_at: recoveredAt }
        : {
            status: 'failed',
            error_message: `Queue preparation interrupted: ${persisted}/${job.total}`,
            completed_at: recoveredAt,
            updated_at: recoveredAt,
          })
      .eq('id', job.id)
      .eq('status', 'preparing')
      .eq('updated_at', job.updated_at)
      .is('lease_until', null)
      .select('id');
    if (recoveryError) {
      log('warn', `Preparing job ${job.id} recovery failed`, recoveryError);
    } else if (recovered?.length) {
      log(
        complete ? 'info' : 'warn',
        complete
          ? `Published complete preparing job ${job.id}`
          : `Failed incomplete preparing job ${job.id} (${persisted}/${job.total})`,
      );
    }
  }
}

/** Не чаще раза в минуту, и её сбой не должен ронять опрос очереди. */
async function maybeRecoverPreparingJobs(): Promise<void> {
  if (Date.now() < nextPreparingRecoveryAt) return;
  nextPreparingRecoveryAt = Date.now() + PREPARING_RECOVERY_INTERVAL_MS;
  try {
    await recoverStalePreparingJobs();
  } catch (err) {
    log('warn', 'Preparing job recovery failed', err);
  }
}

async function main(): Promise<void> {
  log(
    'info',
    `Starting Website INN Lookup worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`,
  );
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, { processed: number }>({
    table: 'website_inn_lookup_jobs',
    workerId: WORKER_ID,
    // Статусы — из check-констрейнта таблицы (20260824_0001): preparing,
    // pending, running, completed, failed, cancelled. Библиотеке достаются
    // только четыре: preparing — состояние издателя (см. выше), cancelled
    // пишет тело.
    statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    /**
     * maxAttempts оставлен библиотечным (3) осознанно. Бюджет обнуляет и
     * чекпойнт, и замеченное движение processed, а здесь оба случаются после
     * КАЖДОЙ пачки — то есть примерно раз в минуту. Дожить до трёх потерь
     * подряд может только задача, которая падает, не сделав ни одной пачки:
     * ровно та, которую и надо остановить. Поднимать предел, как у валидации
     * почт, тут не за что — там его подняли из-за многочасовых окон без
     * чекпойнта, которых у этой очереди нет.
     */
    maxAttempts: 3,
    progress: { column: 'processed', stalledAfterMs: STALL_MS },
    /**
     * Ждём тело 5 с и не больше. Бюджет: stop_grace_period 30 с (а деплой и
     * вовсе даёт docker stop --timeout 15), из них два прохода освобождения
     * аренды с паузой в секунду и контрольное чтение ≈ 3 с. Больше ждать
     * бессмысленно: тело смотрит на signal на границе строки, а один обход
     * сайта идёт до 44 с — оно всё равно не доиграет пачку, зато успеет
     * вернуть её строки в очередь, и их проверит сосед.
     */
    shutdownGraceMs: 5_000,
    /**
     * started_at на каждом захвате — в том числе на перехвате чужой аренды.
     * updated_at сюда НЕ ДОБАВЛЯТЬ: см. шапку файла, это единственный признак
     * жизни для монитора и его пишет только тело. started_at безопасен —
     * монитор берёт его лишь как запасную точку отсчёта, а updated_at у этой
     * таблицы not null и всегда перебивает её (coalesce в _fetch_active_job_rows).
     */
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      log('info', `Running website INN lookup job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      await runWebsiteInnLookupJob(job.id, {
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

  await maybeRecoverPreparingJobs();
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: async () => {
      // Починка издателя идёт РЯДОМ с опросом, а не внутри захвата: у неё нет
      // аренды и быть не должно, а её сбой не имеет права мешать разбору
      // очереди (см. maybeRecoverPreparingJobs).
      await maybeRecoverPreparingJobs();
      return runner.pollOnce();
    },
    realtimeTables: ['website_inn_lookup_jobs'],
  });
  await runner.shutdown();
}

main().catch((error) => {
  log('error', 'Worker crashed', error);
  process.exit(1);
});
