import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop } from './_shared';
import { runCampaignLoop, refetchEmptyDialogs } from '@/lib/tgOutreach/campaignLoop';
import { runWarmupLoop, type WarmupCheckpoint } from '@/lib/tgOutreach/warmup/loop';
import { writeHeartbeat } from '@/lib/tgOutreach/gramClient';
import {
  planWatchdogActions,
  selectOrphanedStartJobs,
  staleKillRequests,
  type LoopControl,
  type StartJobRow,
} from '@/lib/tgOutreach/watchdog';
import { createJobRunner } from '@/lib/jobs/lifecycle';
import { markShuttingDown } from '@/lib/workerShutdown';
import { startTrace } from '@/lib/tracer';

const WORKER_ID = `tg-outreach-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000;
const _MAX_CONCURRENCY = Number(process.env.TG_OUTREACH_MAX_CONCURRENCY ?? '5');

/**
 * Аренда прогона прогрева — признак живости ПРОЦЕССА, не работы.
 *
 * Продлевает её независимый таймер каждые lease/3 = 60 с, поэтому срок держим
 * коротким: 180 с ≈ три пропущенных продления. После краха/OOM/SIGKILL прогон
 * подберут через аренду (3 мин) + один опрос соседа (30 с — realtime будит
 * только на status=pending, effectiveFallback в app/worker/_shared.ts) ≈ 3,5
 * минуты. Чистая остановка (деплой) обнуляет аренду сразу и порога не ждёт.
 *
 * Прогон живёт четверо суток и переживает десяток деплоев — на длину аренды
 * это не влияет: аренда меряет не длину задачи, а частоту признаков жизни.
 */
const WARMUP_LEASE_SECONDS = Math.max(
  60,
  Number(process.env.TG_WARMUP_LEASE_SECONDS ?? '180'),
);

/**
 * Сколько прогревов одновременно на этой реплике.
 *
 * Своя очередь и свой предел, отдельно от боевых кампаний, — иначе повторился
 * бы 04.08.2026, когда прогрев ATOL-1 два часа простоял в pending, потому что
 * пять боевых кампаний держали весь общий пул слотов.
 *
 * Ограничивает число не Telegram, а память. Счётчики Telegram тут ни при чём:
 * тот, об который прогрев разбился 07.08.2026, — это импорт контактов НА
 * АККАУНТ, а две кампании греются разными аккаунтами через разные прокси, и
 * параллельность его не удваивает. А вот лимит памяти контейнера (4 ГБ,
 * docker-compose.prod.yml) подбирался под число одновременных наборов
 * подключённых клиентов, и прогревный слот теперь ДОБАВЛЯЕТСЯ к боевым:
 * потолок — сумма TG_OUTREACH_MAX_CONCURRENCY и этого числа.
 *
 * Два по умолчанию: одного мало (вторая партия аккаунтов ждала бы четверо
 * суток), а прибавка к пиковой памяти при двенадцати боевых кампаниях —
 * шестая часть. Вынесено в переменную, а не зашито: соседний
 * TG_OUTREACH_MAX_CONCURRENCY — живой памятник тому, чем кончается зашитая
 * константа, которую понадобилось поменять на бою.
 */
const WARMUP_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.TG_WARMUP_MAX_CONCURRENCY ?? '2'),
);

const log = createWorkerLogger(WORKER_ID);
const db = requireSupabaseAdmin(log);
const shouldStop = setupGracefulShutdown(log);

const runningCampaigns = new Map<string, { stop: () => void; promise: Promise<void> }>();

// Per-campaign last-progress timestamps. Each campaign loop calls onProgress()
// in its hot spots (top of while iteration, before each account, after each
// account pause). If a campaign stops reporting progress for longer than the
// watchdog threshold, we force-exit the process so docker/autoheal can restart
// us. This catches "container healthy but main loop frozen" scenarios — the
// May 10 incident: worker hung 35 hours after a single "Пауза 211 сек" log
// line, autoheal didn't react because the independent heartbeat setInterval
// kept the container green.
const campaignLastProgressAt = new Map<string, number>();
const WATCHDOG_THRESHOLD_MS = Number(process.env.TG_OUTREACH_WATCHDOG_MS) || 15 * 60_000;
const WATCHDOG_CHECK_INTERVAL_MS = 60_000;

// Сколько ждать, пока кампания умрёт по-хорошему, прежде чем ронять процесс.
// Разрыв сокетов будит зависший await почти мгновенно, но циклу нужно ещё
// доразмотать текущий шаг и дописать статус в БД.
const WATCHDOG_KILL_GRACE_MS = Number(process.env.TG_OUTREACH_WATCHDOG_GRACE_MS) || 3 * 60_000;

// Ручки, которыми сторожевой таймер гасит конкретную кампанию, не трогая
// соседние: до 05.08.2026 единственным лечением был process.exit(1), и одна
// залипшая кампания уносила все остальные вместе с прогревом.
const campaignControls = new Map<string, LoopControl>();
const campaignKillRequestedAt = new Map<string, number>();

/**
 * Ручки остановки идущих прогревов, по campaign_id.
 *
 * Отдельная карта, а не общий runningCampaigns: слот в нём считается против
 * предела боевых кампаний, а прогрев теперь живёт своей очередью и своим
 * пределом. Сторожевому таймеру, однако, прогрев виден ровно как раньше — он
 * обязан уметь погасить зависший прогрев так же, как зависшую кампанию, иначе
 * разрыв сокетов (forceDisconnect) оставил бы цикл крутиться с мёртвыми
 * клиентами вместо того, чтобы дать ему выйти и отпустить аренду.
 */
const warmupStops = new Map<string, () => void>();

/**
 * Прогоны, которым уже сказали в журнал, что они ждут свободный слот.
 *
 * Фраза верна на каждом опросе, а опросы идут раз в 30 секунд — без этого
 * множества вкладка «Прогрев» за сутки ожидания получила бы три тысячи
 * одинаковых строк. Запись снимается, когда прогон наконец захвачен.
 */
const warmupWaitLogged = new Set<string>();

function forgetCampaign(campaignId: string) {
  runningCampaigns.delete(campaignId);
  campaignLastProgressAt.delete(campaignId);
  campaignControls.delete(campaignId);
  campaignKillRequestedAt.delete(campaignId);
}

/**
 * Закрыть зависшие start-джобы вместо возврата в очередь.
 *
 * Единственная точка записи для обоих путей — сброса на старте процесса и
 * периодического сторожа сирот: они отличаются только тем, КАК находят джобу.
 *
 * Почему `completed`, а не `pending`: claimJob и handleStartJob статус кампании
 * не проверяют, а runCampaignLoop на входе безусловно пишет `running`. Поэтому
 * start-джоба, возвращённая в очередь, воскрешала кампанию, остановленную
 * оператором (аудит 20.08). Решение о перезапуске принимает
 * resumeRunningCampaigns — она вызывается следом и уже гейтед по статусу
 * кампании. Прогрева это давно не касается: команда «warmup_start» теперь
 * закрывается сразу, а прогон подбирается по аренде.
 */
async function closeStuckStartJobs(ids: string[], reason: string): Promise<void> {
  if (!ids.length) return;
  const { error } = await db
    .from('tg_outreach_jobs')
    .update({ status: 'completed', finished_at: new Date().toISOString(), error_message: reason })
    .in('id', ids)
    // Гонка с .finally() живого цикла: он помечает джобу completed параллельно,
    // и без этого условия можно было бы переписать уже закрытую джобу.
    .eq('status', 'running');
  if (error) log('error', `Не смог закрыть зависшие start-джобы: ${error.message}`);
}

export async function resetStuckJobs() {
  const { data, error } = await db
    .from('tg_outreach_jobs')
    .select('id, action')
    .eq('status', 'running');

  // Ошибку запроса раньше игнорировали: `const { data } = ...`, и при сбое
  // связи data приходил null, условие ниже не выполнялось, функция молча
  // выходила. А зовут её ровно один раз, на старте процесса — второго шанса
  // нет. 18.08.2026 перезапуск в 21:20 совпал с морганием базы: пять start-джоб
  // остались `running`, авто-резюм каждые пять минут видел «старт уже
  // запланирован» и ничего не делал, и все кампании простояли 16 часов, показывая
  // в интерфейсе running. Молчать здесь нельзя.
  if (error) {
    log('error', `Не смог проверить зависшие джобы при старте: ${error.message}. Их подберёт периодический сторож сирот.`);
    return;
  }

  const rows = (data ?? []) as Array<{ id: string; action: string }>;
  if (!rows.length) return;

  const isStart = (action: string) => (START_ACTIONS as readonly string[]).includes(action);
  const startIds = rows.filter((r) => isStart(r.action)).map((r) => r.id);
  const controlIds = rows.filter((r) => !isStart(r.action)).map((r) => r.id);

  // Control-джобы (стоп/рестарт/refetch) — прямое действие человека, его
  // терять нельзя: если оператор нажал «Стоп» перед падением процесса,
  // кампанию надо остановить, а не забыть об этом.
  if (controlIds.length) {
    log('info', `Возвращаю в очередь ${controlIds.length} зависших control-джоб`);
    const { error: updErr } = await db
      .from('tg_outreach_jobs')
      .update({ status: 'pending', error_message: null, started_at: null, finished_at: null })
      .in('id', controlIds)
      .eq('status', 'running');
    if (updErr) {
      log('error', `Не смог сбросить зависшие control-джобы: ${updErr.message}. Их подберёт периодический сторож сирот.`);
    }
  }

  if (startIds.length) {
    log('info', `Закрываю ${startIds.length} зависших start-джоб — перезапуск решит авто-резюм по статусу кампании`);
    await closeStuckStartJobs(startIds, 'Зависшая start-джоба от прошлого процесса: закрыта при старте воркера');
  }
}

/**
 * Сколько ждать, прежде чем считать `running` start-джобу сиротой.
 *
 * Между claimJob (статус → running) и регистрацией кампании в runningCampaigns
 * проходит несколько асинхронных шагов: чтение кампании, старт трейса, апдейт
 * trace_spans. Тик, попавший в это окно, увидел бы живую джобу без кампании в
 * памяти. Секунды против двух минут — запас с избытком.
 */
const ORPHAN_START_JOB_GRACE_MS = 2 * 60_000;

// Control-джобы (stop/restart/refetch_messages) не занимают слот в
// runningCampaigns и должны подхватываться независимо от concurrency-limit —
// иначе оператор жмёт «Стоп», но при 5/5 занятых слотах джоб живёт в pending
// до истечения (см. resumeRunningCampaigns:249 — auto-completes stale через
// 5 мин). Инцидент 29.07.2026: 5 running кампаний → 4 стоп-клика подряд ушли
// в stale, кампании продолжали работать.
export const CONTROL_ACTIONS = ['stop', 'restart', 'refetch_messages', 'warmup_stop'] as const;
export const START_ACTIONS = ['start', 'warmup_start'] as const;

/**
 * Периодический сторож сирот — вторая линия к resetStuckJobs.
 *
 * Start-джоба помечается completed только в `.finally()` цикла кампании, то есть
 * `running` означает «цикл этой кампании жив в этом процессе». Если процесс
 * убили на середине, finally не выполнится и джоба останется `running` навсегда,
 * а resumeRunningCampaigns будет считать, что старт уже запланирован, и не
 * поставит новый. Кампания при этом висит в базе как running — снаружи всё
 * зелёное, а работы нет.
 *
 * Сирота определяется точно: джоба `running`, а её кампании нет среди живых в
 * памяти процесса. У живой джобы кампания в runningCampaigns есть всегда, так
 * что перепутать нельзя. warmup_start остаётся в списке для порядка: после
 * переезда прогрева на аренду она закрывается сразу при получении и осиротеть
 * физически не может, но выпасть из сторожа она не должна на случай команды,
 * оставшейся от старого контейнера.
 *
 * Сирота ЗАКРЫВАЕТСЯ, а не возвращается в pending: claimJob/handleStartJob
 * статус кампании не проверяют, и возвращённая в очередь джоба воскрешала бы
 * остановленную оператором кампанию (аудит 20.08). Перезапуск решают
 * resumeRunningCampaigns/resumeWarmupRuns — они вызываются следующими в том же
 * тике и уже гейтеды по статусу кампании/прогрева.
 */
export async function reclaimOrphanedStartJobs() {
  const { data, error } = await db
    .from('tg_outreach_jobs')
    .select('id, campaign_id, started_at')
    .eq('status', 'running')
    .in('action', START_ACTIONS);

  if (error) {
    log('error', `Сторож сирот: не смог прочитать джобы — ${error.message}`);
    return;
  }

  const orphans = selectOrphanedStartJobs({
    jobs: (data ?? []) as StartJobRow[],
    liveCampaignIds: new Set(runningCampaigns.keys()),
    now: Date.now(),
    graceMs: ORPHAN_START_JOB_GRACE_MS,
  });

  if (!orphans.length) return;

  log(
    'error',
    `Сторож сирот: ${orphans.length} start-джоб висят в running, но их кампаний нет среди живых. ` +
      `Закрываю их — перезапуск решает авто-резюм по статусу кампании, иначе остановленная кампания воскресла бы сама.`,
  );
  await closeStuckStartJobs(
    orphans.map((j) => j.id),
    'Осиротевшая start-джоба: процесс умер, цикла кампании нет в живых',
  );
}

export async function claimJob(
  actionFilter?: readonly string[],
): Promise<{ id: string; campaign_id: string; action: string } | null> {
  let pendingQuery = db
    .from('tg_outreach_jobs')
    .select('id, campaign_id, action')
    .eq('status', 'pending');
  if (actionFilter && actionFilter.length > 0) {
    pendingQuery = pendingQuery.in('action', actionFilter as unknown as string[]);
  }
  const { data: pending } = await pendingQuery
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await db
    .from('tg_outreach_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, campaign_id, action')
    .maybeSingle();

  return claimed ?? null;
}

async function handleStartJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  if (runningCampaigns.has(campaignId)) {
    if (shouldStop()) {
      log('info', `Campaign ${campaignId} already running and worker is shutting down — re-queueing job for next worker`);
      await db.from('tg_outreach_jobs').update({ status: 'pending', started_at: null }).eq('id', job.id);
    } else {
      log('warn', `Campaign ${campaignId} already running, skipping start`);
      await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
    }
    return;
  }

  let stopRequested = false;
  const stopFn = () => { stopRequested = true; };

  const { data: campaign } = await db
    .from('tg_outreach_campaigns')
    .select('name, user_id, status')
    .eq('id', campaignId)
    .single();

  /*
   * Кампанию греют — боевой цикл на ней запускать нельзя.
   *
   * Раньше это держал слот в runningCampaigns: прогрев занимал его, и старт
   * просто не проходил проверку выше. С переездом прогрева на аренду слота у
   * него больше нет, и без этой проверки залежавшаяся команда «старт» (её мог
   * положить скрипт остановки деплоя ещё до запуска прогрева) увела бы
   * греющуюся кампанию в боевой цикл: runCampaignLoop на входе безусловно
   * пишет status='running', и те же аккаунты одновременно пошли бы и в
   * прогрев, и к клиентам.
   *
   * ЭТА ПРОВЕРКА ПОСТОЯННАЯ, НЕ ВРЕМЕННАЯ — не удалять после задачи 4. Да,
   * раннер боевых кампаний не увидит строку в статусе `warming` и тем закроет
   * захват. Но `tg_outreach_jobs` задачу 4 переживает: команды «старт» и
   * «стоп» остаются каналом воли оператора, а команда — это не захват. Пока
   * существует путь «пришла команда старт → запускаем цикл», ему нужен свой
   * замок, и вот он.
   */
  if (campaign?.status === 'warming') {
    log('warn', `Campaign ${campaignId} is warming up — start ignored`);
    await db
      .from('tg_outreach_jobs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        error_message: 'Кампания на прогреве: боевой аутрич не запускается, пока идёт прогрев',
      })
      .eq('id', job.id);
    return;
  }

  const trace = await startTrace({
    name: 'tg-outreach.campaign.run',
    input: {
      campaignId,
      campaignName: campaign?.name,
      route: 'tg_outreach_worker',
      userId: campaign?.user_id,
    },
    message: `TG Аутрич: ${campaign?.name ?? campaignId}`,
    userId: campaign?.user_id ?? null,
  });

  const requestId = trace?.traceId ?? crypto.randomUUID();
  if (trace) {
    await db
      .from('trace_spans')
      .update({ input: { campaignId, campaignName: campaign?.name, requestId, route: 'tg_outreach_worker', userId: campaign?.user_id } })
      .eq('id', trace.id);
  }

  const traceContext = trace ? { requestId } : undefined;

  campaignLastProgressAt.set(campaignId, Date.now());
  const onProgress = () => { campaignLastProgressAt.set(campaignId, Date.now()); };

  const control: LoopControl = {};
  campaignControls.set(campaignId, control);

  const promise = runCampaignLoop(campaignId, db, () => shouldStop() || stopRequested, traceContext, onProgress, control)
    .then(() => {
      log('info', `Campaign ${campaignId} loop finished`);
      void trace?.end({ status: 'stopped' });
    })
    .catch((err) => {
      log('error', `Campaign ${campaignId} loop error: ${err instanceof Error ? err.message : String(err)}`);
      db.from('tg_outreach_campaigns').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', campaignId).then(({ error }) => {
        if (error) log('error', `Failed to mark tg campaign ${campaignId} as error: ${error.message}`);
      }, () => {});
      void trace?.fail(err);
    })
    .finally(() => {
      forgetCampaign(campaignId);
      db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id).then(({ error }) => {
        if (error) log('error', `Failed to mark tg job ${job.id} as completed: ${error.message}`);
      }, () => {});
    });

  runningCampaigns.set(campaignId, { stop: stopFn, promise });
  log('info', `Started campaign ${campaignId}`);
}

async function handleStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;
  const running = runningCampaigns.get(campaignId);

  if (running) {
    await db
      .from('tg_outreach_campaigns')
      .update({ status: 'stopped', updated_at: new Date().toISOString() })
      .eq('id', campaignId);
    running.stop();
    log('info', `Signaled stop for campaign ${campaignId}`);
    await running.promise;
  } else {
    await db.from('tg_outreach_campaigns').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', campaignId);
  }

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function handleRestartJob(job: { id: string; campaign_id: string }) {
  await handleStopJob(job);
  await handleStartJob(job);
}

async function handleRefetchJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;
  log('info', `Refetch messages for campaign ${campaignId}`);

  try {
    await refetchEmptyDialogs(campaignId, db, undefined, async (p) => {
      await db.from('tg_outreach_jobs').update({ progress: p }).eq('id', job.id);
    });
    await db.from('tg_outreach_jobs').update({
      status: 'completed',
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('error', `Refetch failed for ${campaignId}: ${errMsg}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: errMsg,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

/**
 * Прогрев на едином жизненном цикле задач (lib/jobs/lifecycle.ts).
 *
 * Единица работы — СТРОКА ПРОГОНА `tg_outreach_warmup_runs`, а не команда в
 * очереди: прогон идёт четверо суток, его состояние намеренно живёт в базе
 * (день считается от started_at, у каждой переписки свой статус, сообщения
 * пишутся по ходу), и он заведомо переживает процесс. Раньше это выражалось
 * командой «warmup_start», которая висела в статусе «выполняется» всё время
 * прогона и требовала отдельных сторожей — сироты, возобновление при старте,
 * закрытие зависших. Теперь брошенный прогон — это истёкшая аренда, и ничего
 * больше.
 *
 * Взаимное исключение с боевым аутричем держит не карта в памяти, а статус
 * кампании: греющаяся стоит в `warming`, боевая — в `running`. Развёрнуто — в
 * комментарии к проверке в lib/tgOutreach/warmup/loop.ts.
 */
const warmupRunner = createJobRunner<{ id: string; campaign_id: string }, WarmupCheckpoint>({
  table: 'tg_outreach_warmup_runs',
  workerId: WORKER_ID,
  // Статусы — из check-констрейнта таблицы (20260803_0006):
  // pending / running / finished / stopped / failed. Терминал успеха здесь
  // называется `finished`, а не `done`.
  statuses: { pending: 'pending', running: 'running', done: 'finished', failed: 'failed' },
  leaseSeconds: WARMUP_LEASE_SECONDS,
  concurrency: WARMUP_MAX_CONCURRENCY,
  /*
   * Бюджет потерь — десять, а не три по умолчанию.
   *
   * Дефолт рассчитан на задачу, которая идёт минуты и после каждого шага
   * пишет чекпойнт. Прогон идёт ЧЕТВЕРО СУТОК, а чекпойнты у него привязаны к
   * событиям, а не к часам: их пишет каждая переписка и смена дня. Ночью
   * (sleep_periods, по умолчанию 00:00-08:00) переписок нет вовсе — то есть
   * восемь часов подряд ни одного чекпойнта, и любая потеря в этом окне
   * копится в счётчик, ничем не обнуляясь. Три деплоя за такую ночь, три
   * жёстких остановки контейнера или три срабатывания сторожа простоя — и
   * прогон уходил бы в `failed` посреди третьего дня.
   *
   * Цена такой ошибки была не «переделать работу», а тупик: до правки
   * библиотечный `failed` не возвращал кампанию из статуса `warming`, и она
   * переставала принимать и запуск, и остановку, и удаление прогрева — все три
   * маршрута отвечали 409. Тупик закрыт с двух сторон: releaseCampaignsStuck
   * InWarming ниже расклинивает кампанию, а этот бюджет делает саму ситуацию
   * редкой. Десять — это заведомо больше, чем деплоев и рестартов бывает за
   * одну ночь, и всё ещё конечное число: безнадёжно битый прогон, падающий
   * сразу после захвата, остановится, а не будет крутиться вечно.
   */
  maxAttempts: 10,
  // Итог пишет тело: только оно умеет отличить «прогрев доиграл все дни» от
  // «подключились не все аккаунты» и собрать сводку по аккаунтам в summary.
  manageTerminalStatus: false,
  select: 'campaign_id',
  /*
   * claimPatch НЕТ, и это важно. Единственная отметка «когда началось» в этой
   * таблице — started_at, но она не диагностическая: от неё считается ДЕНЬ
   * ПРОГРЕВА (dayNumber в warmup/loop.ts). Проставить её на каждом захвате
   * значило бы откатывать прогрев в первый день при каждом перехвате строки —
   * четырёхдневный прогон никогда бы не закончился, а нагрузка навсегда
   * осталась бы на уровне первого дня. Первую установку делает само тело, и
   * ровно один раз, при пустом started_at.
   */
  /*
   * progress НЕ подключаем — сознательно, и вот арифметика.
   *
   * Кандидат в этой таблице ровно один — current_day, и он двигается раз в
   * сутки: как детектор зависания это бесполезно (порог пришлось бы ставить
   * больше суток). Других скалярных колонок, которые двигались бы по ходу
   * работы, у строки прогона нет: счётчики переписок и сообщений живут в
   * tg_outreach_warmup_conversations, отдельными строками, а checkpoint —
   * jsonb, и библиотека такие колонки прямо запрещает (сравнение по !== на
   * каждый раз новом объекте всегда даёт «движение» и молча выключает и
   * детектор простоя, и предел попыток).
   *
   * Даже будь такая колонка, порога не существует. Снизу его ограничивает
   * самый длинный ЗАКОННЫЙ простой прогрева, а он огромен по устройству:
   *  - ночью аккаунты молчат — sleep_periods по умолчанию «00:00-08:00», то
   *    есть 8 часов подряд без единой переписки;
   *  - переписки дня раскиданы случайно по активному окну (16 часов), а в
   *    первый день их всего 2 на аккаунт: между двумя соседними законно
   *    проходят часы.
   * Порог обязан быть больше 8 часов. Сверху его никто не ограничивает
   * жёстко: JobMonitorSpec для tg_outreach_warmup_runs в
   * services/health-check/main.py НЕТ (проверено — в списке спецификаций этой
   * таблицы нет вовсе, а tg_outreach_campaigns попадает только в счётчик
   * количества, без обнаружения зависаний). Значит верхняя граница — суждение,
   * и суждение такое: смысл детектор имеет, только если срабатывает быстрее,
   * чем человек сам увидит остановившийся прогрев на вкладке «Прогрев», то
   * есть в пределах суток. Порога, который одновременно больше 8 часов и
   * заметно меньше 24, нет.
   *
   * Что защищает вместо progress: мёртвый процесс аренду не продлевает —
   * прогон подберут через ≤ WARMUP_LEASE_SECONDS; зависшее тело в живом
   * процессе отдаёт строку на ближайшем деплое, когда shutdown() обнулит
   * аренду; а собственный сторож воркера продолжает следить за прогревом по
   * отметкам onProgress ровно как раньше.
   */
  /*
   * Весь бюджет остановки: 10 секунд.
   *
   * Бюджет. Деплой останавливает контейнер `docker compose stop --timeout 15`,
   * то есть до SIGKILL пятнадцать секунд. В эти десять библиотека укладывает
   * два прохода освобождения аренды с паузой в секунду и контрольное чтение
   * (около трёх), остаток — около семи — достаётся телу. Телу на выход нужно
   * заметно меньше: паузы рвутся сигналом (abortableSleep, interruptibleSleep
   * с шагом 2 с), сетевые вызовы — тоже, а дальше остаётся сохранить ключи
   * сессий и закрыть до дюжины клиентов gramJS. Пять секунд деплоя остаются в
   * резерве.
   *
   * Чего эти секунды НЕ дают: аренду библиотека отпускает ДО ожидания тела, то
   * есть в эти секунды строка формально свободна, а клиенты Telegram ещё живы.
   * Порядок «сначала закрыть клиенты, потом отпустить аренду» библиотека теперь
   * умеет — это опция beforeRelease, — но прогрев её намеренно НЕ включает:
   * контейнер tg-outreach на проде один, деплой сначала останавливает старый и
   * только потом поднимает новый, а хук означал бы разрыв сокетов на каждом
   * деплое вместо аккуратного выхода цикла. Боевому аутричу с его дюжиной
   * сессий на кампанию она нужна по-настоящему — там её и включает задача 4,
   * замерив реальное время закрытия клиентов.
   */
  shutdownGraceMs: 10_000,
  failedPatch: (reason) => ({ error_message: reason, finished_at: new Date().toISOString() }),
  log,
  run: async (job, ctx) => {
    const campaignId = job.campaign_id;
    log('info', `Starting warmup run ${job.id} for campaign ${campaignId}`);

    // Сторож простоя воркера следит за прогревом ровно как за кампанией:
    // ключом остаётся campaign_id, потому что forceDisconnect и stop() у него
    // тоже по кампании.
    campaignLastProgressAt.set(campaignId, Date.now());
    const onProgress = () => { campaignLastProgressAt.set(campaignId, Date.now()); };
    const control: LoopControl = {};
    campaignControls.set(campaignId, control);
    // Ручка сторожа: он гасит зависший прогрев теми же двумя движениями, что и
    // кампанию, — просит остановиться и рвёт сокеты. Выйдя, тело вернёт
    // управление раннеру, а аренду отпустит блок ниже, и прогон подберут
    // заново — это и есть замена прежнему «auto-resume поднимет».
    let stopRequested = false;
    warmupStops.set(campaignId, () => { stopRequested = true; });
    warmupWaitLogged.delete(job.id);

    try {
      await runWarmupLoop(
        campaignId,
        db,
        () => ctx.shouldStop() || stopRequested,
        onProgress,
        control,
        { runId: job.id, signal: ctx.signal, runToken: ctx.runToken, saveCheckpoint: ctx.saveCheckpoint },
      );
      log('info', `Warmup run ${job.id} (campaign ${campaignId}) returned`);

      /*
       * Прогрев вышел по требованию сторожа — аренду отпускаем сами, руками.
       *
       * Библиотека этого не сделает и не может: ctx.signal здесь НЕ взведён
       * (сторож — наш локальный механизм, а не остановка процесса и не потеря
       * аренды), поэтому она идёт успешным путём, а снятие владения на нём
       * ограждено `status <> running` — строка осталась running, и запись не
       * находит ни одной строки. Результат без этого блока: продление уже
       * остановлено, а lease_until стоит в будущем, то есть до полной аренды
       * мёртвого времени, после которого перехват видит НЕПУСТУЮ аренду,
       * считает её потерянной и списывает попытку. Ровно те попытки, из-за
       * которых прогон и уходил в тупик (см. maxAttempts выше).
       *
       * Обнуление аренды — то же самое, что делает shutdown() при штатной
       * передаче: строка сразу свободна, а потерей не считается. Ограждаем
       * жетоном и статусом, чтобы не тронуть строку, которую тем временем
       * закрыло само тело (finished/failed) или перехватил сосед.
       */
      if (stopRequested && !ctx.signal.aborted) {
        const { error } = await db
          .from('tg_outreach_warmup_runs')
          .update({ lease_until: null })
          .eq('id', job.id)
          .eq('status', 'running')
          .eq('run_token', ctx.runToken);
        if (error) {
          log('error', `Не смог отпустить аренду прогона ${job.id} после остановки сторожем: ${error.message}`);
        } else {
          log('info', `Warmup run ${job.id} stopped by watchdog — lease released for immediate reclaim`);
        }
      }
    } catch (err) {
      // Терминальный статус пишет тело — в том числе на отказе, иначе прогон
      // остался бы в running до истечения аренды и был бы перехвачен как
      // падение. На остановке статус не трогаем: строка либо уже не наша, либо
      // отдаётся соседу, и ограждение по жетону такую запись не пропустит.
      if (ctx.signal.aborted) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      log('error', `Warmup run ${job.id} (campaign ${campaignId}) crashed: ${errMsg}`);
      await db
        .from('tg_outreach_warmup_runs')
        .update({
          status: 'failed',
          error_message: errMsg.slice(0, 500),
          finished_at: new Date().toISOString(),
          // Владение снимаем вместе со статусом — как это делает библиотека в
          // своей терминальной записи (clearOwnership в lib/jobs/lifecycle.ts).
          lease_until: null,
          run_token: null,
          worker_id: null,
        })
        .eq('id', job.id)
        .eq('run_token', ctx.runToken);
      // Иначе кампания застрянет в статусе «прогрев», из которого нельзя
      // запустить аутрич.
      await db
        .from('tg_outreach_campaigns')
        .update({ status: 'stopped', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('status', 'warming');
    } finally {
      warmupStops.delete(campaignId);
      campaignLastProgressAt.delete(campaignId);
      campaignControls.delete(campaignId);
      campaignKillRequestedAt.delete(campaignId);
    }
  },
});

/**
 * Команда «запустить прогрев» — теперь только подтверждение.
 *
 * Работу запускает не она, а сама строка прогона: интерфейс создаёт её в
 * статусе `pending`, и раннер выше подхватывает её на ближайшем опросе (а
 * realtime будит опрос сразу). Команду закрываем немедленно, чтобы она не
 * висела в «выполняется» и не путала ни сторожа сирот, ни человека.
 */
async function handleWarmupStartJob(job: { id: string; campaign_id: string }) {
  log('info', `Warmup start requested for campaign ${job.campaign_id} — прогон подхватит раннер аренды`);
  await db
    .from('tg_outreach_jobs')
    .update({ status: 'completed', finished_at: new Date().toISOString() })
    .eq('id', job.id);
}

async function handleWarmupStopJob(job: { id: string; campaign_id: string }) {
  const campaignId = job.campaign_id;

  /*
   * Остановка — это запись в строку прогона, а не сигнал в память процесса.
   *
   * Владение снимаем тем же движением, что и статус: строка перестаёт быть
   * арендованной, и любая запоздалая запись уходящего тела не пройдёт
   * ограждение по жетону. Исполнитель узнает об остановке двумя путями сразу —
   * его продление аренды перестанет находить строку в `running` (≤ треть
   * аренды, 60 с) и цикл перечитает активный прогон на ближайшем круге
   * (≤ 60 с). Ждать конца цикла здесь, как раньше, больше нельзя и не нужно:
   * тело может идти в другой реплике.
   */
  await db
    .from('tg_outreach_warmup_runs')
    .update({
      status: 'stopped',
      finished_at: new Date().toISOString(),
      lease_until: null,
      run_token: null,
      worker_id: null,
    })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'running']);
  log('info', `Warmup stop recorded for campaign ${campaignId}`);

  // Возвращаем кампанию в «остановлена»: прогрев кончился, аутрич снова можно
  // запустить. Условие на warming — чтобы не затереть статус, если кампанию
  // тем временем уже перевели во что-то другое.
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('status', 'warming');

  await db.from('tg_outreach_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', job.id);
}

async function dispatchJob(job: { id: string; campaign_id: string; action: string }): Promise<void> {
  log('info', `Claimed job ${job.id}: ${job.action} for campaign ${job.campaign_id}`);
  try {
    switch (job.action) {
      case 'start':
        await handleStartJob(job);
        break;
      case 'stop':
        await handleStopJob(job);
        break;
      case 'restart':
        await handleRestartJob(job);
        break;
      case 'refetch_messages':
        await handleRefetchJob(job);
        break;
      case 'warmup_start':
        await handleWarmupStartJob(job);
        break;
      case 'warmup_stop':
        await handleWarmupStopJob(job);
        break;
      default:
        log('warn', `Unknown action: ${job.action}`);
        await db.from('tg_outreach_jobs').update({
          status: 'failed',
          error_message: `Unknown action: ${job.action}`,
          finished_at: new Date().toISOString(),
        }).eq('id', job.id);
    }
  } catch (err) {
    log('error', `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('tg_outreach_jobs').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

/**
 * Сказать ожидающим прогонам, что они стоят в очереди за слотом.
 *
 * Без этой строки ожидание невидимо и выглядит поломкой: кнопка «Прогрев»
 * сразу переводит кампанию в статус «Прогрев», а работа не начинается — при
 * этом запуск аутрича и остановка кампании в этом статусе отвечают 409. Человек
 * видит замерший экран и никакого объяснения. Пишем в журнал самого прогона,
 * то есть ровно туда, куда оператор и смотрит, — на вкладку «Прогрев».
 */
async function logWarmupRunsWaitingForSlot(active: number): Promise<void> {
  const { data, error } = await db
    .from('tg_outreach_warmup_runs')
    .select('id, campaign_id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5);
  if (error || !data?.length) return;

  for (const run of data as Array<{ id: string; campaign_id: string }>) {
    if (warmupWaitLogged.has(run.id)) continue;
    warmupWaitLogged.add(run.id);
    await db.from('tg_outreach_warmup_logs').insert({
      run_id: run.id,
      campaign_id: run.campaign_id,
      level: 'info',
      message:
        `Прогрев в очереди: сейчас идёт ${active} из ${WARMUP_MAX_CONCURRENCY} одновременных прогревов. ` +
        'Этот начнётся сам, как только освободится место — останавливать и запускать заново не нужно.',
    });
  }
}

async function pollJobsOnce(): Promise<boolean> {
  // Всегда сначала пытаемся подхватить control-джобы (stop/restart/refetch):
  // они не занимают слот в runningCampaigns, а stop даже освобождает его.
  // Если ждать освобождения concurrency-slot'а перед стопом — оператор
  // не может выключить ничего, когда все слоты заняты.
  const controlJob = await claimJob(CONTROL_ACTIONS);
  if (controlJob) {
    await dispatchJob(controlJob);
    return true;
  }

  if (runningCampaigns.size >= _MAX_CONCURRENCY) {
    log(
      'info',
      `Max concurrent campaigns reached (${runningCampaigns.size}/${_MAX_CONCURRENCY}), waiting for free slot`,
    );
    return false;
  }

  const startJob = await claimJob(START_ACTIONS);
  if (!startJob) return false;

  await dispatchJob(startJob);
  return true;
}

export async function pollOnce(): Promise<boolean> {
  const claimedJob = await pollJobsOnce();

  /*
   * Прогрев опрашивается своей очередью и своим пределом параллелизма: общий
   * пул слотов боевых кампаний ему больше не нужен.
   *
   * Занятый слот проверяем ДО обращения к раннеру, а не полагаемся на его
   * внутреннюю проверку. Она при занятых слотах отвечает «зови снова» после
   * паузы в 500 мс, а pollLoop на такой ответ свой интервал не выжидает — круг
   * замкнулся бы сразу, и все четверо суток прогрева воркер стучал бы в базу
   * по два запроса за полсекунды (та же яма, что разобрана в
   * worker/salesChatLogger.ts). Пока слот занят, брать нечего, и честный ответ
   * «нет работы» отправляет цикл спать до realtime или до 30-секундного
   * запасного тика.
   */
  const warmupActive = warmupRunner.activeJobIds().length;
  const warmupBusy = warmupActive >= WARMUP_MAX_CONCURRENCY;
  if (warmupBusy) {
    // Тот же запрос, что сделал бы захват, но с честным ответом человеку
    // вместо молчания. Идёт раз в 30 секунд (опрос спит на fallback-тике), и
    // пишет в журнал один раз на прогон.
    await logWarmupRunsWaitingForSlot(warmupActive);
  }
  const claimedWarmup = warmupBusy ? false : await warmupRunner.pollOnce();

  return claimedJob || claimedWarmup;
}

export async function resumeRunningCampaigns() {
  // On worker boot, also rescue campaigns stuck in `error` from previous runs
  // (e.g. transient DB/proxy/network outages that flipped status to error and
  // then got cleared, but nothing brought the campaigns back).
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('status', 'error');

  const { data: running } = await db
    .from('tg_outreach_campaigns')
    .select('id, user_id')
    .in('status', ['running', 'paused']);

  if (!running?.length) return;

  const campaignIds = running.map(c => c.id);
  // During deploy drain/restart we can end up with stale stop/restart jobs
  // that would immediately kill auto-resumed campaigns on next worker boot.
  await db
    .from('tg_outreach_jobs')
    .update({
      status: 'completed',
      finished_at: new Date().toISOString(),
      error_message: 'Auto-completed stale stop/restart job during worker resume',
    })
    .in('campaign_id', campaignIds)
    .in('action', ['stop', 'restart'])
    .in('status', ['pending', 'running']);

  log('info', `Found ${running.length} campaigns with status running/paused, scheduling auto-resume`);
  for (const campaign of running) {
    // There may already be duplicate active start jobs left by an older
    // worker/deploy race. Limit the existence check to one row: maybeSingle()
    // returns an error (and null data) when multiple rows match, which used to
    // make this loop enqueue one more duplicate every five minutes.
    const { data: existingJob, error: existingJobError } = await db
      .from('tg_outreach_jobs')
      .select('id')
      .eq('campaign_id', campaign.id)
      .eq('action', 'start')
      .in('status', ['pending', 'running'])
      .limit(1)
      .maybeSingle();

    if (existingJobError) {
      throw new Error(
        `Failed to check active start job for campaign ${campaign.id}: ${existingJobError.message}`,
      );
    }

    if (!existingJob) {
      const { error: insertError } = await db.from('tg_outreach_jobs').insert({
        campaign_id: campaign.id,
        user_id: campaign.user_id ?? '00000000-0000-0000-0000-000000000000',
        action: 'start',
        status: 'pending',
      });

      // A partial unique index is the final race guard. A concurrent resume
      // check may win the insert after our existence check; that is already
      // the desired state, so treat only that conflict as benign.
      if (insertError?.code === '23505') {
        log('info', `Active start job already exists for campaign ${campaign.id}`);
        continue;
      }
      if (insertError) {
        throw new Error(
          `Failed to queue auto-resume for campaign ${campaign.id}: ${insertError.message}`,
        );
      }

      log('info', `Queued auto-resume start job for campaign ${campaign.id}`);
    }
  }

  // Обновляем paused → running, т.к. start job уже в очереди
  await db
    .from('tg_outreach_campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('status', 'paused');
}

/*
 * Возобновления прогревов при старте здесь БОЛЬШЕ НЕТ.
 *
 * Прежняя resumeWarmupRuns при каждом подъёме процесса (и раз в пять минут)
 * искала прогоны в pending/running и подкладывала им команду «warmup_start».
 * Ей на смену пришла аренда: брошенный прогон — это строка `running` с
 * истёкшим или обнулённым lease_until, и её подбирает обычный захват раннера,
 * работающий одинаково при любом числе реплик. Прежняя же схема опиралась на
 * «раз мы стартовали, значит прошлого исполнителя нет» — на второй реплике это
 * неправда, и она отобрала бы живой прогон.
 */

/**
 * Расклинить кампании, застрявшие в статусе «Прогрев» без живого прогона.
 *
 * Статус `warming` — это замок: пока он стоит, интерфейс отвечает 409 на всё
 * сразу. Запуск аутрича — «Кампания на прогреве», остановка кампании — «идёт
 * прогрев, останавливайте на вкладке Прогрев», остановка прогрева — «Активного
 * прогрева нет», потому что прогона в pending/running действительно уже нет.
 * Единственным выходом оставалось запустить новый прогрев, чтобы тут же его
 * остановить.
 *
 * Снять замок обязано всё, что закрывает прогон, — и тело прогрева это делает.
 * Но есть путь, на котором тела нет вовсе: библиотека сама пишет `failed`,
 * когда исполнитель терял прогон maxAttempts раз подряд. Она про кампанию не
 * знает и знать не должна — значит, ключ от замка нужен снаружи.
 *
 * Условие простое и не может задеть живое: у кампании статус `warming`, а
 * прогона в pending/running нет ни одного. Гонки с запуском нет — интерфейс
 * сначала создаёт строку прогона, и только потом ставит кампании `warming`.
 */
export async function releaseCampaignsStuckInWarming(): Promise<void> {
  const { data: warming, error } = await db
    .from('tg_outreach_campaigns')
    .select('id')
    .eq('status', 'warming');
  if (error) {
    log('error', `Не смог проверить кампании в статусе прогрева: ${error.message}`);
    return;
  }
  const ids = ((warming ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (!ids.length) return;

  const { data: activeRuns, error: runsError } = await db
    .from('tg_outreach_warmup_runs')
    .select('campaign_id')
    .in('campaign_id', ids)
    .in('status', ['pending', 'running']);
  if (runsError) {
    log('error', `Не смог проверить активные прогоны прогрева: ${runsError.message}`);
    return;
  }

  const alive = new Set(
    ((activeRuns ?? []) as Array<{ campaign_id: string }>).map((r) => r.campaign_id),
  );
  const stuck = ids.filter((id) => !alive.has(id));
  if (!stuck.length) return;

  log(
    'warn',
    `Кампании в статусе «Прогрев» без активного прогона: ${stuck.join(', ')}. Возвращаю в «остановлена» — иначе их нельзя ни запустить, ни остановить.`,
  );
  const { error: updError } = await db
    .from('tg_outreach_campaigns')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .in('id', stuck)
    // Ещё раз по статусу: между двумя запросами кампанию могли перевести
    // куда-то ещё, и затирать чужое решение нечем.
    .eq('status', 'warming');
  if (updError) {
    log('error', `Не смог расклинить кампании из статуса прогрева: ${updError.message}`);
  }
}

const RESUME_CHECK_INTERVAL_MS = 5 * 60_000;

async function main() {
  log('info', `TG Outreach worker starting... (прогрев: аренда ${WARMUP_LEASE_SECONDS}s, слотов ${WARMUP_MAX_CONCURRENCY})`);
  await resetStuckJobs();
  await resumeRunningCampaigns();
  await releaseCampaignsStuckInWarming();

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
      log('info', `${sig} received — releasing warmup lease for fast handoff`);
      void warmupRunner.shutdown().catch((err) => log('error', 'warmup shutdown failed', err));
    });
  }

  // Independent heartbeat ticker keeps the docker healthcheck green as long
  // as the Node event loop is alive. False unhealthy flips during long
  // anti-flood pauses are gone, but on its own this does NOT detect a stuck
  // campaign loop (the May 10 incident proved that). The watchdog below
  // covers that gap.
  writeHeartbeat();
  const heartbeatTimer = setInterval(() => writeHeartbeat(), 30_000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  /**
   * Кампании, признанные безнадёжно зависшими.
   *
   * Живут до конца жизни процесса и до тех пор, пока цикл кампании не уйдёт из
   * реестра сам (тогда карантин снимается в staleKillRequests). Набор мал по
   * определению — больше, чем кампаний в работе, в нём быть не может.
   */
  const campaignQuarantined = new Set<string>();

  // Watchdog: if any running campaign hasn't reported progress for longer
  // than WATCHDOG_THRESHOLD_MS, the loop is almost certainly frozen
  // (gramJS recvLoop stuck, infinite proxy reconnect, etc).
  const watchdogTimer = setInterval(() => {
    if (shouldStop()) return;
    const now = Date.now();
    const snapshot = {
      now,
      lastProgressAt: campaignLastProgressAt,
      killRequestedAt: campaignKillRequestedAt,
      // Прогревы входят в «живых» наравне с кампаниями: раньше они попадали
      // сюда через общий runningCampaigns, теперь — через свою карту. Без них
      // сторож дошёл бы только до первого шага (разрыв сокетов) и никогда не
      // довёл бы решение до конца: зависший прогрев не считался бы живым, и
      // ни карантин, ни падение процесса к нему не применились бы.
      running: new Set([...runningCampaigns.keys(), ...warmupStops.keys()]),
      quarantined: campaignQuarantined,
      stallMs: WATCHDOG_THRESHOLD_MS,
      graceMs: WATCHDOG_KILL_GRACE_MS,
    };

    for (const campaignId of staleKillRequests(snapshot)) {
      campaignKillRequestedAt.delete(campaignId);
      // Цикл размотался — кампания снова обычная, auto-resume поднимет её сам.
      if (campaignQuarantined.delete(campaignId)) {
        log('info', `Watchdog: campaign ${campaignId} finally unwound — карантин снят, кампания вернётся авто-резюмом.`);
      }
    }

    for (const { campaignId, action, stallMin } of planWatchdogActions(snapshot)) {
      if (action === 'quarantine') {
        /**
         * Кампанию не разбудить — изолируем и живём дальше.
         *
         * До 28.08.2026 здесь стоял process.exit(1), и одна зависшая кампания
         * уносила все остальные. В тот день TG_VBI зависала восемь раз, и
         * ATOL-1 из-за этого не успевал пройти круг: при паузе до десяти минут
         * между аккаунтами процесс не доживал до второго.
         *
         * Отправлять она ничего не будет: шаг `kill` уже выставил ей stop(),
         * и когда зависший await разомкнётся, цикл выйдет на первой проверке.
         * Двойника тоже не появится — её start-джоба осталась в `running`, а
         * auto-resume ставит новую только при отсутствии активной.
         *
         * Цена — один занятый слот из двенадцати до перезапуска воркера.
         */
        campaignQuarantined.add(campaignId);
        log(
          'error',
          `Watchdog: кампания ${campaignId} молчит ${stallMin} мин и пережила разрыв сокетов ` +
            `(${Math.round(WATCHDOG_KILL_GRACE_MS / 60_000)} мин). Изолирую её: остальные кампании продолжают работать. ` +
            'Кампания не отправит ничего и не поднимется сама — нужен перезапуск воркера в удобное время.',
        );
        continue;
      }

      if (action === 'exit') {
        log(
          'error',
          `Watchdog: все живые кампании зависли (последняя — ${campaignId}, молчит ${stallMin} мин). ` +
            'Работать некому, роняю процесс для перезапуска.',
        );
        process.exit(1);
      }

      // Гасим одну кампанию: просим остановиться и рвём её сокеты, чтобы
      // разбудить зависший await. Остальные кампании продолжают работать,
      // а эту поднимет auto-resume, когда цикл размотается.
      log(
        'error',
        `Watchdog: campaign ${campaignId} no progress for ${stallMin} min ` +
          `(threshold ${Math.round(WATCHDOG_THRESHOLD_MS / 60_000)} min). Stopping just this campaign.`,
      );
      campaignKillRequestedAt.set(campaignId, now);
      try {
        runningCampaigns.get(campaignId)?.stop();
        // Прогрев живёт не в runningCampaigns, а в своей карте — просим и его.
        warmupStops.get(campaignId)?.();
      } catch (err) {
        log('error', `Watchdog: stop() failed for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      void campaignControls
        .get(campaignId)
        ?.forceDisconnect?.()
        .catch((err: unknown) => {
          log(
            'error',
            `Watchdog: force-disconnect failed for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

  const resumeTimer = setInterval(() => {
    if (shouldStop()) return;
    // Сироты разбираются ПЕРЕД авто-резюмом: иначе тот увидит зависшую джобу,
    // решит, что старт уже запланирован, и снова ничего не сделает.
    reclaimOrphanedStartJobs()
      .catch((err) => log('error', `Сторож сирот упал: ${err instanceof Error ? err.message : String(err)}`))
      .then(() =>
        resumeRunningCampaigns().catch((err) =>
          log('error', `Periodic resume check failed: ${err instanceof Error ? err.message : String(err)}`),
        ),
      );
    // Брошенный прогон подбирает захват аренды на обычном опросе — своей
    // проверки ему не нужно. А вот замок `warming` снимать надо и на ходу:
    // библиотека пишет `failed` в работающем процессе, и ждать перезапуска
    // ради расклинивания кампании — это до следующего деплоя.
    releaseCampaignsStuckInWarming().catch((err) =>
      log('error', `Проверка застрявших в прогреве кампаний упала: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, RESUME_CHECK_INTERVAL_MS);

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    // Прогоны прогрева — вторая таблица-триггер: интерфейс создаёт строку в
    // `pending`, и опрос должен просыпаться на неё сразу, а не через 30 секунд.
    realtimeTables: ['tg_outreach_jobs', 'tg_outreach_warmup_runs'],
  });

  clearInterval(heartbeatTimer);
  clearInterval(watchdogTimer);
  clearInterval(resumeTimer);

  // Аренду прогрева отпускаем до ожидания кампаний: вызов идемпотентен и
  // возвращает тот же промис, что уже запустил обработчик сигнала.
  await warmupRunner.shutdown();

  log('info', 'Waiting for running campaigns to finish...');
  const promises = Array.from(runningCampaigns.values()).map(r => {
    r.stop();
    return r.promise;
  });
  await Promise.all(promises);

  log('info', 'TG Outreach worker stopped');
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
