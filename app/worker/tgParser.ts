/**
 * TG User Parser worker. Владение задачей — единый жизненный цикл
 * (lib/jobs/lifecycle.ts): аренда, чекпойнт {done_links, users, failed_links},
 * передача при остановке. Сброса running→pending при старте больше нет:
 * брошенную задачу определяет истёкшая аренда, и берёт её тот, кто первым
 * опросил. Прежний startupRecovery валил в pending ЛЮБУЮ running-строку, в том
 * числе живую (после `docker restart` одного контейнера или recreate соседа) —
 * сорокаминутный обход начинался с нуля.
 *
 * Терминальный статус (done/error) пишет сам runTgParserJob — он умеет
 * облегчать payload при ошибке записи. Поэтому manageTerminalStatus=false;
 * библиотека переводит задачу в error только если исполнитель терял её три
 * раза подряд (crash/OOM), чтобы битая задача не крутилась вечно.
 */

import {
  logTgParserCheckpointUnpersisted,
  runTgParserJob,
  type TgParserCheckpoint,
} from '@/lib/tgParser/tgParserJobWorker';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/**
 * Аренда. Продлевается независимым таймером каждые lease/3, поэтому срок можно
 * держать коротким: 3 минуты = ~3 пропущенных продления после краха/OOM/SIGKILL.
 * Чистая остановка (деплой) аренду обнуляет сразу и порога не ждёт.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.TG_PARSER_LEASE_SECONDS ?? '180'));
const WORKER_ID = `tg-parser-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function main(): Promise<void> {
  log('info', `Starting TG User Parser worker (pid=${process.pid}, lease=${LEASE_SECONDS}s)`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<{ id: string }, TgParserCheckpoint>({
    table: 'tg_parser_jobs',
    workerId: WORKER_ID,
    statuses: { pending: 'pending', running: 'running', done: 'done', failed: 'error' },
    leaseSeconds: LEASE_SECONDS,
    concurrency: 1,
    manageTerminalStatus: false,
    /**
     * progress НЕ включаем — сознательно, и вот арифметика.
     *
     * Бюджет задан монитором здоровья: он смотрит на tg_parser_jobs с порогом
     * «Долго висит» 20 минут (HEALTH_JOB_STUCK_MIN, services/health-check/
     * main.py), и сумма
     *     порог простоя + не больше одной аренды (3 мин)
     *   + не больше одного опроса (30 с — realtime будит только на
     *     status=pending, зависшая running-строка никого не будит)
     * обязана лечь заметно НИЖЕ 20 минут. То есть порог простоя ≤ ~12 минут.
     *
     * А самый длинный ЗАКОННЫЙ промежуток между записями progress_at больше
     * этого — и, строго говоря, ничем не ограничен:
     *  - progress_at двигает только onProgress (tgParserJobWorker.ts), а он
     *    зовётся на границах этапа и на каждом 25-м СОБРАННОМ контакте (не
     *    чаще раза в 10 с);
     *  - первый цикл этапа «авторы сообщений» (parser.ts, iterMessages до 5000
     *    сообщений с getSender на каждое) не отчитывается вообще, а этап
     *    «участники» с включёнными фильтрами онлайна может отсеять подряд
     *    тысячи участников — счётчик собранных не растёт, тика нет;
     *  - при этом beat() идёт на каждом шаге, так что сторожевой таймер
     *    простоя внутри парсера (stageIdleMs, 15 мин) молчит и правильно
     *    делает: обход с расширенным профилем законно ползёт со скоростью
     *    пользователь в полминуты (флуд-лимит на users.GetFullUser).
     * Порога, который одновременно влезает в 12 минут и не срабатывает на
     * живом медленном обходе, не существует.
     *
     * ПОРОГ ПРОСТОЯ ЭТАПА ЗАВЯЗАН НА ПОРОГ МОНИТОРА. Пока идёт зависание,
     * монитор молчит ровно потому, что сторожевой таймер этапа добивает
     * зависший этап и его отчёт «готово» пишет progress_at на ~15-й минуте —
     * на пять минут раньше тревоги. Значит обязано выполняться
     * TG_PARSER_STAGE_IDLE_MS < HEALTH_JOB_STUCK_MIN: подняв простой этапа выше
     * ~18 минут, мы превратим каждое зависание в ложное «Долго висит» — тот же
     * класс, что инцидент 11.08.2026. Меняя одно, сверяй с другим (та же
     * оговорка «сверяй сумму» стоит над JOB_STUCK_MINUTES в health-check).
     *
     * И решающее: при concurrency=1 брошенная по простою аренда никого не
     * спасает. Тело, которое не смотрит на signal, после abort не завершится,
     * его промис не осядет, owned не очистится — и pollOnce будет вечно
     * упираться в предел параллелизма. Задача осталась бы в running с
     * протухшей арендой, и взять её было бы некому.
     *
     * Что защищает вместо progress:
     *  - мёртвый процесс (OOM/SIGKILL/крах) не продлевает аренду — строку
     *    подберут через ≤ LEASE_SECONDS, это и есть главный сценарий;
     *  - зависшее ТЕЛО на горячем пути ловит сторожевой таймер простоя этапа
     *    (TG_PARSER_STAGE_IDLE_MS, 15 мин): он бросает вставший этап и идёт
     *    дальше. Таймаут TG_PARSER_CALL_TIMEOUT_MS (90 с) при этом покрывает
     *    ТОЛЬКО резолв источника (resolveEntityByLink); getSender, продвижение
     *    итератора и GetFullUser не таймаутятся вовсе — их держит именно
     *    сторожевой таймер этапа;
     *  - реплика тут РОВНО ОДНА (см. комментарий в docker-compose.prod.yml):
     *    брошенная по простою аренда досталась бы этому же контейнеру, и он
     *    подключился бы тем же аккаунтом, пока прежний обход ещё держит
     *    сессию, — то есть AUTH_KEY_DUPLICATED и сожжённая сессия вместо
     *    починки;
     *  - монитор здоровья продолжает следить за таблицей (found_count,
     *    progress_note, progress_at) и позовёт человека.
     *
     * ИЗВЕСТНАЯ ДЫРА, которую не закрывает ничто из перечисленного: зависание
     * в getClient (connect / checkAuthorization) — оно снаружи runStage, то
     * есть вне сторожевого таймера этапа и без таймаута на вызов. Аренда тогда
     * продлевается вечно, progress_at не пишется ни разу, и единственное, что
     * сработает, — тревога монитора через 20 минут. Чинится это не опцией
     * progress, а таймаутом на подключение в самом парсере.
     */
    /**
     * Ждём тело дольше, чем конструктор баз, и упираемся в потолок библиотеки
     * (MAX_SHUTDOWN_GRACE_MS = 12 с). Это время НА ПОПЫТКУ доиграть, а не
     * гарантия: обход смотрит на signal в mergeUser (каждый контакт) и в
     * сторожевом таймере раз в 30 с, но первый цикл этапа «авторы сообщений»
     * не смотрит вообще, а один контакт с расширенным профилем стоит 24-28 с
     * флуд-лимита. Тело нередко не уложится в 12 с, и client.disconnect() —
     * он не в finally — может не выполниться до SIGKILL.
     *
     * Наложения сессий это не допускает: их не допускает топология —
     * единственный container_name и последовательный recreate (см. комментарий
     * над сервисом в docker-compose.prod.yml), а на SIGKILL сокет закрывает
     * ядро. 12 с — просто максимум полезного ожидания внутри бюджета: против
     * stop_grace_period 30 с при ~3 с на два прохода освобождения аренды с
     * контрольным чтением.
     */
    shutdownGraceMs: 12_000,
    /**
     * started_at на каждом захвате — требование спецификации и правда нужен UI
     * («в работе с …»). Но библиотечное обоснование claimPatch (без него
     * перехваченная строка уносит отметку прогресса прежнего владельца) здесь
     * НЕ работает: отпечаток монитора для tg_parser_jobs собран из found_count,
     * progress_note, progress_at, stop_reason и result_users — started_at в нём
     * нет (services/health-check/main.py). Не надо «чинить» монитор, опираясь
     * на то, что он смотрит сюда.
     */
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, completed_at: new Date().toISOString() }),
    // Чекпойнт, который не записался, обязан быть виден в журнале самой задачи,
    // а не только в stdout контейнера: у парсера в него копится список
    // пользователей, и молча потерянное возобновление бьёт как раз по самым
    // длинным обходам.
    onCheckpointUnpersisted: logTgParserCheckpointUnpersisted,
    log,
    run: async (job, ctx) => {
      log('info', `Running TG parser job ${job.id}${ctx.checkpoint ? ' (RESUME)' : ''}`);
      await runTgParserJob(job.id, {
        signal: ctx.signal,
        checkpoint: ctx.checkpoint,
        // Жетон нужен телу задачи потому, что терминальный статус пишет оно
        // само: при manageTerminalStatus=false библиотека эти записи оградить
        // не может, и без жетона старое тело после перехвата задачи могло бы
        // проштамповать итог поверх работы нового владельца.
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
      // этот флаг и сам, но полагаться на то, что он успеет до первого await
      // внутри библиотеки, нельзя — флаг читают из другого модуля, и порядок
      // операторов в чужой библиотеке для этого слишком хрупкая опора.
      // Вызов идемпотентный, флаг односторонний — лишним он быть не может.
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
    realtimeTables: ['tg_parser_jobs'],
  });
  await runner.shutdown();
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
