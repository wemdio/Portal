import { runYandexMapsCatalogDiscoveryBatch, runYandexMapsCollectLinks, runYandexMapsParseOrganizations } from '@/lib/parsers/yandexMapsWorker';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep, startWorkerHeartbeat } from './_shared';

/**
 * Heartbeat-файл: обновляется каждые 30с независимым setInterval-тиком.
 * Docker healthcheck читает mtime и флипает контейнер в unhealthy, если он
 * не обновлялся > 300с — autoheal тогда перезапускает воркер. Ловит именно
 * event-loop hang (инцидент 27.07.2026: воркер дважды за день замерз на
 * 1-5 часов без падения процесса, watchdog в том же loop'е тоже мёртв).
 */
const HEARTBEAT_PATH = process.env.YANDEXMAPS_WORKER_HEARTBEAT_PATH ?? '/tmp/yandexmaps-worker-heartbeat';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
// MAX_CONCURRENCY поднят 2 → 4 (16.07.2026): каждая yandex-задача внутри себя
// параллелит до 6 чанков парсинга (см. yandexMapsWorker.ts), а глобальный
// python-семафор PARSE_CONCURRENCY (6-8) не даст переполнить сервис. Итого
// на app-сервер держим ≤ 8 одновременных chromium-контекстов, ~2 ГБ RAM.
// Если сервер слабее — снизить через env WORKER_YANDEXMAPS_CONCURRENCY.
const MAX_CONCURRENCY = Number(process.env.WORKER_YANDEXMAPS_CONCURRENCY ?? '4');
const WORKER_ID = `yandexmaps-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
// Map jobId → Promise: держим jobId, чтобы при graceful shutdown (SIGTERM
// от docker compose --force-recreate) успеть пометить свои running-задачи
// как pending до exit. Без этого задача остаётся в running, updated_at
// стареет, watchdog добивает её как зомби вместо восстановления новым
// процессом.
const runningJobs = new Map<string, Promise<void>>();

const ZOMBIE_THRESHOLD_MINUTES = 15;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
// Окно «свежих» running при startupRecovery: раньше было 5 мин, но реальные
// production-деплои через scheduled-deploy занимают 3-10 мин (образ pull +
// force-recreate + healthcheck warmup). Задачи с updated_at 5-15 мин назад
// оставались в running между shutdown и startup → в дыру попадали, watchdog
// потом добивал вместо восстановления. 30 мин с запасом покрывает любой
// нормальный деплой; всё старше — реально зомби (см. cutoffZombie ниже).
const RECOVERY_FRESH_WINDOW_MINUTES = Number(process.env.YANDEXMAPS_RECOVERY_FRESH_WINDOW_MINUTES ?? '30');
const CATALOG_DISCOVERY_STALE_MINUTES = Number(process.env.YANDEXMAPS_CATALOG_DISCOVERY_STALE_MINUTES ?? '120');

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  // СВЕЖИЕ running (updated_at < RECOVERY_FRESH_WINDOW_MINUTES назад) →
  // pending. У нас всегда только один worker-yandexmaps на весь prod (нет
  // horizontal scale), значит на момент startup любая running-задача точно
  // осиротела от предыдущего процесса. Прошлое поведение (окно 5 мин)
  // не покрывало деплои >5 мин — задачи Глеба слетали в failed через
  // watchdog вместо продолжения.
  const cutoffFresh = new Date(Date.now() - RECOVERY_FRESH_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data: fresh, error: freshErr } = await db
    .from('yandex_maps_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .gte('updated_at', cutoffFresh)
    .select('id');
  if (freshErr) log('warn', 'Startup recovery: fresh running -> pending failed', freshErr);
  else if (fresh?.length) log('info', `Startup recovery: ${fresh.length} свежих running сброшены в pending (окно ${RECOVERY_FRESH_WINDOW_MINUTES} мин)`);

  const cutoffZombie = new Date(Date.now() - ZOMBIE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  const { data: zombies, error: zombieErr } = await db
    .from('yandex_maps_jobs')
    .update({
      status: 'failed',
      error_message: `Автоматически остановлено при старте воркера: задача была в статусе running более ${ZOMBIE_THRESHOLD_MINUTES} мин без обновлений (зомби). Слот освобождён, попробуйте перезапустить.`,
      progress_stage: 'stuck_recovered',
      completed_at: new Date().toISOString(),
    })
    .eq('status', 'running')
    .lt('updated_at', cutoffZombie)
    .select('id');
  if (zombieErr) log('warn', 'Startup recovery: zombie cleanup failed', zombieErr);
  else if (zombies?.length) log('warn', `Startup recovery: ${zombies.length} зомби переведены в failed (${ZOMBIE_THRESHOLD_MINUTES}+ мин без updates)`);

  // Задание обхода, взятое в работу перед остановкой воркера, иначе ждало бы
  // своей отложенной даты неделю. Возвращаем такие в очередь сразу.
  const catalogCutoff = new Date(Date.now() - CATALOG_DISCOVERY_STALE_MINUTES * 60 * 1000).toISOString();
  const { data: staleScans, error: staleScanError } = await db
    .from('yandex_maps_catalog_discovery_queue')
    .update({
      status: 'pending',
      next_scan_at: new Date().toISOString(),
      last_error: 'Восстановлено после остановки yandexmaps worker',
    })
    .eq('status', 'running')
    .lt('claimed_at', catalogCutoff)
    .select('id');
  if (staleScanError) log('warn', 'Startup recovery: stale catalog discovery cleanup failed', staleScanError);
  else if (staleScans?.length) log('warn', `Startup recovery: ${staleScans.length} зависших заданий обхода возвращены в очередь`);
}

/**
 * Watchdog: раз в 5 мин ищет running-задачи без обновлений > 15 мин и
 * переводит их в failed. Отдельная async-петля, независимая от основного
 * pollLoop — если основной loop застрял в retry supabase, watchdog всё
 * равно ходит по timer'у setInterval и разморозит слот. Работает через
 * тот же supabaseAdmin, но использует другую цепочку fetch — если сеть
 * умерла полностью, оба встанут (но тогда и делать нечего).
 */
function startZombieWatchdog(shouldStop: () => boolean): NodeJS.Timeout {
  const db = requireSupabaseAdmin(log);
  const tick = async () => {
    if (shouldStop()) return;
    try {
      const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
      const { data: zombies, error } = await db
        .from('yandex_maps_jobs')
        .update({
          status: 'failed',
          error_message: `Автоматически остановлено watchdog'ом: задача была в running более ${ZOMBIE_THRESHOLD_MINUTES} мин без обновлений (зависла). Слот освобождён. Если данные успели собраться — нажмите Продолжить парсинг.`,
          progress_stage: 'stuck_recovered',
          completed_at: new Date().toISOString(),
        })
        .eq('status', 'running')
        .lt('updated_at', cutoff)
        .select('id');
      if (error) log('warn', 'Watchdog: zombie cleanup query failed', error);
      else if (zombies?.length) log('warn', `Watchdog: ${zombies.length} зомби-задач переведены в failed`);
    } catch (e) {
      log('warn', 'Watchdog tick failed', e);
    }
  };
  // Первый тик через 1 мин после старта — даём успеть подхватить свежие задачи.
  const timer = setInterval(() => void tick(), WATCHDOG_INTERVAL_MS);
  setTimeout(() => void tick(), 60_000);
  return timer;
}

async function claimYandexMapsJob(): Promise<{ id: string; stage: 'collect' | 'parse' } | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('yandex_maps_jobs')
    .select('id, progress_stage')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('yandex_maps_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, progress_stage')
    .maybeSingle();

  if (!claimed) return null;
  const stageValue = String(claimed.progress_stage ?? 'pending');
  const stage =
    stageValue === 'ready_to_parse' ||
    stageValue === 'links_collected' ||
    stageValue.startsWith('parsing_organizations')
      ? 'parse'
      : 'collect';
  return { id: claimed.id as string, stage };
}

/**
 * Фоновый обход каталога, запущенный в фоне, а не внутри итерации цикла.
 *
 * Раньше он шёл под `await` прямо в `pollOnce`, и цикл в него упирался: обход
 * это живой поиск по Яндексу — до 250 ссылок выдачи плюс карточки всех новых
 * организаций, то есть минуты. Пользовательская задача, пришедшая через
 * секунду после начала обхода, столько же и ждала: realtime исправно будил
 * цикл, а цикл был занят. 10.08.2026 это вылилось в две минуты ожидания на
 * пустой очереди.
 *
 * Обход не отменяется на полпути: он помечает задание в очереди как взятое, и
 * прерванное вернётся в работу само через YANDEXMAPS_CATALOG_DISCOVERY_STALE_MINUTES.
 */
let discoveryTask: Promise<void> | null = null;

function startCatalogDiscovery(): void {
  if (discoveryTask) return;
  discoveryTask = runYandexMapsCatalogDiscoveryBatch()
    .then(() => undefined)
    .catch((error) => { log('warn', 'Catalog discovery batch failed', error); })
    .finally(() => { discoveryTask = null; });
}

async function pollOnce(): Promise<boolean> {
  if (runningJobs.size >= MAX_CONCURRENCY) {
    await sleep(500);
    return true;
  }
  const job = await claimYandexMapsJob();
  // Пользовательские задачи в приоритете: новый обход не начинаем, пока хоть
  // одна из них выполняется. Уже начатый при этом доживает свой круг — рвать
  // его на полпути дороже, чем потерпеть одну лишнюю параллельную задачу.
  //
  // Возвращаем false, а не результат обхода: цикл уходит ждать realtime и
  // проснётся на первой же пользовательской задаче. Плата — до 30 секунд
  // (fallback цикла) простоя между кругами обхода; для механизма, который
  // приносит сотни организаций в сутки, это ничто.
  if (!job) {
    if (runningJobs.size === 0) startCatalogDiscovery();
    return false;
  }
  const task = (async () => {
    if (job.stage === 'collect') {
      log('info', `Running YandexMaps collect-links job ${job.id}`);
      await runYandexMapsCollectLinks(job.id);
    } else {
      log('info', `Running YandexMaps parse-orgs job ${job.id}`);
      await runYandexMapsParseOrganizations(job.id);
    }
  })();
  runningJobs.set(job.id, task);
  void task.finally(() => runningJobs.delete(job.id));
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting YandexMaps worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  log('info', 'Running startup recovery...');
  await startupRecovery();
  log('info', 'Startup recovery done');

  const watchdog = startZombieWatchdog(shouldStop);
  log('info', `Zombie watchdog started (threshold=${ZOMBIE_THRESHOLD_MINUTES}min, tick=${WATCHDOG_INTERVAL_MS / 1000}s)`);

  try {
    await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ['yandex_maps_jobs'] });
  } finally {
    clearInterval(watchdog);
    clearInterval(heartbeat);
    // Graceful requeue: помечаем свои running-задачи как pending, чтобы
    // следующий процесс (после docker restart / --force-recreate) сразу их
    // подхватил через startupRecovery без ожидания 15-мин watchdog'а и без
    // риска зафейлиться. Держим общий тайм-аут 5с — если БД не отвечает,
    // всё равно выходим (deploy не должен блокироваться).
    if (runningJobs.size > 0) {
      const jobIds = Array.from(runningJobs.keys());
      log('info', `Graceful requeue: ${jobIds.length} running задач → pending (${jobIds.join(', ')})`);
      try {
        const db = requireSupabaseAdmin(log);
        await Promise.race([
          db.from('yandex_maps_jobs').update({ status: 'pending' }).in('id', jobIds).eq('status', 'running'),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (e) {
        log('warn', 'Graceful requeue failed', e);
      }
    }
  }
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});

