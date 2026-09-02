/**
 * YandexMaps worker — сбор ссылок и парсинг организаций Яндекс.Карт.
 *
 * Владение задачей — единый жизненный цикл (lib/jobs/lifecycle.ts): захват
 * pending или строки с истёкшей/обнулённой арендой, продление аренды таймером,
 * на SIGTERM — обнуление аренды для быстрой передачи соседу.
 *
 * ЧТО УБРАНО И ЧТО ИЗМЕНИЛОСЬ ДЛЯ ПОЛЬЗОВАТЕЛЯ.
 *
 * Здесь стояли три самописных механизма владения, и все три сняты:
 *  1. startupRecovery по yandex_maps_jobs: «свежие» running → pending (окно 30
 *     мин) и running старше 15 минут → failed с progress_stage='stuck_recovered';
 *  2. zombie watchdog на setInterval раз в 5 минут — та же запись в failed;
 *  3. graceful requeue своих running-задач в pending при выходе.
 *
 * Поведенческое изменение: задача больше НЕ уходит в failed с формулировкой
 * «автоматически остановлено … зомби». Зависшая задача просто перестаёт
 * продлевать аренду, её подбирает следующий опрос и продолжает с сохранённого
 * места — по уже собранным ссылкам (yandex_maps_links) и уже разобранным
 * карточкам (yandex_maps_organizations). Пользователь видит продолжение, а не
 * ошибку со слотом, который надо перезапускать руками.
 *
 * ЧТО ОСТАЛОСЬ НАМЕРЕННО:
 *  - восстановление очереди обхода каталога (yandex_maps_catalog_discovery_queue:
 *    running с claimed_at старше 120 минут → pending) и весь код обхода. Эта
 *    очередь берётся и закрывается через RPC против общего суточного бюджета
 *    Яндекса, а не через аренду, и в эту фазу переезда сознательно не входит;
 *  - startWorkerHeartbeat и healthcheck контейнера по файлу пульса. Это другой
 *    слой защиты, чем аренда: аренда ловит мёртвый процесс, пульс — мёртвый
 *    event loop в живом процессе (инцидент 27.07.2026), а autoheal его
 *    перезапускает. Аренда такое не увидит: продление идёт из того же event
 *    loop'а и вместе с ним замирает — строку подберут лишь по истечении аренды,
 *    контейнер же останется дохлым до рестарта.
 *
 * Терминальный статус (completed/failed) пишут сами стадии: они умеют отличить
 * блокировку Яндекса от медленных прокси и от пустой выдачи и кладут человеку
 * внятный текст в error_message. Поэтому manageTerminalStatus=false; библиотека
 * держит аренду, а в failed переводит только задачу, которую исполнитель терял
 * три раза подряд (crash/OOM), чтобы битая строка не крутилась вечно.
 */

import {
  runYandexMapsCatalogDiscoveryBatch,
  runYandexMapsCollectLinks,
  runYandexMapsParseOrganizations,
  type YandexMapsCheckpoint,
} from '@/lib/parsers/yandexMapsWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, startWorkerHeartbeat } from './_shared';

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
/**
 * Аренда — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок держим
 * коротким: 180 с ≈ три пропущенных продления. Время до перехвата после
 * краха/OOM/SIGKILL складывается из
 *     аренда (3 мин, она доживает свой срок сама)
 *   + один опрос соседа (30 с: realtime будит только на status=eq.pending, а
 *     простаивающий цикл ждёт Math.max(pollIntervalMs, 30_000) —
 *     effectiveFallback в app/worker/_shared.ts)
 *   ≈ 3,5 минуты — вшестеро ниже порога монитора «Долго висит»
 *   (HEALTH_JOB_STUCK_MIN, 20 мин, services/health-check/main.py).
 * Прежний watchdog на то же самое тратил до 15 минут И ронял задачу в failed.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.YANDEXMAPS_LEASE_SECONDS ?? '180'));
const CATALOG_DISCOVERY_STALE_MINUTES = Number(process.env.YANDEXMAPS_CATALOG_DISCOVERY_STALE_MINUTES ?? '120');
const WORKER_ID = `yandexmaps-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

type YandexMapsJobRow = { id: string; progress_stage: string | null };

/**
 * По какой стадии продолжать задачу. Ровно та же логика, что была в снятом
 * claimYandexMapsJob: стадию задаёт progress_stage, отдельной колонки вида
 * `kind` в yandex_maps_jobs нет.
 */
function stageOf(job: YandexMapsJobRow): 'collect' | 'parse' {
  const stage = String(job.progress_stage ?? 'pending');
  return stage === 'ready_to_parse' ||
    stage === 'links_collected' ||
    stage.startsWith('parsing_organizations')
    ? 'parse'
    : 'collect';
}

/**
 * Восстановление ТОЛЬКО очереди обхода каталога.
 *
 * НЕ УДАЛЯТЬ «для симметрии» с остальными воркерами на жизненном цикле:
 * yandex_maps_catalog_discovery_queue — не таблица задач, у её строк нет ни
 * аренды, ни жетона. Задание берётся и закрывается RPC-функциями против общего
 * суточного бюджета Яндекса (lib/parsers/yandexMapsCatalog.ts), и взятое перед
 * остановкой задание иначе ждало бы своей отложенной даты неделю.
 *
 * Здесь же стояли два восстановления по yandex_maps_jobs — см. шапку файла.
 */
async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
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

async function main(): Promise<void> {
  log('info', `Starting YandexMaps worker (pid=${process.pid}, concurrency=${MAX_CONCURRENCY}, lease=${LEASE_SECONDS}s)`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const heartbeat = startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  await startupRecovery();

  const runner = createJobRunner<YandexMapsJobRow, YandexMapsCheckpoint>({
    table: 'yandex_maps_jobs',
    workerId: WORKER_ID,
    // Статусы — из check-констрейнта таблицы: pending, running, completed,
    // failed. Своих названий у этой очереди нет.
    statuses: { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: MAX_CONCURRENCY,
    manageTerminalStatus: false,
    // Стадию берём из строки: обе стадии живут в одной таблице, и раннер
    // разводит их по progress_stage.
    select: 'progress_stage',
    /**
     * progress НЕ включаем — сознательно, и вот арифметика. Опция взвешивалась
     * дважды: по updated_at и по колонкам счётчиков. Ни одна не годится.
     *
     * 1. updated_at (казалось бы очевидный кандидат: триггер
     *    trg_yandex_maps_jobs_updated_at, миграция 20260714_0002, ставит его
     *    на КАЖДОМ update строки, то есть покрывает обе стадии сразу).
     *    Не годится именно поэтому: продление аренды — тоже update этой
     *    строки. Таймер продления бьёт раз в lease/3 = 60 с и каждым тиком
     *    двигает updated_at. Детектор простоя читает колонку ПЕРЕД продлением
     *    и всегда видит движение от собственного прошлого тика. То есть
     *    «прогресс» был бы всегда, простоя не было бы никогда, а заодно молча
     *    обнулялся бы бюджет попыток (attempts=0 на каждом тике). Ровно та
     *    ловушка, о которой предупреждает JobRunnerOptions.progress.
     *
     * 2. Счётчики. Колонок две и они разные у стадий: сбор двигает
     *    processed_links, парсинг — processed_organizations. Библиотека берёт
     *    ОДНУ. Взять колонку парсинга значит объявить зависшей любую задачу на
     *    стадии сбора (она её не трогает вовсе). Общий на обе — progress_stage,
     *    он двигается в обеих (`collecting_links:N/M`, `parsing_organizations:N/M`).
     *    Но порог под него не существует:
     *      - сверху его держит монитор: порог простоя + не больше одной аренды
     *        (3 мин) + один опрос (30 с) обязаны лечь заметно ниже
     *        HEALTH_JOB_STUCK_MIN (20 мин) — то есть порог ≤ ~15 минут;
     *      - снизу — самый длинный ЗАКОННЫЙ промежуток между записями. Строка
     *        меняется раз на завершённый URL (сбор) или чанк (парсинг), а один
     *        вызов сервиса законно длится до 900 с (COLLECT_TIMEOUT_SEC /
     *        PARSE_TIMEOUT_SEC в services/yandexmaps/server.py; клиент ждёт
     *        990 с) и повторяется по числу прокси в пуле + 1 (сегодня 8+1=9
     *        попыток, см. maxProxyRetries). Это до 9 × 990 с ≈ 148 минут на
     *        один URL/чанк — и это здоровая работа на медленных прокси, ради
     *        которых чанк и урезали до 5 карточек.
     *    Между 15 минутами сверху и 148 снизу выбирать нечего: любой порог
     *    отбирал бы задачу у живого тела, и сосед переигрывал бы тот же чанк
     *    через те же задушенные прокси.
     *
     * Что защищает вместо progress:
     *  - мёртвый процесс аренду не продлевает — строку подберут через
     *    ≤ LEASE_SECONDS + опрос ≈ 3,5 минуты, и это главный сценарий;
     *  - мёртвый event loop в живом процессе ловит heartbeat-файл и autoheal
     *    (5 минут), после рестарта аренда истекает и задача уходит соседу;
     *  - зависшее ТЕЛО в живом процессе занимает один слот из четырёх (ровно
     *    как и до миграции: прежний воркер держал такой промис в Map), а на
     *    ближайшем деплое shutdown() обнулит аренду независимо от того, осел
     *    ли промис.
     */
    /**
     * Ждём тело 12 с — потолок библиотеки (MAX_SHUTDOWN_GRACE_MS).
     *
     * Бюджет тут щедрый: stop_grace_period у сервиса 60 с (его держат ради
     * браузеров на стороне python-сервиса), а последовательность остановки
     * стоит 12 с ожидания + два прохода освобождения аренды с паузой в
     * секунду + контрольное чтение ≈ 15 с. Влезает вчетверо.
     * Больше и не нужно: тело смотрит на signal на границе URL/чанка, а
     * оборванный по signal запрос к сервису возвращается за секунды —
     * останавливаемся мы быстро, а недоигранное продолжится с уже сохранённых
     * ссылок и карточек в следующем захвате.
     */
    shutdownGraceMs: 12_000,
    /**
     * updated_at на каждом захвате — и на новом pending, и на перехвате чужой
     * истёкшей аренды. Триггер trg_yandex_maps_jobs_updated_at делает то же
     * самое на любом UPDATE, так что запись дублирующая; держим её явной,
     * потому что от свежести updated_at зависит монитор здоровья, и цена
     * ошибки тут — перехваченная строка с отметкой прежнего владельца, то есть
     * ложная тревога «Долго висит» в ту же секунду, как задачу подобрали.
     */
    claimPatch: () => ({ updated_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      const stage = stageOf(job);
      const runCtx = { signal: ctx.signal, runToken: ctx.runToken, saveCheckpoint: ctx.saveCheckpoint };
      if (stage === 'collect') {
        log('info', `Running YandexMaps collect-links job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
        await runYandexMapsCollectLinks(job.id, runCtx);
      } else {
        log('info', `Running YandexMaps parse-orgs job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
        await runYandexMapsParseOrganizations(job.id, runCtx);
      }
    },
  });

  const pollOnce = async (): Promise<boolean> => {
    const claimed = await runner.pollOnce();
    // Пользовательские задачи в приоритете: новый обход не начинаем, пока хоть
    // одна из них выполняется. Уже начатый при этом доживает свой круг — рвать
    // его на полпути дороже, чем потерпеть одну лишнюю параллельную задачу.
    //
    // Возвращаем результат опроса как есть: на false цикл уходит ждать realtime
    // и проснётся на первой же пользовательской задаче. Плата — до 30 секунд
    // простоя между кругами обхода; для механизма, который приносит сотни
    // организаций в сутки, это ничто.
    if (!claimed && runner.activeJobIds().length === 0) startCatalogDiscovery();
    return claimed;
  };

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

  try {
    await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ['yandex_maps_jobs'] });
    await runner.shutdown();
  } finally {
    clearInterval(heartbeat);
  }
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
