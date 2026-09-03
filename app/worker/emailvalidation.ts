/**
 * Email validation worker — валидация почт в отдельном контейнере.
 *
 * Владение задачей — единый жизненный цикл (lib/jobs/lifecycle.ts): захват
 * pending или строки с истёкшей/обнулённой арендой, продление аренды таймером,
 * на SIGTERM — обнуление аренды для быстрой передачи соседу.
 *
 * Сброса running→pending при старте больше НЕТ. Прежний startupRecovery валил в
 * pending любую running-строку, включая живую в соседнем контейнере, и делал
 * это ровно тогда, когда продолжение с места было бы дешевле всего. Брошенную
 * задачу теперь определяет истёкшая аренда, а не факт чужого старта.
 *
 * Возобновление у этой очереди построчное и было всегда: работа лежит в
 * email_validation_queue, новый владелец берёт только строки в статусе pending
 * (claim_email_validation_items), уже проверенные адреса не переигрываются и
 * повторно не оплачиваются. Чекпойнт {processed} поверх той же колонки — не
 * хранилище, а способ продлить аренду, обнулить бюджет неудач и узнать о
 * перехвате.
 *
 * Терминальный статус (completed/failed/cancelled) пишет само тело: оно умеет
 * отличить отмену пользователем от отказа и пересчитывает итоговые счётчики по
 * очереди. Поэтому manageTerminalStatus=false — библиотека держит аренду, а в
 * failed переводит только задачу, которую исполнитель терял maxAttempts раз
 * подряд (crash/OOM), чтобы битая строка не крутилась вечно.
 */

import { runEmailValidationJob } from '@/lib/emailValidation/emailValidationWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Столько задач параллельно на реплике. Значение унаследовано от прежнего воркера. */
const MAX_CONCURRENCY = 3;
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
 *   (HEALTH_JOB_STUCK_MIN, 20 мин, services/health-check/main.py).
 * Чистая остановка (деплой) аренду обнуляет сразу и порога не ждёт вовсе.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.EMAIL_VALIDATION_LEASE_SECONDS ?? '180'));
const WORKER_ID = `emailvalidation-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log(
    'info',
    `Starting Email Validation worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`,
  );
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, { processed: number }>({
    table: 'email_validation_jobs',
    workerId: WORKER_ID,
    // Статусы — из check-констрейнта таблицы (20260221_0001):
    // pending, running, completed, failed, cancelled. Отмена пользователем —
    // отдельный статус, библиотеке о нём знать не нужно: его пишет тело.
    statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    /**
     * maxAttempts ПОДНЯТ с трёх до пяти — сознательно, и вот почему.
     *
     * Бюджет неудач обнуляет только чекпойнт (прогресс не подключён, см. ниже),
     * а чекпойнт здесь пишется после реально сделанной пачки. Между двумя
     * пачками у этой очереди законно проходит очень много времени:
     *  - хвост отложенных ретраев (серые списки) держится до TAIL_CAP_MS —
     *    25 минут по умолчанию, и всё это время ни одна строка не проверяется;
     *  - одна пачка из 100 адресов ОДНОГО домена идёт по три штуки
     *    (EMAIL_VALIDATION_DOMAIN_CONCURRENCY) — 34 волны, а в каждой до трёх
     *    MX × весь пул прокси по 25 с. Десятки минут на пачку — законно.
     * То есть окно «задача жива и здорова, но чекпойнта ещё не было» тут
     * измеряется десятками минут, и три грубые остановки контейнера (OOM
     * соседней задачи на той же реплике — их три одновременно) сожгли бы бюджет
     * исправной задаче. Пять оставляет предел на месте для по-настоящему
     * ядовитой задачи и не роняет здоровую.
     *
     * Повтор дёшев: проверенные строки лежат в email_validation_queue со
     * статусом completed и заново не оплачиваются.
     */
    maxAttempts: 5,
    /**
     * progress НЕ включаем — сознательно, и вот арифметика.
     *
     * Сверху порог простоя ограничен монитором: сумма
     *     порог простоя + не больше одной аренды (3 мин) + один опрос (30 с)
     * обязана лечь заметно ниже порога «Долго висит» для этой таблицы
     * (services/health-check/main.py, спецификация email_validation_jobs; своего
     * порога у неё нет, значит общий HEALTH_JOB_STUCK_MIN = 20 мин). Отсюда
     * порог простоя ≤ ~16 минут.
     *
     * Снизу его ограничивает самая длинная ЗАКОННАЯ тишина в единственной
     * скалярной колонке-кандидате (processed), и она этот потолок пробивает:
     *  - серые списки. Отложенный ретрай ставится на 5 → 15 → 30 минут
     *    (GREYLIST_SCHEDULE_MIN) или на подсказку «try again in N» до 20 минут
     *    × джиттер 1,1. Пока хвост состоит только из отложенных строк, processed
     *    не двигается вовсе — до TAIL_CAP_MS, по умолчанию 25 минут
     *    (EMAIL_VALIDATION_TAIL_CAP_MIN, то есть значение ещё и настраивается
     *    снаружи);
     *  - одна пачка. processed пишется раз на ПАЧКУ (flushProgress после
     *    mapWithConcurrency), а пачка из 100 адресов одного домена идёт по три
     *    штуки: 34 волны × до трёх MX × пул прокси по 25 с — тоже десятки минут.
     * Порога, который влезает в 16 минут и не срабатывает на исправной задаче,
     * не существует: ложный перехват отобрал бы строку у живого исполнителя и,
     * что хуже, потратил бы попытку — то есть чинил бы здоровую задачу в failed.
     *
     * Поднять порог монитора для этой таблицы (поле stuck_minutes появилось в
     * этапе 3) тоже не выход: чтобы порог простоя пережил 25-минутный хвост,
     * монитору нужно было бы больше 29 минут, и человек узнавал бы о реально
     * вставшей валидации в полтора раза позже — ради страховки, которую очередь
     * и так имеет. Тем более что у монитора для ЭТОЙ таблицы уже есть точное
     * исключение: пока в email_validation_queue есть строки pending с
     * retry_after в будущем, тревога «Долго висит» подавляется, а таймер
     * простоя перезаводится (check_stuck_jobs, deferred_emailval_jobs). Оно
     * работает по очереди строк и продлением аренды не задевается.
     *
     * Что защищает вместо progress:
     *  - мёртвый процесс аренду не продлевает — строку подберут через
     *    ≤ LEASE_SECONDS, и это главный сценарий;
     *  - зависшее ТЕЛО в живом процессе занимает один слот из трёх (ровно как и
     *    до миграции: прежний воркер держал такой промис в Set навсегда), а на
     *    ближайшем деплое shutdown() обнулит аренду строки, и сосед продолжит
     *    её с построчной очереди;
     *  - сам хвост джоба ограничен TAIL_CAP_MS: задача не может ждать серые
     *    списки вечно, она финализирует их сохранёнными вердиктами;
     *  - монитор здоровья по-прежнему смотрит на total/processed/success_count/
     *    error_count и позовёт человека, когда отпечаток встанет дольше порога.
     */
    /**
     * Ждём тело 5 с и не больше. Бюджет: stop_grace_period 30 с, из них два
     * прохода освобождения аренды с паузой в секунду и контрольное чтение ≈ 3 с.
     * Больше ждать бессмысленно: тело смотрит на signal на границе строки
     * очереди, а одна SMTP-проба идёт до 25 с — оно всё равно не доиграет
     * пачку, и продолжит её сосед с тех же строк.
     */
    shutdownGraceMs: 5_000,
    /**
     * started_at на каждом захвате — в том числе на перехвате чужой аренды.
     *
     * Проверено, что от этой отметки НИЧЕГО не отсчитывается (ловушка, на
     * которой уже обжигались): монитор здоровья для email_validation_jobs берёт
     * простой из отпечатка прогресса, а не из started_at — у спецификации нет
     * ни updated_column, ни queue_heartbeat_column, и active_secs по этой
     * колонке считается, но не используется; API валидации почт
     * (app/src/app/api/email-validation/**) started_at не выбирает вовсе;
     * TAIL_CAP отсчитывается от таймера в памяти тела. Без claimPatch
     * перехваченная строка уносила бы отметку прежнего владельца, а захваченная
     * из pending осталась бы с пустым started_at.
     */
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      log('info', `Running email validation job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      await runEmailValidationJob(job.id, {
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
    realtimeTables: ['email_validation_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
