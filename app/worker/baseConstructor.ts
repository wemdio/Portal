/**
 * BaseConstructor worker — выносит «Конструктор баз» из HTTP-процесса portal'a
 * в отдельный долгоживущий контейнер.
 *
 * Зачем: до миграции `runBaseConstructorJob` запускался как fire-and-forget
 * Promise прямо из POST-роута Next.js. Любой рестарт portal'a (deploy,
 * OOM, healthcheck) убивал promise посередине — задача оставалась в
 * `processing` навсегда (или, после симптом-фикса auto-resume в GET,
 * восстанавливалась только когда юзер открывал карточку через 15+ мин).
 *
 * Архитектура (по образу `enrich.ts`):
 *   - polling-loop ищет `status='pending'` (новые) → атомарный claim
 *     через CAS-UPDATE → запуск runBaseConstructorJob.
 *   - также ищет `status='processing'` со старым `started_at` (умерли при
 *     прошлом рестарте контейнера или фоновой promise отвалился) — резумит
 *     с того места где остановилось (см. resume-логику в самом
 *     runBaseConstructorJob).
 *   - MAX_CONCURRENCY ограничивает кол-во job'ов на одной реплике.
 *     Для 3-5 параллельных задач можно либо поднять concurrency на одной
 *     реплике, либо запустить несколько реплик через docker-compose `replicas`.
 *
 * Деплой: новый контейнер `worker-baseconstructor` в docker-compose.prod.yml
 * с WORKER_KIND=baseconstructor.
 */

import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
import {
  createWorkerLogger,
  pollLoop,
  requireSupabaseAdmin,
  setupGracefulShutdown,
  sleep,
} from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Сколько job'ов параллельно один воркер берёт. Память: 1 job ≈ 0.5–1.5GB JS heap (большой `data` в памяти). */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.BASE_CONSTRUCTOR_CONCURRENCY ?? '2'));
/**
 * Через сколько минут «застрявшая» processing-задача считается умершей и
 * её надо резумнуть. Heartbeat в `updateJobProgress` шлёт started_at на
 * каждый прогресс-тик (find_emails — каждые 10 строк), так что в норме
 * между двумя heartbeat'ами проходит секунды, максимум 1-2 мин в самых
 * медленных шагах. 5 мин = ~30× нормального интервала: достаточно
 * консервативно чтобы не воровать живые job'ы, и достаточно быстро
 * чтобы redeploy не оставлял клиента ждать 15 мин до пере-claim'а
 * (как было в реальном случае polza@polza.ru job 55d37e8e — потеряли
 * почти час между «worker умер при redeploy» и «новый worker подобрал»).
 *
 * NB: код-дефолт 5, но прод ставит 15 (BASE_CONSTRUCTOR_STALE_MINUTES в
 * docker-compose.prod.yml). С 3 репликами этот порог важен: пока он заметно
 * больше heartbeat-интервала, реплика B не «угонит» живую job'у реплики A.
 * 15 мин = с запасом; чистый redeploy всё равно реклеймит за ~5 сек через
 * ageRunningJobsForFastHandoff (SIGTERM), не дожидаясь порога.
 */
const STALE_JOB_MINUTES = Math.max(2, Number(process.env.BASE_CONSTRUCTOR_STALE_MINUTES ?? '5'));
const WORKER_ID = `baseconstructor-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

const running = new Set<Promise<void>>();
/**
 * Job IDs currently executing on this worker. Used by the SIGTERM handler
 * below to bump their `started_at` to a past timestamp before the process
 * exits — that way the next worker reclaims them on the next poll tick
 * (≈5s) instead of waiting STALE_JOB_MINUTES.
 */
const runningJobIds = new Set<string>();

/**
 * Best-effort: ageing `started_at` on every job this worker is mid-flight
 * for, so the next worker after a redeploy can reclaim immediately. Called
 * from the SIGTERM/SIGINT handler. Failures are logged but don't block —
 * Docker's stop-timeout (10s by default) is our hard ceiling, and a stale-
 * window fallback still works in the worst case.
 */
async function ageRunningJobsForFastHandoff(): Promise<void> {
  if (runningJobIds.size === 0) return;
  const ids = Array.from(runningJobIds);
  const db = requireSupabaseAdmin(log);
  // Far enough past that any STALE_JOB_MINUTES setting < 60min instantly
  // counts these as stale. The next polling worker's claimStaleResumable()
  // CAS will pick them up within ~5s.
  const farPast = new Date(Date.now() - 60 * 60_000).toISOString();
  log(
    'info',
    `marking ${ids.length} in-flight job(s) for fast handoff after shutdown: ${ids.join(', ')}`,
  );
  await db
    .from('base_constructor_jobs')
    .update({ started_at: farPast })
    .in('id', ids)
    .eq('status', 'processing');
}

/**
 * Атомарно подбирает один pending-job: UPDATE WHERE status=pending.
 * Если другой воркер успел раньше — UPDATE затронет 0 строк, claim вернёт null.
 */
async function claimPendingJob(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('base_constructor_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('base_constructor_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  return claimed?.id ?? null;
}

/**
 * Атомарно подбирает один processing-job со старым `started_at` (≥STALE_JOB_MINUTES без heartbeat).
 *
 * Heartbeat — `started_at` обновляется в `updateJobProgress` при каждом тике
 * прогресса. Если 15+ минут не двигалось — promise умер, можно резумнуть.
 *
 * Защита от гонок: тот же CAS-паттерн с `lt('started_at', cutoff)` —
 * только первый воркер успешно bumps started_at, остальные видят свежий
 * timestamp и пропускают.
 */
async function claimStaleResumable(): Promise<string | null> {
  const db = requireSupabaseAdmin(log);
  const cutoffIso = new Date(Date.now() - STALE_JOB_MINUTES * 60_000).toISOString();
  const { data: stale } = await db
    .from('base_constructor_jobs')
    .select('id, current_step, total_steps, current_step_progress')
    .eq('status', 'processing')
    .lt('started_at', cutoffIso)
    .order('started_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!stale) return null;

  const { data: claimed } = await db
    .from('base_constructor_jobs')
    .update({ started_at: new Date().toISOString() })
    .eq('id', stale.id)
    .eq('status', 'processing')
    .lt('started_at', cutoffIso)
    .select('id')
    .maybeSingle();
  if (!claimed) return null;

  log(
    'info',
    `claiming stale job ${stale.id} for resume: step ${stale.current_step}/${stale.total_steps}, progress ${stale.current_step_progress}%`,
  );
  return claimed.id;
}

/**
 * Пытается забрать pending → если нет, забирает stale processing.
 * Pending приоритетнее, чтобы новые задачи не ждали в очереди за резумами.
 */
async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true; // занят — повторим скоро
  }

  let jobId = await claimPendingJob();
  let isResume = false;
  if (!jobId) {
    jobId = await claimStaleResumable();
    isResume = !!jobId;
  }
  if (!jobId) return false;

  const task = (async () => {
    log('info', `Running base-constructor job ${jobId}${isResume ? ' (RESUME)' : ''}`);
    runningJobIds.add(jobId);
    try {
      await runBaseConstructorJob(jobId);
      log('info', `Finished base-constructor job ${jobId}`);
    } catch (err) {
      log('error', `base-constructor job ${jobId} crashed`, err);
    } finally {
      runningJobIds.delete(jobId);
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

/**
 * Suppress known undici body-parser assertion that crashes this worker
 * mid-job during `find_emails` (массовый скрейпинг сайтов через global fetch).
 *
 * Симптом (incident 2026-06-19, jobs 561a2018-... и d2786f96-...):
 *   AssertionError [ERR_ASSERTION]: assert(!this.paused)
 *     at Parser.finish (node:internal/deps/undici/undici:6157:9)
 *     at Socket.<anonymous> (node:internal/deps/undici/undici:6491:36)
 *     at Socket.emit (node:events:531:35)
 *
 * Что происходит: undici парсит ответ HTTP, AbortController таймаута дёргает
 * abort() в момент когда сокет уже эмитит 'end'. Внутренний инвариант
 * парсера (`!this.paused`) ломается, ассерт-throw летит ИЗ event-handler'a
 * сокета — `try/catch` вокруг `await fetch(...)` его не ловит, потому что
 * это не reject промиса, а синхронный uncaught в обработчике события.
 * Node по умолчанию валит весь процесс. Дальше:
 *   1. Контейнер падает на ~29% find_emails
 *   2. Docker restart policy поднимает новый процесс
 *   3. Через STALE_JOB_MINUTES мин stale-claim резюмит задачу с того же
 *      чекпоинта, попадаем на тот же URL → тот же ассерт → crash
 *   4. Infinite loop, base не дописывается никогда.
 *
 * Фикс: ловим именно этот ассерт на process-level — воркер пропускает
 * один битый запрос (его данные мы и так теряем) и продолжает. Любые
 * другие uncaught/unhandled остаются как были — `process.exit(1)`.
 *
 * Долгосрочно: вместе с этим хэндлером в emailScraper.fetchPage добавлен
 * outer Promise.race timeout — если promise `fetch(...)` после ассерта
 * не зарезолвится сам (видели в трейсе остановку body-stream'а), он
 * принудительно вернёт null и слот processInPool освободится.
 */
function installUndiciAssertGuard(): void {
  const isUndiciAssertionError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ERR_ASSERTION' && (err.stack ?? '').includes('undici');
  };
  process.on('uncaughtException', (err) => {
    if (isUndiciAssertionError(err)) {
      const first = (err.message ?? '').split('\n')[0] ?? '';
      log('warn', `Suppressed undici parser assertion (uncaught): ${first.trim()}`);
      return;
    }
    log('error', `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`, err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    if (isUndiciAssertionError(reason)) {
      const first = ((reason as Error).message ?? '').split('\n')[0] ?? '';
      log('warn', `Suppressed undici parser assertion (rejection): ${first.trim()}`);
      return;
    }
    log('error', `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, reason);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  log(
    'info',
    `Starting BaseConstructor worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, stale=${STALE_JOB_MINUTES}min)`,
  );
  installUndiciAssertGuard();
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  // На SIGTERM/SIGINT — параллельно к стандартному `shouldStop`-флагу —
  // отметить in-flight job'ы как «протухшие», чтобы следующий worker после
  // redeploy подобрал их на ближайшем poll tick (~5 сек) вместо ожидания
  // STALE_JOB_MINUTES. Эти listener'ы fire-and-forget'ят async UPDATE до
  // того, как Docker'у выпадет SIGKILL по stop-timeout (обычно 10s).
  // Бывшая логика без этого hand-off'а оставляла polza@polza.ru job
  // 55d37e8e ждать почти час пока новый worker дотерпел stale cutoff.
  let bumpFired = false;
  const onShutdownSignal = (sig: string) => {
    if (bumpFired) return; // дубль-сигнал — без работы
    bumpFired = true;
    log('info', `${sig} received — ageing in-flight job(s) for fast handoff`);
    void ageRunningJobsForFastHandoff().catch((err) => {
      log('error', 'failed to age in-flight jobs during shutdown', err);
    });
  };
  process.on('SIGTERM', () => onShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => onShutdownSignal('SIGINT'));

  // NB: startup recovery нам не нужен. processing-задачи без heartbeat
  // (до stale cutoff) подберутся claimStaleResumable() на следующих тиках —
  // и любая реплика, которая первой провернёт CAS, возьмёт её.
  // Если перезапустилась в момент когда задача только-только стартовала
  // (started_at свежий), мы её не подберём пока не пройдёт STALE_JOB_MINUTES,
  // но это безопасный trade-off: лучше подождать чем подобрать живую.

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['base_constructor_jobs'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
