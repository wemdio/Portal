/**
 * Воркер «Анализатор сейлз-переписок».
 *
 * Плановая синхронизация переписок в 01:00 МСК + ручной запуск
 * (через таблицу-очередь sales_chat_sync_runs). Каждый запуск проходит
 * по всем active-аккаунтам и инкрементально дотягивает новые сообщения
 * (первый запуск аккаунта — полная история).
 *
 * Владение запуском — единый жизненный цикл (lib/jobs/lifecycle.ts): захват
 * pending или строки с истёкшей/обнулённой арендой, продление аренды таймером,
 * на SIGTERM — обнуление аренды для быстрой передачи. Чекпойнт — курсор по
 * обработанным аккаунтам: прерванный ночью синк не начинается заново с первого
 * аккаунта, а продолжается с того, на котором его прервали.
 *
 * Сброса running→pending при старте больше НЕТ (см. startupRecovery — там
 * осталась половина, к жизненному циклу отношения не имеющая). Брошенный запуск
 * определяет истёкшая аренда, а не факт чужого старта.
 *
 * Терминальный статус (done/error) пишет само тело: оно кладёт в error_message
 * свой текст и finished_at. Поэтому manageTerminalStatus=false; библиотека
 * переводит запуск в error только если исполнитель терял его три раза подряд
 * (crash/OOM), чтобы битая строка не крутилась вечно.
 *
 * ПОЛНОСТЬЮ ИЗОЛИРОВАН от tgParser / tgOutreach / tgTranscribe и аккаунта «Лёши».
 */

import { Api, type TelegramClient } from 'telegram';
import { createSalesChatClient } from '@/lib/salesChatAnalyzer/gramClient';
import { unsealSession } from '@/lib/salesChatAnalyzer/session';
import { syncAccount } from '@/lib/salesChatAnalyzer/capture';
import { createJobRunner, type JobContext } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Час МСК, после которого создаётся плановый запуск синхронизации. */
const SCHEDULED_HOUR_MSK = 1;
/**
 * Аренда — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок держим
 * коротким: 180 с ≈ три пропущенных продления. После краха/OOM/SIGKILL строку
 * подберут через аренду (3 мин) + один опрос соседа (30 с — realtime будит
 * только на status=pending, effectiveFallback в app/worker/_shared.ts).
 * Чистая остановка (деплой) обнуляет аренду сразу и порога не ждёт.
 */
const LEASE_SECONDS = Math.max(60, Number(process.env.SALES_CHAT_LEASE_SECONDS ?? '180'));
const WORKER_ID = `sales-chat-logger-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

interface AccountRow {
  id: string;
  label: string | null;
  tg_user_id: number | null;
  session_sealed: string;
  last_synced_at: string | null;
}
interface SyncRun {
  id: string;
  trigger: string;
}
/** Курсор синка: сколько аккаунтов уже пройдено в этом запуске. */
interface SyncCheckpoint {
  accounts_done: number;
}

function mskNow(): Date {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}
function mskDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function isAuthError(msg: string): boolean {
  return /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|UNAUTHORIZED/i.test(msg);
}
function selfDisplayName(me: unknown, fallback: string): string {
  if (me instanceof Api.User) {
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ').trim();
    return name || me.username || fallback;
  }
  return fallback;
}

/**
 * Возвращает зависшие АККАУНТЫ в очередь после рестарта.
 *
 * НЕ УДАЛЯТЬ «для симметрии» с остальными воркерами на жизненном цикле.
 * sales_chat_accounts — не таблица задач: у её строк нет ни аренды, ни жетона,
 * и backfill_status='running' там ставит тело синка (syncOneAccount) как метку
 * для экрана. Если процесс убили посреди аккаунта, эта метка не истекает сама
 * никогда — аккаунт остаётся «в работе» вечно, и человек в UI видит вечный
 * прогресс. Сброс running→pending СЕРЕДИНЫ ЗАПУСКА тут не ломает: сам запуск
 * (sales_chat_sync_runs) переживает рестарт по аренде и продолжается с курсора,
 * а backfill_status следующим касанием аккаунта перезапишется заново.
 *
 * Сброса самих sales_chat_sync_runs здесь больше нет: он валил в pending любую
 * running-строку, включая живую в соседнем контейнере, и ночной синк начинался
 * с первого аккаунта заново.
 */
async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  await db.from('sales_chat_accounts').update({ backfill_status: 'pending' }).eq('backfill_status', 'running');
}

/** Создаёт плановый запуск на сегодня (МСК), если его ещё нет. */
async function ensureScheduledRun(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const msk = mskNow();
  if (msk.getUTCHours() < SCHEDULED_HOUR_MSK) return;
  const date = mskDateStr(msk);

  const { data: existing } = await db
    .from('sales_chat_sync_runs')
    .select('id')
    .eq('trigger', 'scheduled')
    .eq('sync_date', date)
    .maybeSingle();
  if (existing) return;

  const { error } = await db
    .from('sales_chat_sync_runs')
    .insert({ trigger: 'scheduled', sync_date: date, status: 'pending' });
  // Уникальный индекс по (sync_date) where trigger='scheduled' защищает от гонок.
  if (error && !/duplicate|unique/i.test(error.message)) {
    log('warn', 'ensureScheduledRun insert failed', error);
  } else if (!error) {
    log('info', `Scheduled sync run created for ${date}`);
  }
}

/**
 * Синхронизирует один аккаунт; возвращает true при успехе.
 *
 * Все записи здесь идут в sales_chat_accounts — ЧУЖУЮ таблицу, у которой нет
 * ни жетона, ни аренды. Оградить их нечем, поэтому единственная защита —
 * проверка signal перед началом аккаунта: после перехвата запуска соседом мы
 * просто не берёмся за следующий. Уже начатый аккаунт дописывается до конца:
 * syncAccount на signal не смотрит вовсе, прерывать её посередине нечем, а
 * итоговая запись (backfill_status/last_synced_at) отражает реально
 * выкачанные данные и потому безопасна даже если строку уже ведёт сосед —
 * last_synced_at она сдвигает на СВОЮ, более раннюю отметку, то есть в худшем
 * случае следующий синк перечитает лишнее, а не пропустит.
 */
async function syncOneAccount(acc: AccountRow, signal: AbortSignal): Promise<boolean> {
  const db = requireSupabaseAdmin(log);
  let client: TelegramClient | null = null;
  try {
    if (signal.aborted) return false;
    await db.from('sales_chat_accounts').update({ backfill_status: 'running' }).eq('id', acc.id);

    client = createSalesChatClient(unsealSession(acc.session_sealed));
    await client.connect();
    if (!(await client.isUserAuthorized())) throw new Error('AUTH_KEY_UNREGISTERED: сессия недействительна');

    let selfName = acc.label ?? 'Аккаунт';
    try {
      selfName = selfDisplayName(await client.getMe(), selfName);
    } catch {
      // мета не критична
    }

    const sinceUnix = acc.last_synced_at
      ? Math.floor(new Date(acc.last_synced_at).getTime() / 1000)
      : 0;
    // Точку отсчёта фиксируем ДО синка — сообщения, пришедшие во время синка,
    // не потеряются (попадут в следующий запуск).
    const startedAt = new Date().toISOString();

    await syncAccount({
      admin: db,
      account: { id: acc.id, tg_user_id: acc.tg_user_id, label: acc.label },
      client,
      selfName,
      sinceUnix,
      log,
    });

    await db
      .from('sales_chat_accounts')
      .update({
        backfill_status: 'done',
        last_synced_at: startedAt,
        last_connected_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', acc.id);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `[${acc.id}] sync failed`, err);
    const patch: Record<string, unknown> = { backfill_status: 'error', last_error: msg.slice(0, 500) };
    if (isAuthError(msg)) patch.status = 'auth_error';
    await db.from('sales_chat_accounts').update(patch).eq('id', acc.id);
    return false;
  } finally {
    // Соединение закрываем ВСЕГДА, на любом пути выхода: два процесса на одном
    // Telegram-аккаунте — это AUTH_KEY_DUPLICATED и сожжённая сессия.
    if (client) await client.disconnect().catch(() => {});
  }
}

/** Прогоняет синхронизацию по всем активным аккаунтам. */
async function runSync(run: SyncRun, ctx: JobContext<SyncCheckpoint>): Promise<void> {
  const db = requireSupabaseAdmin(log);
  /**
   * Ограждённая запись в строку запуска. Терминальный статус пишет тело, а не
   * библиотека (manageTerminalStatus=false), поэтому жетон обязателен на КАЖДОЙ
   * записи: без него вытесненное тело проштамповало бы done/error/прогресс
   * поверх работы нового владельца строки.
   */
  const updateRun = (patch: Record<string, unknown>) =>
    db
      .from('sales_chat_sync_runs')
      .update(patch)
      .eq('id', run.id)
      .eq('run_token', ctx.runToken);

  const { data: accounts } = await db
    .from('sales_chat_accounts')
    .select('id, label, tg_user_id, session_sealed, last_synced_at')
    .eq('status', 'active')
    // ПОРЯДОК ОБЯЗАТЕЛЕН. Курсор в чекпойнте позиционный («сколько аккаунтов
    // пройдено»), и он осмыслен только если при следующем захвате список
    // выстроится ровно так же. Без order by PostgREST возвращает строки в
    // произвольном порядке — «пропустить первые N» тогда пропускало бы
    // случайные N аккаунтов, то есть тихую потерю данных вместо продолжения.
    // id — первичный ключ, ключ стабильнее в таблице отсутствует.
    .order('id', { ascending: true });

  const list = (accounts ?? []) as AccountRow[];
  // Курсор с прошлого захвата. Аккаунты до него уже синхронизированы, и у них
  // сдвинут last_synced_at — переигрывать их не нужно. Обрезаем по длине
  // списка: аккаунт могли деактивировать между захватами, и курсор из
  // прошлого прогона мог оказаться за концом нынешнего.
  let done = Math.min(Math.max(ctx.checkpoint?.accounts_done ?? 0, 0), list.length);
  await updateRun({ accounts_total: list.length, accounts_done: done });
  log(
    'info',
    `Sync run ${run.id} (${run.trigger}): ${list.length} accounts${done > 0 ? ` (RESUME from ${done})` : ''}`,
  );

  for (const acc of list.slice(done)) {
    if (ctx.signal.aborted) return; // остановка или перехват — статус не трогаем
    await syncOneAccount(acc, ctx.signal);
    done += 1;
    // Колонку accounts_done ведёт тело (её показывает экран), чекпойнт —
    // библиотека. Пишем оба: колонка без чекпойнта не переживёт перехват,
    // чекпойнт без колонки не увидит пользователь.
    await updateRun({ accounts_done: done });
    const owned = await ctx.saveCheckpoint({ accounts_done: done });
    if (!owned || ctx.signal.aborted) return; // перехват или остановка — статус не трогаем
  }

  await updateRun({ status: 'done', finished_at: new Date().toISOString() });
  log('info', `Sync run ${run.id} done`);
}

async function main(): Promise<void> {
  log('info', `Starting Sales Chat sync worker (pid=${process.pid}, lease=${LEASE_SECONDS}s)`);
  requireSupabaseAdmin(log);
  await startupRecovery();

  const shouldStop = setupGracefulShutdown(log);

  const runner = createJobRunner<SyncRun, SyncCheckpoint>({
    table: 'sales_chat_sync_runs',
    workerId: WORKER_ID,
    // Статусы — из check-констрейнта таблицы (20260519_0004): pending, running,
    // done, error. Своих названий у этой очереди нет.
    statuses: { pending: 'pending', running: 'running', done: 'done', failed: 'error' },
    leaseSeconds: LEASE_SECONDS,
    /**
     * Ровно один запуск за раз и ровно одна реплика (см. комментарий над
     * сервисом в docker-compose.prod.yml). Два тела синка — это два
     * MTProto-соединения одним и тем же Telegram-аккаунтом, то есть
     * AUTH_KEY_DUPLICATED и сожжённая сессия (lib/tgParser/accountConflict.ts).
     */
    concurrency: 1,
    manageTerminalStatus: false,
    /**
     * progress НЕ включаем — сознательно, и вот арифметика.
     *
     * Колонка прогресса тут одна — accounts_done, и она двигается РОВНО РАЗ НА
     * АККАУНТ. Значит порог простоя обязан быть больше самого длинного
     * ЗАКОННОГО синка одного аккаунта. А он не ограничен ничем:
     *  - первый синк аккаунта идёт с sinceUnix=0, то есть полной историей: до
     *    5000 сообщений НА ДИАЛОГ (MAX_MESSAGES_PER_DIALOG в capture.ts) при
     *    трёх диалогах параллельно, а диалогов у боевого аккаунта больше
     *    тысячи (соседний worker-sales-chat-archive кладёт 10-20 минут только
     *    на сборку DOCX по УЖЕ выкачанным диалогам такого аккаунта);
     *  - вложения качаются из Telegram и льются в S3 до 50 МБ штука
     *    (SALES_CHAT_MAX_ATTACHMENT_BYTES), по три параллельно, БЕЗ таймаута
     *    на вызов — один диалог с сотней документов законно тянется часами;
     *  - даже инкрементальный проход обходит iterDialogs целиком и делает
     *    запрос dialogNeedsAttachmentBackfill на каждый неизменившийся диалог.
     * Порядок величины законного простоя accounts_done — часы. Порог в часы
     * как детектор зависания бесполезен, а любой меньший — ложное срабатывание
     * на первом же полном бэкфилле.
     *
     * Верхняя граница тут не задана монитором: JobMonitorSpec для
     * sales_chat_sync_runs в services/health-check/main.py НЕТ (в отличие от
     * search_parser_jobs и tg_parser_jobs с их порогом 20 минут). То есть
     * потолок — суждение, и суждение такое: детектор простоя имеет смысл лишь
     * если он срабатывает быстрее, чем человек заметит несинхронизированные
     * переписки, — это единицы часов. Порога, который одновременно ниже этого
     * и выше законного полного бэкфилла, не существует.
     *
     * И решающее, как у TG-парсера: при concurrency=1 и одной реплике
     * брошенная по простою аренда никого не спасает. syncAccount на signal не
     * смотрит вовсе — после abort тело не завершится, его промис не осядет,
     * owned не очистится, и pollOnce будет вечно упираться в предел
     * параллелизма. Хуже: аренду подобрал бы ЭТОТ ЖЕ контейнер и подключился
     * бы тем же Telegram-аккаунтом поверх живого соединения — AUTH_KEY_
     * DUPLICATED вместо починки.
     *
     * Что защищает вместо progress: мёртвый процесс аренду не продлевает —
     * строку подберут через ≤ LEASE_SECONDS, и это главный сценарий; а
     * зависшее тело в живом процессе отдаёт строку на ближайшем деплое, когда
     * shutdown() обнулит аренду независимо от того, осел ли промис.
     */
    /**
     * Ждём тело 5 с и не больше. Бюджет: stop_grace_period 30 с, из них два
     * прохода освобождения аренды с паузой в секунду и контрольное чтение ≈ 3 с.
     * Больше ждать бессмысленно: тело смотрит на signal только на границе
     * аккаунта, а один аккаунт идёт минутами-часами — оно всё равно не доиграет
     * и продолжится с курсора в следующем захвате. Наложения Telegram-сессий
     * это не создаёт: контейнер один и пересоздаётся последовательно, а на
     * SIGKILL сокет закрывает ядро.
     */
    shutdownGraceMs: 5_000,
    // trigger нужен телу только для журнала, но без него пришлось бы читать
    // строку вторым запросом.
    select: 'trigger',
    /**
     * started_at на каждом захвате — в том числе на перехвате чужой аренды:
     * экран показывает «в работе с …», и без этого перехваченная строка
     * уносила бы отметку прежнего владельца.
     */
    claimPatch: () => ({ started_at: new Date().toISOString() }),
    failedPatch: (reason) => ({ error_message: reason, finished_at: new Date().toISOString() }),
    log,
    run: async (job, ctx) => {
      try {
        await runSync(job, ctx);
      } catch (err) {
        // Терминальный статус пишет тело — в том числе на отказе, иначе запуск
        // остался бы в running до истечения аренды и был бы перехвачен как
        // падение. На отмене статус не трогаем: строка уже не наша (или
        // отдаётся соседу), и ограждение по жетону такую запись всё равно
        // не пропустит.
        if (ctx.signal.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `Sync run ${job.id} crashed`, err);
        await requireSupabaseAdmin(log)
          .from('sales_chat_sync_runs')
          .update({ status: 'error', error_message: msg.slice(0, 500), finished_at: new Date().toISOString() })
          .eq('id', job.id)
          .eq('run_token', ctx.runToken);
      }
    },
  });

  // Планирование — СНАРУЖИ раннера: создание плановой строки не должно зависеть
  // от того, взяли мы сейчас задачу или нет (и от предела параллелизма).
  const pollOnce = async (): Promise<boolean> => {
    await ensureScheduledRun();
    return runner.pollOnce();
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

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['sales_chat_sync_runs'],
  });
  await runner.shutdown();
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
