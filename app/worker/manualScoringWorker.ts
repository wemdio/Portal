/**
 * Manual scoring worker — обрабатывает client_manual_score_runs.
 *
 * Владение прогоном — единый жизненный цикл (lib/jobs/lifecycle.ts): захват
 * pending или строки с истёкшей/обнулённой арендой, продление аренды таймером,
 * на SIGTERM — обнуление аренды для быстрой передачи.
 *
 * ЗАЧЕМ ЭТО БЫЛО НУЖНО. Захвата у этой очереди не было ВОВСЕ: цикл выбирал
 * одну строку в статусе pending и тело переводило её в processing уже после
 * выборки. Между этими двумя запросами два процесса спокойно уносили один и тот
 * же прогон, и держалось всё исключительно на том, что реплика одна. Хуже
 * другое: прогон, брошенный крахом контейнера, оставался в processing навсегда
 * — выборка смотрит только на pending, и подобрать его было уже некому. Теперь
 * захват атомарный (CAS по статусу), а брошенный прогон опознаётся истёкшей
 * арендой, а не чужим стартом.
 *
 * СТАТУСЫ ЗДЕСЬ НАЗЫВАЮТСЯ ИНАЧЕ, чем у большинства очередей: активный —
 * 'processing', не 'running' (check-констрейнт миграции 20260526_0013:
 * pending / processing / completed / failed / cancelled). Брать значения по
 * аналогии нельзя: захват сравнивает статус в CAS, и промах молча выключил бы
 * и сам захват, и все ограждённые записи.
 *
 * ВОЗОБНОВЛЕНИЕ — ПО ПОСТРОЕНИЮ. processManualRun берёт только строки прогона
 * с bucket IS NULL, а результат каждой строки пишется сразу после её обработки.
 * Поэтому чекпойнт здесь не хранилище состояния: он нужен ровно затем, чтобы
 * продлить аренду и обнулить бюджет попыток на видимом прогрессе.
 *
 * ОДНА РЕПЛИКА И concurrency: 1 — ИНВАРИАНТ, а не текущая настройка.
 * Скоринг ходит в Mailganer, и темп задаётся двумя разными ограничителями:
 *  - суточный бюджет (≤20k/сут) — РАСПРЕДЕЛЁННЫЙ, token-bucket в Postgres
 *    (lib/jobs/mailganerScoringRateLimit.ts), общий со всеми прочими путями к
 *    Mailganer. Второй владелец потолок не пробьёт, но выест общий бюджет вдвое
 *    быстрее — за счёт фонового скорера и добора;
 *  - мгновенная одновременность (resolveMailganerScoringConcurrency, по
 *    умолчанию 2 для mailganer-эндпоинта) — ПРОЦЕССНАЯ, это обычный пул
 *    промисов внутри processManualRun. Её второй процесс удваивает буквально, а
 *    клиент просил не только суточный потолок, но и ровный поток: их эндпоинт
 *    делает DNS-разбор и на поток не рассчитан.
 * Плюс к этому два владельца одного прогона дважды скрейпят одни и те же сайты
 * и дважды валидируют почты. Поэтому: сервис worker-manual-scoring поднимается
 * в ОДНОМ экземпляре (см. комментарий в docker-compose.prod.yml), а раннеру
 * задан concurrency: 1.
 *
 * ТЕРМИНАЛЬНЫЙ СТАТУС ПИШЕТ ТЕЛО (manageTerminalStatus: false): finalize()
 * ставит completed вместе с пересчитанными счётчиками по бакетам, markFailed()
 * — failed с причиной. Библиотеке остаётся держать аренду, снимать владение
 * после чужой терминальной записи и переводить в failed только прогон, который
 * исполнитель терял maxAttempts раз подряд.
 *
 * ЧИСТКА ИСТЁКШИХ ПРОГОНОВ (30 дней) — рядом с опросом, а не в захвате: у неё
 * нет своей единицы работы и аренды ей не нужно. См. maybeCleanupExpiredRuns.
 */

import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';
import { processManualRun } from '@/lib/jobs/manualScoringRunner';
import { resolveMailganerScoringConcurrency } from '@/lib/jobs/mailganerScoringThrottle';

const WORKER_ID = `manual-scoring-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

/**
 * Интервал опроса. Realtime здесь НАМЕРЕННО не подключён.
 *
 * API создаёт прогон в две фазы: сначала строка со статусом pending, потом
 * вставка доменов пачками по 1000 (app/src/app/api/client/manual-scoring/
 * upload/route.ts). Пробуждение по INSERT со status=pending разбудило бы воркер
 * в первую же миллисекунду — до того, как домены вставлены, — и прогон
 * завершился бы пустым. Десятисекундный опрос, как было до переезда, оставляет
 * вставке фору и ничего не ухудшает: файл всё равно грузит человек.
 */
const POLL_INTERVAL_MS = Number(process.env.MANUAL_SCORING_POLL_INTERVAL_MS ?? '10000');

/**
 * Аренда — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок можно
 * держать коротким: 180 с ≈ три пропущенных продления. Время до перехвата после
 * краха/OOM/SIGKILL ≈ аренда (3 мин) + один опрос (10 с) ≈ 3 мин 10 с. Именно
 * POLL_INTERVAL_MS, а не тридцатисекундный effectiveFallback из _shared.ts:
 * тот берётся только когда заведён realtime-канал, а здесь он намеренно не
 * подключён (см. POLL_INTERVAL_MS) — простаивающий цикл спит ровно интервал.
 * Чистая остановка (деплой) аренду обнуляет сразу и порога не ждёт вовсе.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.MANUAL_SCORING_LEASE_SECONDS ?? '180'));

/**
 * Как часто чистить прогоны старше 30 дней.
 *
 * Раньше чистка была только при старте — то есть на практике раз в деплой.
 * Контейнер живёт неделями, и уборка не должна зависеть от того, когда его в
 * последний раз перезапускали. Шесть часов — сильно чаще суточного шага
 * протухания и достаточно редко, чтобы не стоить ничего.
 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let nextCleanupAt = 0;

function getEndpointConfig() {
  return {
    url: process.env.MAILGANER_ENDPOINT_URL || 'https://mailganer.com/api/v2/domain-spf-score/',
    apiKey: process.env.MAILGANER_API_KEY || '',
    authScheme: process.env.MAILGANER_AUTH_SCHEME || 'CodeRequest',
    timeoutMs: Number(process.env.MAILGANER_TIMEOUT_MS ?? '10000'),
  };
}

/**
 * Удалить прогоны, у которых вышел 30-дневный срок хранения.
 *
 * Это забота уборщика, а не исполнителя: своей единицы работы у неё нет,
 * аренды ей не нужно, и её сбой не имеет права мешать разбору очереди —
 * поэтому она живёт РЯДОМ с опросом, а не внутри run(). Тот же приём, что у
 * починки «готовится» в worker/websiteInnLookup.ts.
 *
 * С арендой не пересекается: RPC cleanup_expired_manual_score_runs (миграция
 * 20260903_0011) не трогает строку с ЖИВОЙ арендой — удаляет только те, у
 * которых lease_until пуст или уже истёк. До этой миграции функция удаляла по
 * одному лишь expires_at и теоретически могла снести прогон из-под живого
 * исполнителя. Истёкшая аренда в условии оставлена намеренно: иначе строка,
 * у которой терминальная запись не легла, не удалялась бы уже никогда.
 */
async function maybeCleanupExpiredRuns(): Promise<void> {
  if (Date.now() < nextCleanupAt) return;
  nextCleanupAt = Date.now() + CLEANUP_INTERVAL_MS;
  try {
    const supabase = requireSupabaseAdmin(log);
    const { data, error } = await supabase.rpc('cleanup_expired_manual_score_runs');
    if (error) {
      log('warn', 'Cleanup function failed', error);
      return;
    }
    const deleted = typeof data === 'number' ? data : 0;
    if (deleted > 0) log('info', `Cleanup: removed ${deleted} expired runs`);
  } catch (err) {
    log('warn', 'Cleanup function failed', err);
  }
}

async function main(): Promise<void> {
  const endpoint = getEndpointConfig();

  if (!endpoint.apiKey) {
    log('error', 'MAILGANER_API_KEY env not set');
    process.exit(1);
  }

  requireSupabaseAdmin(log);
  const scoringConcurrency = resolveMailganerScoringConcurrency({
    endpointUrl: endpoint.url,
    defaultConcurrency: 5,
  });
  log(
    'info',
    `Starting Manual Scoring worker (pid=${process.pid}, lease=${LEASE_SECONDS}s, ` +
      `endpoint=${endpoint.url}, scoringConcurrency=${scoringConcurrency})`,
  );

  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<
    { id: string; source_filename: string | null; unique_count: number },
    { processed: number }
  >({
    table: 'client_manual_score_runs',
    workerId: WORKER_ID,
    // Статусы — из check-констрейнта таблицы (20260526_0013). Активный —
    // 'processing'. 'cancelled' есть в констрейнте, но сегодня его никто не
    // пишет: кнопки отмены у ручного скоринга нет. Появится — писать её должно
    // тело, библиотеке о ней знать не нужно (manageTerminalStatus: false).
    statuses: { pending: 'pending', running: 'processing', done: 'completed', failed: 'failed' },
    leaseSeconds: LEASE_SECONDS,
    // Инвариант, а не настройка: см. шапку файла про Mailganer.
    concurrency: 1,
    // Порядок захвата. У таблицы НЕТ created_at — дефолт библиотеки здесь
    // просто не существует, и без этой строки захват падал бы на каждом опросе.
    orderBy: 'started_at',
    manageTerminalStatus: false,
    /**
     * claimPatch НЕТ — намеренно, и это ровно та ловушка, ради которой правило
     * записано в библиотеке. Единственная колонка-кандидат, started_at, здесь
     * не «когда исполнитель начал», а «когда клиент загрузил файл»:
     *  - по ней идёт порядок захвата (orderBy выше) — штамп на перехвате
     *    отправлял бы брошенный прогон в конец очереди;
     *  - её же показывает клиенту экран /client/manual-scoring и список
     *    прогонов (api/client/manual-scoring/runs) — штамп врал бы человеку о
     *    времени загрузки при каждой передаче прогона.
     * Ничего, что нужно было бы обновлять на захвате, у этой таблицы нет.
     */
    /**
     * progress НЕ подключаем. Обоснование числами, как в этапе 2.
     *
     * СВЕРХУ порога нет вовсе: у client_manual_score_runs НЕТ спецификации в
     * мониторе здоровья (services/health-check/main.py) — таблица не
     * наблюдается ни на «Долго висит», ни на «новая ошибка». Значит
     * двадцатиминутного правила здесь не существует, и верхняя граница —
     * суждение, а не арифметика монитора.
     *
     * СНИЗУ порога тоже не существует, и это решающее. Единственная скалярная
     * колонка-кандидат — processed_count, и есть законные пути, на которых она
     * не двигается ВООБЩЕ за весь захват:
     *  - возобновление после того, как скоринг строк уже закончился: строк с
     *    bucket IS NULL нет, тело идёт сразу в сверку маршрутизации и
     *    снапшотов, и до finalize() ни одной записи в processed_count не будет;
     *  - хвост любого прогона: чистка названий через AI батчами по 100
     *    (companyNameCleanupBatch), заливка в Instantly и снапшоты — фаза
     *    длиной от минут до десятков минут, ни одной записи в processed_count;
     *  - прогон, у которого осталось меньше PROGRESS_FLUSH_EVERY = 25
     *    необработанных строк: за весь скоринг будет ОДНА запись, и та в самом
     *    конце — безусловным сбросом перед хвостом.
     * И даже на самом скоринге пауза между сбросами законно велика: 25 строк на
     * пул из 2 (resolveMailganerScoringConcurrency для mailganer) — до 13
     * строк подряд на поток, а одна строка в худшем случае складывается из
     * ожидания суточного токена (до 120 с), запроса с двумя повторами (~35 с),
     * обхода до 5 страниц сайта (до 60 с) и двух SMTP-проверок — то есть
     * десятки минут на один сброс.
     *
     * Порога, который переживает «ноль записей за весь захват», не бывает:
     * любой конечный сработал бы на исправном прогоне, отобрал бы его у живого
     * исполнителя и потратил бы попытку.
     *
     * Что защищает вместо порога:
     *  - мёртвый процесс аренду не продлевает — прогон подберут через
     *    ≤ LEASE_SECONDS + один опрос ≈ 3 мин 10 с. Это главный сценарий, и
     *    раньше его не закрывало ничего: прогон в processing не подбирался
     *    вовсе;
     *  - зависнуть «навсегда» телу негде: каждый внешний вызов ограничен
     *    собственным таймаутом (Mailganer 10 с × 3 попытки, обход страниц 12 с,
     *    SMTP-пробы свои), а ожидание суточного токена — max-wait лимитера;
     *  - клиент видит остановившийся прогресс-бар на своём экране раньше, чем
     *    его увидел бы любой порог: прогон запускает человек и он же за ним
     *    следит.
     */
    /**
     * maxAttempts 5 вместо трёх.
     *
     * Бюджет тратят только грубые потери аренды (crash/OOM/SIGKILL) — чистая
     * передача при деплое попыткой не считается, а исключения в теле сюда не
     * попадают (терминальный статус пишет тело). Обнуляет бюджет чекпойнт, и
     * он же — единственный способ его вернуть, потому что progress не включён.
     * Чекпойнты идут раз в 25 строк плюс один перед хвостом, но выше показано,
     * что бывают целые захваты вообще без единого чекпойнта. Три грубые
     * остановки подряд на таком захвате уронили бы исправный прогон в failed.
     * Пять оставляет предел для по-настоящему ядовитого прогона (тот, что
     * роняет контейнер) и не роняет здоровый. Повтор дёшев: оценённые домены
     * лежат в client_manual_score_rows и в кэше mailganer_domain_scores и
     * заново не оплачиваются.
     */
    maxAttempts: 5,
    select: 'source_filename, unique_count',
    failedPatch: (reason) => ({
      error_message: reason.slice(0, 500),
      finished_at: new Date().toISOString(),
    }),
    /**
     * Весь бюджет остановки — 5 секунд, и телу из них достаётся ОСТАТОК:
     * таймер бюджета заводится ДО освобождений, а из него тратятся два прохода
     * обнуления аренды с паузой в секунду и контрольное чтение строк.
     *
     * Больше и не нужно: сигнал проведён во все длинные ожидания тела
     * (ожидание токена Mailganer, HTTP к нему, обход сайта), а решение
     * «выходить» принимается на границе строки. Незаписанная строка не потеря —
     * её возьмёт следующий владелец, у неё по-прежнему bucket IS NULL.
     */
    shutdownGraceMs: 5_000,
    log,
    run: async (job, ctx) => {
      log(
        'info',
        `→ Processing run ${job.id} (${job.unique_count} domains, file: ${job.source_filename ?? '?'})` +
          (ctx.checkpoint ? ' (RESUME)' : ''),
      );
      const startedAt = Date.now();

      const result = await processManualRun({
        runId: job.id,
        endpoint,
        concurrency: scoringConcurrency,
        // Смещение для прогресс-бара: тело считает только неоценённые строки,
        // и без этого числа перехваченный прогон показывал бы клиенту счёт с
        // нуля. Лишнего запроса не стоит — unique_count уже прочитан захватом.
        uniqueCount: job.unique_count,
        // Сигнал — в паузы и в платные вызовы; жетон — во все записи в строку
        // прогона, потому что терминальный статус пишет само тело.
        signal: ctx.signal,
        runToken: ctx.runToken,
        onProgress: async (processed) => {
          // processed здесь — АБСОЛЮТНОЕ число строк прогона, а не счёт этого
          // захвата (см. uniqueCount выше).
          //
          // Две записи, и обе нужны. Первая — processed_count: это прогресс-бар
          // на экране клиента, и он ограждён жетоном (перехваченный прогон не
          // должен получать цифры от прежнего владельца). Вторая — чекпойнт:
          // возобновление и без него идёт по строкам с bucket IS NULL, здесь он
          // продлевает аренду, обнуляет бюджет попыток и сообщает о перехвате.
          const supabase = requireSupabaseAdmin(log);
          await supabase
            .from('client_manual_score_runs')
            .update({ processed_count: processed })
            .eq('id', job.id)
            .eq('run_token', ctx.runToken);
          await ctx.saveCheckpoint({ processed });
        },
      });

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (result.status === 'interrupted') {
        // Терминального статуса нет и быть не должно: строка осталась в
        // processing, аренду отпустит shutdown(), продолжит следующий владелец.
        log('info', `← Run ${job.id} interrupted after ${elapsed}s — left for reclaim`);
        return;
      }
      log(
        'info',
        `← Run ${job.id} ${result.status} in ${elapsed}s: storage=${result.buckets.storage}, ` +
          `medium=${result.buckets.medium}, high=${result.buckets.high}, top=${result.buckets.top}, ` +
          `invalid=${result.buckets.invalid}`,
      );
    },
  });

  let stopFired = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (stopFired) return;
      stopFired = true;
      // markShuttingDown синхронно, ДО любой async-работы: shutdown() ставит
      // флаг и сам, но полагаться на то, что он успеет до первого await внутри
      // библиотеки, нельзя — флаг читают из другого модуля.
      markShuttingDown();
      log('info', `${sig} received — releasing lease for fast handoff`);
      void runner.shutdown().catch((err) => log('error', 'shutdown failed', err));
    });
  }

  await maybeCleanupExpiredRuns();
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce: async () => {
      // Уборка идёт РЯДОМ с опросом, а не внутри захвата: аренды у неё нет и
      // быть не должно, а её сбой не имеет права мешать разбору очереди.
      await maybeCleanupExpiredRuns();
      return runner.pollOnce();
    },
    // realtimeTables НЕТ — см. POLL_INTERVAL_MS: пробуждение по INSERT
    // застало бы прогон до вставки доменов.
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
