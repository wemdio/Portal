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
/** Через сколько минут «застрявшая» processing-задача считается умершей и её надо резумнуть. */
const STALE_JOB_MINUTES = Math.max(2, Number(process.env.BASE_CONSTRUCTOR_STALE_MINUTES ?? '15'));
const WORKER_ID = `baseconstructor-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

const running = new Set<Promise<void>>();

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
    try {
      await runBaseConstructorJob(jobId);
      log('info', `Finished base-constructor job ${jobId}`);
    } catch (err) {
      log('error', `base-constructor job ${jobId} crashed`, err);
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log(
    'info',
    `Starting BaseConstructor worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, stale=${STALE_JOB_MINUTES}min)`,
  );
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

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
