/**
 * ENG: остановить то, что us-проект делает и будет делать сам.
 *
 * Два вызывающих:
 *  - 'client' — кнопка кабинета «Cancel all jobs»
 *    (api/client/eng/projects/[id]/cancel). Тело этого роута, вынесенное сюда
 *    без изменений: те же записи в том же порядке, тот же аудит
 *    'client.eng.cancelled', те же события журнала 'client.eng.cancel.*'.
 *    Сбой первой записи (автопилот) или записи джоб — отказ: функция
 *    возвращает `abort`, а 500 отвечает роут (как раньше, после этих шагов
 *    дальше ничего не пишется). Брошенная ошибка драйвера летит наверх, как и
 *    раньше из роута;
 *  - 'staff_block' — остановка ENG-аккаунта сотрудником (engAccountBlock:
 *    «Заблокировать» и «Разблокировать» до снятия бана): каждый us-проект
 *    аккаунта. Отличия от 'client':
 *      · пауза ночного добора НЕ пишется — это одна ячейка на проект, и
 *        «Возобновить ночной добор» сотрудника сняла бы её вместе с причиной;
 *        вместо неё «Daily top-up» выключается всегда (шаг 2);
 *      · уборка харвеста отменённых баз (dropCancelledBaseHarvest) НЕ идёт:
 *        она освобождает место, а не деньги, и тянет до 10,26 МБ на базу —
 *        её сделает следующая отмена проекта;
 *      · у каждого шага свой срок (`stepTimeoutMs`); срок не обрывает запрос —
 *        запись, пришедшая после срока, всё равно ляжет (все записи здесь
 *        идемпотентны и только останавливают), а шаг отчитывается как
 *        неудавшийся;
 *      · сбой шага не останавливает следующие: пробуются ВСЕ;
 *      · исследование возвращается в 'draft' условной записью по
 *        status = 'researching' (без предварительного чтения проекта);
 *      · ничего не бросает; аудита нет — отчёт пишет вызывающий.
 *
 * Записи — по порядку, и порядок несёт смысл:
 *  1. he_projects.autopilot = false. Без этого координатор воркера
 *     (autopilotNext, только при autopilot=true) после любой стадии, которая
 *     успеет закончиться, ставил бы следующую платную. Координатор и
 *     реконсилер перечитывают флаг ещё раз прямо перед каждой платной
 *     постановкой (isHeAutopilotStillOn), поэтому запись идёт ПЕРВОЙ.
 *     Включить обратно — «Launch» шага 3 (POST .../launch; старые вкладки —
 *     «Start outreach», POST .../autopilot); другого выключателя автопилота у
 *     кабинета нет. ТОЙ ЖЕ записью — he_projects.cancelled_at = момент
 *     отмены, долговечная отметка (projectCancelMarker.ts): отмена при нуле
 *     активных джоб не оставляет ни одной отменённой джобы, и без отметки по
 *     ней нельзя узнать, что базу, упавшую или осиротевшую ДО этого нажатия,
 *     поднимать нельзя. Её читают автоподъём (he_auto_resume_transient_bases,
 *     миграция 20261009_0002: база с updated_at <= cancelled_at не
 *     поднимается), ремонт осиротевшей сборки (baseCollectEnqueue) и
 *     автозапуск (отметка новее «Launch» — проект не запускается). Одна
 *     запись с флагом — чтобы «автопилот выключен, а отметки нет» не бывало.
 *     Колонки нет (миграция не применена) — та же запись без отметки
 *     (cancelMarker: 'unsupported').
 *  1b. Автозапуск проекта (he_eng_launch_intent, engAutoLaunch) — выключен:
 *     wanted=false, cancelled_at. Тик воркера и сам требует autopilot=true и
 *     отметку отмены не новее нажатия «Launch» (защита вдвое). Запуск, который
 *     тик уже взял к моменту отмены: отмена до ядра — ядро не зовётся (тик
 *     перечитывает автозапуск прямо перед ним), строка 'done cancelled';
 *     посреди ядра — ядро доводит (кампании создаются), но перед стартом тик
 *     перечитывает автозапуск (engAutoLaunch.heEngStartGate) и кампании не
 *     стартует — строка 'done cancelled', а конфиг ночного добора после такой
 *     попытки не заводится (engAutoLaunch.heEngTopUpGate); уже отправляющие
 *     кампании слушаются Pause. Включить снова — «Launch». Нет таблицы (миграция 20261012_0001)
 *     или сбой — отмену не валит, исход уходит в аудит.
 *  2. ('client') Пауза ночного добора — ТА ЖЕ, что ставит ёмкость рассыльщика
 *     (he_auto_pipeline_configs.refill_paused_at, причина «клиент отменил»,
 *     pauseHeRefillForClientCancel). Добор ведёт he_auto_pipeline_configs.enabled,
 *     а не autopilot, и без паузы следующая ночь снова покупала бы сборку и
 *     доливала в живую кампанию. Снимает её сам клиент переключателем «Daily
 *     top-up» дашборда (POST .../refill, switchHeUsRefill) или сотрудник
 *     кнопкой staff-инструмента. Нет конфига, нет колонок (миграция 20260930_0005), сбой
 *     — отмену не валит: исход уходит в аудит.
 *     Пишется ДО отмены джоб: ночной тик перечитывает паузу у самой постановки
 *     и сразу после неё, и джоба, вставленная после шага 3, на втором чтении
 *     уже видит паузу и отзывается (autoPipeline.ts, шаг 4-).
 *     ('staff_block') Вместо паузы — «Daily top-up» выключен тем же путём,
 *     что у клиента (switchHeUsRefill(false)), при каждом вызове. Включает
 *     его обратно сам клиент, через гейт платных шагов.
 *  3. pending/running джобы → 'cancelled' (идущую стадию обрывает наблюдатель
 *     воркера, а долив дополнительно перечитывает владение прямо перед каждым
 *     запросом к рассыльщику — stages/baseCollectRefill.ts). ('client') Сбой
 *     этой записи — отказ (500), хотя шаги 1–2 уже легли: повторное нажатие их
 *     не портит, обе записи идемпотентны.
 *  4. Базы 'collecting'/'analyzing' → 'failed' («Cancelled by user») — В ТОМ
 *     ЧИСЛЕ когда активных джоб ноль. Раньше ноль джоб давал 409 до этого шага,
 *     и база, застрявшая в 'collecting'/'analyzing' без джобы, не отменялась
 *     никогда: держала слот автосборки вертикали
 *     (he_bases_one_collecting_per_vertical) и висела «в работе».
 *  5. Платная работа баз ВНЕ he_jobs (stopCancelledBaseWork). ('client') —
 *     только когда запись шага 4 легла; ('staff_block') — всегда: её кандидаты
 *     — все отменённые базы проекта, и остановка повторяема. Сбой не валит
 *     отмену, он журналируется.
 *  6. ('client') Уборка харвеста отменённых баз (dropCancelledBaseHarvest) — при
 *     том же условии и так же fail-soft.
 *  7. Проект 'researching' → 'draft'. Кабинет такой research заново не
 *     запускает (повтор — только после технического сбоя, решение владельца
 *     10.10.2026; отмена — не сбой): запустить его снова может команда
 *     (staff-инструмент).
 *
 * НЕ ИМПОРТИРОВАТЬ этот модуль из autoPipeline.ts или engAutoLaunch.ts: он
 * импортирует их сам (круг импортов).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit, logError } from '@/lib/loggerServer';
import type { LogContext } from '@/lib/logger';
import { isValidUuid } from '@/lib/apiValidation';
import {
  pauseHeRefillForClientCancel,
  switchHeUsRefill,
  type HeClientCancelPauseOutcome,
  type HeUsRefillSwitchOutcome,
} from './autoPipeline';
import type { HeEngBlockProjectReport } from './engAccountBlockMarker';
import { cancelHeEngLaunchIntent } from './engAutoLaunch';
import { isHeMissingColumnError } from './projectCancelMarker';
import { stripTaskHarvest } from './projectDetail';

/** Причина в he_bases.error у базы, которую остановила отмена (клиентом или блокировкой). */
export const HE_ENG_CANCELLED_BASE_ERROR = 'Cancelled by user';

/** Срок одного шага в режиме 'staff_block' по умолчанию (мс). */
export const HE_ENG_PROJECT_STOP_STEP_TIMEOUT_MS = 5_000;

/**
 * Сколько отменённых баз чистит ОДИН запрос отмены (см. dropCancelledBaseHarvest).
 *
 * Уборка идёт ВНУТРИ пользовательского запроса, а весит она как данные, которые
 * читает: `collect_info` базы, отменённой посреди сборки, — до 10,26 МБ (лимит
 * кабинета 10 000 компаний, 4 задачи плана). У проекта с четырьмя такими базами
 * неограниченный проход тянул ≈41 МБ jsonb и столько же отправлял назад, а своего
 * срока у роута нет: на медленном канале клиент увидел бы отказ отмены, хотя сама
 * отмена уже записана (джобы и статусы пишутся ДО уборки).
 *
 * Две базы за вызов — это ≤20,5 МБ, причём читаются они по одной (см. ниже), то
 * есть разом в памяти лежит не больше одной. Кто добирает остальные: следующая
 * отмена этого же проекта — барьер уборки (`status='failed'` +
 * `error='Cancelled by user'`) держится вечно, и база остаётся её кандидатом,
 * пока харвест не снят. Ночного прохода, который делал бы это сам, в движке нет
 * (heAutoPipelineCron `collect_info` не трогает) — то есть база, до которой этот
 * вызов не дошёл, весит ровно столько же, сколько весила ДО волны 4b, и не больше.
 */
const CANCEL_HARVEST_CLEANUP_BASES = 2;

/**
 * Сколько отменённых баз проекта ОСМАТРИВАЕТСЯ за вызов (см. ниже, почему это
 * отдельное число от бюджета обрезки). Осмотр уже чистой базы — чтение 3,3 КБ;
 * двадцать пять таких — 82 КБ, и столько отменённых авто-баз у одного проекта
 * ещё не было: в вертикали одновременно собирается одна база
 * (he_bases_one_collecting_per_vertical).
 */
const CANCEL_HARVEST_SCAN_BASES = 25;

/**
 * Позиции задач плана сборки (`collect_info.tasks[i]`), у которых бывает
 * дочерняя джоба парсера (см. stopCancelledBaseWork). Её ставят только задачи
 * из ответа модели-планировщика, а их не больше четырёх (HeSourcePlanSchema,
 * `.max(4)`), и стоят они в начале списка: починка «нет каталога» и расширение
 * плана дописывают в конец только pdl-срезы, у которых дочерней джобы нет, а
 * проба среза заменяет каталожные задачи, порядка остальных не меняя. Весь
 * `collect_info->tasks` не читаем: до уборки ниже в нём лежит харвест задач —
 * до 10,26 МБ на базу.
 */
const CANCEL_CHILD_TASK_SLOTS = [0, 1, 2, 3] as const;

/** Поля отменённой базы, по которым останавливается её платная работа вне he_jobs. */
const CANCEL_BASE_WORK_SELECT = [
  'id',
  'bc_job_id:collect_info->construct->>bc_job_id',
  ...CANCEL_CHILD_TASK_SLOTS.flatMap((i) => [
    `task${i}_source:collect_info->tasks->${i}->>source`,
    `task${i}_child:collect_info->tasks->${i}->>child_job_id`,
  ]),
].join(', ');

/** Префикс событий журнала: у кнопки клиента — прежний, у блокировки — свой. */
const CLIENT_EVENT = 'client.eng.cancel';
const STAFF_BLOCK_EVENT = 'he.eng_block.project_stop';
const BASE_STOP_EVENT = 'he.eng_cancelled_base.stop';

/* ─────────────── Типы ─────────────── */

export type HeEngProjectStopBy = 'client' | 'staff_block';

export type HeEngProjectStopOptions =
  | {
      by: 'client';
      now: Date;
      /** Владелец проекта (клиент, который нажал) — для журнала и аудита. */
      userId: string;
      /** he_projects.status из проверки владения роутом (без второго чтения). */
      projectStatus: unknown;
    }
  | {
      by: 'staff_block';
      now: Date;
      /** Владелец проекта (блокируемый клиент) — для журнала. */
      userId: string;
      /** Сотрудник — для журнала. */
      staffUserId?: string | null;
      /** Срок одного шага; по умолчанию HE_ENG_PROJECT_STOP_STEP_TIMEOUT_MS. */
      stepTimeoutMs?: number;
    };

export type HeEngProjectStopStep = 'autopilot' | 'intent' | 'top_up' | 'jobs' | 'bases' | 'children' | 'research';

/** Остановка дочерних джоб отменённых баз (конструктор, Google Maps). */
export interface HeEngBaseChildrenStop {
  constructorJobs: number;
  mapsJobs: number;
  /** Чтение баз или одна из записей не удалась (или не уложилась в срок). */
  failed: boolean;
}

/**
 * Исход по шагам. 'not_run' — шаг не выполнялся: в режиме 'client' после
 * отказа (`abort`), а дочерние джобы и харвест — ещё и при сбое записи баз.
 */
export interface HeEngProjectStopResult {
  by: HeEngProjectStopBy;
  autopilot: 'off' | 'failed';
  /** Записана ли he_projects.cancelled_at (колонка миграции 20261009_0002). */
  cancelMarker: 'recorded' | 'unsupported';
  intent: 'ok' | 'no_intent' | 'missing' | 'error' | 'not_run';
  /** Пауза добора: только 'client'; у 'staff_block' — 'skipped'. */
  refillPause: HeClientCancelPauseOutcome | 'skipped' | 'not_run';
  /** «Daily top-up»: выключает только 'staff_block'; у 'client' — 'left' (не трогали). */
  topUp: HeUsRefillSwitchOutcome | 'left' | 'not_run';
  /** Сколько he_jobs отменено. */
  jobs: number | 'failed' | 'not_run';
  /** Сколько баз переведено в 'failed'. */
  bases: number | 'failed' | 'not_run';
  children: HeEngBaseChildrenStop | 'not_run';
  /** Уборка харвеста: только 'client' ('ran' — прошла, её сбои журналируются). */
  harvest: 'ran' | 'skipped' | 'not_run';
  research: 'stopped' | 'not_running' | 'failed' | 'not_run';
  /** Шаги 'staff_block', не уложившиеся в срок (они же 'failed'/'error'). */
  timedOut: HeEngProjectStopStep[];
  /** 'client': отказа не было. 'staff_block': все записи проекта легли. */
  ok: boolean;
  /** Только 'client': шаг, после сбоя которого роут отвечает 500, и его ошибка. */
  abort?: { step: 'autopilot' | 'jobs'; error: unknown };
}

type LogFn = (event: string, error: unknown, context?: LogContext) => Promise<void>;

/** Журнал без ожидания — в шагах со сроком запись лога не тратит срок шага. */
const logErrorNoWait: LogFn = async (event, error, context) => {
  void logError(event, error, context);
};

/* ─────────────── Вход ─────────────── */

/** Остановить работу проекта (см. шапку модуля: режимы и порядок). */
export async function stopHeEngProjectWork(
  db: SupabaseClient,
  projectId: string,
  opts: HeEngProjectStopOptions,
): Promise<HeEngProjectStopResult> {
  return opts.by === 'client'
    ? stopForClient(db, projectId, opts)
    : stopForStaffBlock(db, projectId, opts);
}

/* ─────────────── 'client' — тело роута «Cancel all jobs» ─────────────── */

async function stopForClient(
  db: SupabaseClient,
  projectId: string,
  opts: Extract<HeEngProjectStopOptions, { by: 'client' }>,
): Promise<HeEngProjectStopResult> {
  const { userId } = opts;
  const nowDate = opts.now;
  const now = nowDate.toISOString();
  const out: HeEngProjectStopResult = {
    by: 'client',
    autopilot: 'failed',
    cancelMarker: 'recorded',
    intent: 'not_run',
    refillPause: 'not_run',
    topUp: 'left',
    jobs: 'not_run',
    bases: 'not_run',
    children: 'not_run',
    harvest: 'not_run',
    research: 'not_run',
    timedOut: [],
    ok: false,
  };

  // 1. Автопилот — первым и вместе с отметкой отмены (почему — шапка модуля).
  let cancelMarker: 'recorded' | 'unsupported' = 'recorded';
  let { error: autopilotErr } = await db
    .from('he_projects')
    .update({ autopilot: false, cancelled_at: now, updated_at: now })
    .eq('id', projectId);
  if (autopilotErr && isHeMissingColumnError(autopilotErr)) {
    cancelMarker = 'unsupported';
    ({ error: autopilotErr } = await db
      .from('he_projects')
      .update({ autopilot: false, updated_at: now })
      .eq('id', projectId));
  }
  out.cancelMarker = cancelMarker;
  if (autopilotErr) {
    return { ...out, abort: { step: 'autopilot', error: autopilotErr } };
  }
  out.autopilot = 'off';

  // 1b. Автозапуск проекта. Не бросает; сбой — только в аудит.
  const autoLaunch = await cancelHeEngLaunchIntent(db, projectId, nowDate);
  out.intent = autoLaunch;
  if (autoLaunch === 'error') {
    await logError(`${CLIENT_EVENT}.auto_launch_failed`, new Error('launch intent not cancelled'), {
      userId,
      projectId,
    });
  }

  // 2. Ночной добор — та же пауза, что у ёмкости. Не бросает.
  const refillPause = await pauseHeRefillForClientCancel(db, projectId, { now: nowDate });
  out.refillPause = refillPause;
  if (refillPause === 'failed') {
    await logError(`${CLIENT_EVENT}.refill_pause_failed`, new Error('nightly refill pause not recorded'), {
      userId,
      projectId,
    });
  }

  // 3. Джобы.
  const { data: cancelledJobs, error: jobsErr } = await db
    .from('he_jobs')
    .update({ status: 'cancelled', finished_at: now, updated_at: now })
    .eq('project_id', projectId)
    .in('status', ['pending', 'running'])
    .select('id');
  if (jobsErr) {
    return { ...out, jobs: 'failed', abort: { step: 'jobs', error: jobsErr } };
  }
  const cancelled = (cancelledJobs ?? []).length;
  out.jobs = cancelled;

  // 4. Базы в работе — в failed, в том числе без джобы (см. шапку модуля):
  // иначе висят «в работе» вечно и держат слот автосборки вертикали.
  const { data: stoppedBases, error: basesErr } = await db
    .from('he_bases')
    .update({ status: 'failed', error: HE_ENG_CANCELLED_BASE_ERROR, updated_at: now })
    .eq('project_id', projectId)
    .in('status', ['collecting', 'analyzing'])
    .select('id');
  let baseWork: HeEngBaseChildrenStop = { constructorJobs: 0, mapsJobs: 0, failed: false };
  if (basesErr) {
    out.bases = 'failed';
    await logError(`${CLIENT_EVENT}.bases_failed`, basesErr, { userId, projectId });
  } else {
    out.bases = (stoppedBases ?? []).length;
    // 5. Сначала деньги (конструктор, парсер), потом объём (харвест).
    baseWork = await stopCancelledBaseWork(db, projectId, now, logError, CLIENT_EVENT, { userId, projectId });
    out.children = baseWork;
    // 6.
    await dropCancelledBaseHarvest(db, projectId, userId);
    out.harvest = 'ran';
  }

  // 7. Research-пайплайн отменён — заново его запускает только команда
  // (staff-инструмент): кабинет повторяет research лишь после технического сбоя.
  out.research = 'not_running';
  if (opts.projectStatus === 'researching') {
    const { error: updErr } = await db
      .from('he_projects')
      .update({ status: 'draft', error: null, updated_at: now })
      .eq('id', projectId);
    if (updErr) {
      out.research = 'failed';
      await logError(`${CLIENT_EVENT}.project_failed`, updErr, { userId, projectId });
    } else {
      out.research = 'stopped';
    }
  }

  void logAudit('client.eng.cancelled', 'ENG cabinet project jobs cancelled', {
    userId,
    projectId,
    cancelled,
    basesStopped: (stoppedBases ?? []).length,
    constructorJobsStopped: baseWork.constructorJobs,
    mapsJobsStopped: baseWork.mapsJobs,
    autopilotOff: true,
    cancelMarker,
    refillPause,
    autoLaunch,
  });

  out.ok = true;
  return out;
}

/* ─────────────── 'staff_block' — каждый шаг со сроком, все шаги ─────────────── */

const TIMED_OUT: unique symbol = Symbol('timed_out');

/**
 * Срок без обрыва: запрос продолжает жить и может лечь позже — для записей
 * остановки это безопасно (они идемпотентны), а шаг считается неудавшимся.
 */
function withStepTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function stopForStaffBlock(
  db: SupabaseClient,
  projectId: string,
  opts: Extract<HeEngProjectStopOptions, { by: 'staff_block' }>,
): Promise<HeEngProjectStopResult> {
  const now = opts.now.toISOString();
  const timeoutMs = Math.max(1, opts.stepTimeoutMs ?? HE_ENG_PROJECT_STOP_STEP_TIMEOUT_MS);
  const ctx: LogContext = { userId: opts.userId, projectId, staffUserId: opts.staffUserId ?? null };
  const timedOut: HeEngProjectStopStep[] = [];

  /** Шаг со сроком: брошенная ошибка и срок дают `fallback`; следующий шаг идёт всё равно. */
  const step = async <T>(name: HeEngProjectStopStep, fallback: T, work: () => Promise<T>): Promise<T> => {
    try {
      const res = await withStepTimeout(work(), timeoutMs);
      if (res === TIMED_OUT) {
        timedOut.push(name);
        void logError(`${STAFF_BLOCK_EVENT}.${name}_timeout`, new Error(`step ${name} exceeded ${timeoutMs} ms`), ctx);
        return fallback;
      }
      return res;
    } catch (e) {
      void logError(`${STAFF_BLOCK_EVENT}.${name}_threw`, e, ctx);
      return fallback;
    }
  };

  // 1. Автопилот + отметка отмены.
  const autopilot = await step(
    'autopilot',
    { state: 'failed' as 'off' | 'failed', marker: 'recorded' as 'recorded' | 'unsupported' },
    async () => {
      const res = await turnOffHeEngProjectAutopilot(db, projectId, now);
      if (res.state === 'failed') void logError(`${STAFF_BLOCK_EVENT}.autopilot_failed`, res.error, ctx);
      return { state: res.state, marker: res.marker };
    },
  );

  // 1b. Автозапуск.
  const intent = await step('intent', 'error' as Awaited<ReturnType<typeof cancelHeEngLaunchIntent>>, () =>
    cancelHeEngLaunchIntent(db, projectId, opts.now),
  );
  if (intent === 'error') void logError(`${STAFF_BLOCK_EVENT}.intent_failed`, new Error('launch intent not cancelled'), ctx);

  // 2. «Daily top-up» — выключен всегда (пауза добора не пишется — шапка модуля).
  const topUp = await step('top_up', 'failed' as HeUsRefillSwitchOutcome, async () => {
    const res = await switchHeUsRefill(db, projectId, false, { now: opts.now });
    if (res.outcome === 'failed') {
      void logError(`${STAFF_BLOCK_EVENT}.top_up_failed`, new Error(res.detail ?? 'daily top-up not turned off'), ctx);
    }
    return res.outcome;
  });

  // 3. Джобы.
  const jobs = await step('jobs', 'failed' as number | 'failed', async () => {
    const { data, error } = await db
      .from('he_jobs')
      .update({ status: 'cancelled', finished_at: now, updated_at: now })
      .eq('project_id', projectId)
      .in('status', ['pending', 'running'])
      .select('id');
    if (error) {
      void logError(`${STAFF_BLOCK_EVENT}.jobs_failed`, error, ctx);
      return 'failed' as const;
    }
    return (data ?? []).length;
  });

  // 4. Базы в работе.
  const bases = await step('bases', 'failed' as number | 'failed', async () => {
    const { data, error } = await db
      .from('he_bases')
      .update({ status: 'failed', error: HE_ENG_CANCELLED_BASE_ERROR, updated_at: now })
      .eq('project_id', projectId)
      .in('status', ['collecting', 'analyzing'])
      .select('id');
    if (error) {
      void logError(`${STAFF_BLOCK_EVENT}.bases_failed`, error, ctx);
      return 'failed' as const;
    }
    return (data ?? []).length;
  });

  // 5. Дочерние джобы отменённых баз — и при сбое шага 4 (кандидаты — все
  // отменённые базы проекта, запись повторяема).
  const children = await step(
    'children',
    { constructorJobs: 0, mapsJobs: 0, failed: true } as HeEngBaseChildrenStop,
    () => stopCancelledBaseWork(db, projectId, now, logErrorNoWait, STAFF_BLOCK_EVENT, ctx),
  );

  // 7. Исследование → 'draft' условной записью.
  const research = await step('research', 'failed' as 'stopped' | 'not_running' | 'failed', async () => {
    const { data, error } = await db
      .from('he_projects')
      .update({ status: 'draft', error: null, updated_at: now })
      .eq('id', projectId)
      .eq('status', 'researching')
      .select('id');
    if (error) {
      void logError(`${STAFF_BLOCK_EVENT}.research_failed`, error, ctx);
      return 'failed' as const;
    }
    return (data ?? []).length > 0 ? ('stopped' as const) : ('not_running' as const);
  });

  const ok =
    autopilot.state === 'off'
    && intent !== 'error'
    && (topUp === 'turned_off' || topUp === 'already_off' || topUp === 'unsupported')
    && typeof jobs === 'number'
    && typeof bases === 'number'
    && !children.failed
    && research !== 'failed';

  return {
    by: 'staff_block',
    autopilot: autopilot.state,
    cancelMarker: autopilot.marker,
    intent,
    refillPause: 'skipped',
    topUp,
    jobs,
    bases,
    children,
    harvest: 'skipped',
    research,
    timedOut,
    ok,
  };
}

/**
 * Шаг 1 режима 'staff_block' одной записью: autopilot=false и отметка отмены
 * cancelled_at = `nowIso` (колонки нет — та же запись без неё, marker
 * 'unsupported'). Брошенное летит наверх — шаг оборачивает вызов в свой срок.
 */
async function turnOffHeEngProjectAutopilot(
  db: SupabaseClient,
  projectId: string,
  nowIso: string,
): Promise<{ state: 'off'; marker: 'recorded' | 'unsupported' } | { state: 'failed'; marker: 'recorded' | 'unsupported'; error: unknown }> {
  let marker: 'recorded' | 'unsupported' = 'recorded';
  let { error } = await db
    .from('he_projects')
    .update({ autopilot: false, cancelled_at: nowIso, updated_at: nowIso })
    .eq('id', projectId);
  if (error && isHeMissingColumnError(error)) {
    marker = 'unsupported';
    ({ error } = await db.from('he_projects').update({ autopilot: false, updated_at: nowIso }).eq('id', projectId));
  }
  return error ? { state: 'failed', marker, error } : { state: 'off', marker };
}

/**
 * Строка отчёта остановки по исходу 'staff_block' (HeEngBlockProjectReport из
 * engAccountBlockMarker): «нет автозапуска» и «нет таблицы автозапуска» —
 * 'none'; любой исход переключателя, кроме «выключен» / «уже был» / «таблицы
 * нет», — 'failed'.
 */
export function heEngBlockProjectReportOf(
  result: HeEngProjectStopResult,
  website: string | null,
  projectId: string,
): HeEngBlockProjectReport {
  const intent: HeEngBlockProjectReport['intent'] =
    result.intent === 'ok' ? 'cancelled' : result.intent === 'no_intent' || result.intent === 'missing' ? 'none' : 'failed';
  const topUp: HeEngBlockProjectReport['top_up'] =
    result.topUp === 'turned_off' || result.topUp === 'already_off' || result.topUp === 'unsupported' ? result.topUp : 'failed';
  const children: HeEngBlockProjectReport['children'] =
    result.children === 'not_run' || result.children.failed
      ? 'failed'
      : result.children.constructorJobs + result.children.mapsJobs;
  return {
    project_id: projectId,
    website,
    autopilot: result.autopilot,
    intent,
    top_up: topUp,
    jobs: typeof result.jobs === 'number' ? result.jobs : 'failed',
    bases: typeof result.bases === 'number' ? result.bases : 'failed',
    children,
    research: result.research === 'not_run' ? 'failed' : result.research,
    ok: result.ok,
  };
}

/* ─────────────── Одна база (страж воркера) ─────────────── */

export interface HeEngCancelledBaseWorkStop extends HeEngBaseChildrenStop {
  /**
   * 'cancelled' — база отменена, её дочерние джобы остановлены (см. counts);
   * 'not_cancelled' — база не авто-база в 'failed' с текстом отмены (или её
   * нет): ничего не тронуто; 'failed' — чтение базы не удалось или не уложилось
   * в срок.
   */
  base: 'cancelled' | 'not_cancelled' | 'failed';
}

/**
 * Остановить дочерние джобы (конструктор, Google Maps) ОДНОЙ базы, которую уже
 * закрыла отмена: авто-база в 'failed' с текстом HE_ENG_CANCELLED_BASE_ERROR —
 * тот же барьер, что у отмены проекта; живую базу не трогает. Для стража
 * воркера: сначала он закрывает базу как отмену, потом зовёт это. Весь вызов —
 * не дольше HE_ENG_PROJECT_STOP_STEP_TIMEOUT_MS. НЕ БРОСАЕТ.
 */
export async function stopHeBaseWorkForCancelledBase(
  db: SupabaseClient,
  baseId: string,
  now: Date,
): Promise<HeEngCancelledBaseWorkStop> {
  const nowIso = now.toISOString();
  const failed: HeEngCancelledBaseWorkStop = { base: 'failed', constructorJobs: 0, mapsJobs: 0, failed: true };
  const ctx: LogContext = { baseId };
  try {
    const res = await withStepTimeout(
      (async (): Promise<HeEngCancelledBaseWorkStop> => {
        const { data, error } = await db
          .from('he_bases')
          .select(CANCEL_BASE_WORK_SELECT)
          .eq('id', baseId)
          .eq('source', 'auto')
          .eq('status', 'failed')
          .eq('error', HE_ENG_CANCELLED_BASE_ERROR)
          .maybeSingle();
        if (error) {
          void logError(`${BASE_STOP_EVENT}.read_failed`, error, ctx);
          return failed;
        }
        if (!data) return { base: 'not_cancelled', constructorJobs: 0, mapsJobs: 0, failed: false };
        const stopped = await stopChildrenOfBases(
          db,
          [data as unknown as Record<string, unknown>],
          nowIso,
          logErrorNoWait,
          BASE_STOP_EVENT,
          ctx,
        );
        return { base: 'cancelled', ...stopped };
      })(),
      HE_ENG_PROJECT_STOP_STEP_TIMEOUT_MS,
    );
    if (res === TIMED_OUT) {
      void logError(`${BASE_STOP_EVENT}.timeout`, new Error(`exceeded ${HE_ENG_PROJECT_STOP_STEP_TIMEOUT_MS} ms`), ctx);
      return failed;
    }
    return res;
  } catch (e) {
    void logError(`${BASE_STOP_EVENT}.threw`, e, ctx);
    return failed;
  }
}

/* ─────────────── Общие куски ─────────────── */

/**
 * Остановить платную работу отменённых баз, которая живёт ВНЕ he_jobs.
 *
 * Зачем. Шаг 3 гасит джобы he_jobs, но сборка, отменённая в WAIT-CONSTRUCT,
 * оставляет джобу конструктора (base_constructor_jobs) в его общей FIFO-очереди:
 * она часами краулит сайты и платит SMTP-пробы, а её результат больше никто не
 * импортирует (start-guard сборки требует 'collecting', база уже 'failed'). Так
 * же дочерняя джоба Google Maps, поставленная фазой DISPATCH, дорабатывает свои
 * запросы через сервис парсеров.
 *
 * Что останавливается:
 *  - base_constructor_jobs по `collect_info.construct.bc_job_id`:
 *    'pending'/'processing' → 'cancelled' + completed_at. Это та же запись, что
 *    у cancelAbandonedConstructJob (stages/baseCollect.ts) и кнопки «Отменить»
 *    конструктора: pending-строку воркер конструктора не заберёт (клейм по
 *    'pending'), идущий прогон встанет на ближайшей проверке isCancelled. Id
 *    стадия резервирует ДО вставки строки — отмена до вставки задевает ноль
 *    строк, а вставку, легшую после отмены джобы сборки, гасит сама стадия
 *    (self-requeue читает 'cancelled' → cancelAbandonedConstructJob, ENG);
 *  - google_maps_jobs по `collect_info.tasks[i].child_job_id` задач с
 *    source='google_maps' (i — CANCEL_CHILD_TASK_SLOTS): 'queued'/'running'/
 *    'paused' → 'stopped'. Это та же запись, что у роута
 *    api/parsers/googlemaps/[jobId]/stop: 'queued' воркер парсеров не клеймит,
 *    а идущему прогону он, увидев 'stopped' на ближайшем событии прогресса,
 *    командует сервису остановиться.
 *
 * Что НЕ останавливается: дочерние джобы hh_live (parser_jobs) и yandex_maps
 * (yandex_maps_jobs). Статуса отмены у этих таблиц нет — их собственная кнопка
 * «стоп» пишет 'failed' с русским текстом, тем же статусом, что и настоящий
 * сбой парсера, — а ENG-план сборки этих источников не предлагает
 * (prompts/sourcePlan.en.ts). Работа, сделанная до отмены, уже оплачена и
 * пропадает: отмена останавливает только остаток.
 *
 * Какие базы. Те же кандидаты, что у уборки харвеста: авто-базы проекта в
 * 'failed' с текстом отмены, самые свежие первыми, не больше
 * CANCEL_HARVEST_SCAN_BASES. Базы, остановленные ЭТИМ запросом, среди них
 * первые (их updated_at — время отмены), а повторное нажатие повторяет
 * остановку — обе записи идут только поверх незавершённых статусов, и
 * завершённые джобы прошлых отмен они не задевают.
 *
 * Fail-soft: отмена к этому моменту уже состоялась, сбой только журналируется
 * (и отмечается в `failed`), а в аудит уходит, сколько строк задела каждая
 * запись.
 */
async function stopCancelledBaseWork(
  db: SupabaseClient,
  projectId: string,
  now: string,
  log: LogFn,
  event: string,
  ctx: LogContext,
): Promise<HeEngBaseChildrenStop> {
  const { data, error } = await db
    .from('he_bases')
    .select(CANCEL_BASE_WORK_SELECT)
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'failed')
    .eq('error', HE_ENG_CANCELLED_BASE_ERROR)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(CANCEL_HARVEST_SCAN_BASES);
  if (error) {
    await log(`${event}.base_work_read_failed`, error, ctx);
    return { constructorJobs: 0, mapsJobs: 0, failed: true };
  }
  return stopChildrenOfBases(db, (data ?? []) as unknown as Array<Record<string, unknown>>, now, log, event, ctx);
}

/** Записи остановки по прочитанным строкам баз (CANCEL_BASE_WORK_SELECT). */
async function stopChildrenOfBases(
  db: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  now: string,
  log: LogFn,
  event: string,
  ctx: LogContext,
): Promise<HeEngBaseChildrenStop> {
  const stopped: HeEngBaseChildrenStop = { constructorJobs: 0, mapsJobs: 0, failed: false };
  const constructorIds = new Set<string>();
  const mapsIds = new Set<string>();
  for (const row of rows) {
    const bcJobId = row.bc_job_id;
    if (typeof bcJobId === 'string' && isValidUuid(bcJobId)) constructorIds.add(bcJobId);
    for (const slot of CANCEL_CHILD_TASK_SLOTS) {
      const childId = row[`task${slot}_child`];
      if (row[`task${slot}_source`] === 'google_maps' && typeof childId === 'string' && isValidUuid(childId)) {
        mapsIds.add(childId);
      }
    }
  }
  if (constructorIds.size > 0) {
    const { data: bc, error: bcErr } = await db
      .from('base_constructor_jobs')
      .update({ status: 'cancelled', completed_at: now })
      .in('id', [...constructorIds])
      .in('status', ['pending', 'processing'])
      .select('id');
    if (bcErr) {
      stopped.failed = true;
      await log(`${event}.constructor_stop_failed`, bcErr, ctx);
    } else {
      stopped.constructorJobs = (bc ?? []).length;
    }
  }
  if (mapsIds.size > 0) {
    const { data: maps, error: mapsErr } = await db
      .from('google_maps_jobs')
      .update({ status: 'stopped' })
      .in('id', [...mapsIds])
      .in('status', ['running', 'queued', 'paused'])
      .select('id');
    if (mapsErr) {
      stopped.failed = true;
      await log(`${event}.maps_stop_failed`, mapsErr, ctx);
    } else {
      stopped.mapsJobs = (maps ?? []).length;
    }
  }
  return stopped;
}

/**
 * Снять `collect_info.tasks[].harvest` с баз, остановленных отменой (только
 * режим 'client').
 *
 * Зачем. Отменённая база остаётся в проекте навсегда, а деталка кабинета
 * перечитывает `collect_info` ВСЕХ баз проекта каждые 4 секунды. У базы,
 * отменённой посреди сборки, там лежит предмерж-харвест задач: замер на форме,
 * которую пишет стадия, — 10,26 МБ при лимите 10 000 и четырёх задачах плана
 * (у staff-лимита 50 000 это до 82 МБ, но staff отменяет своим роутом). Наружу
 * из него не уходит ни байта — и дашборд, и деталка режут харвест на выходе, —
 * то есть эти мегабайты пересылаются из БД в Node на каждый полл до конца
 * жизни проекта.
 *
 * Почему это ничего не переплачивает: харвест — чекпойнт НЕЗАВЕРШЁННОЙ сборки,
 * а start-guard стадии требует статус 'collecting' (база уже 'failed'), а
 * автоподъём (`he_auto_resume_transient_bases`) такую базу исключает навсегда
 * — по статусу её отменённой джобы и, с миграцией 20261009_0002, по отметке
 * отмены проекта (updated_at базы, записанный этим запросом, равен
 * cancelled_at), то есть и тогда, когда активной джобы у неё не было.
 * Повторный сбор клиент запускает кнопкой, и она создаёт НОВУЮ базу.
 *
 * Fail-soft: отмена к этому моменту уже состоялась (джобы и статусы
 * записаны), и неудачная уборка объёма не должна превращаться в отказ отмены —
 * поэтому ошибки только журналируются. `updated_at` НЕ трогаем: он должен
 * остаться временем отмены, а не уборки.
 *
 * Проход ОГРАНИЧЕН и идёт от самых свежих: `updated_at` только что стал временем
 * отмены у всех баз, которые остановил ЭТОТ запрос, поэтому первыми чистятся
 * именно они — те, чей харвест максимален и чью деталку клиент прямо сейчас
 * поллит. Ограничений два, и они разные:
 *  - CANCEL_HARVEST_CLEANUP_BASES — сколько баз реально ОБРЕЗАЕТСЯ за вызов. Это
 *    и есть бюджет объёма;
 *  - CANCEL_HARVEST_SCAN_BASES — сколько кандидатов вообще ОСМАТРИВАЕТСЯ. Уже
 *    обрезанная база остаётся кандидатом навсегда (барьер уборки — только статус
 *    и текст причины), и если бы она тратила бюджет, лишние базы одной большой
 *    отмены не дочистились бы никогда: следующий вызов раз за разом упирался бы в
 *    те же две самые свежие. Осмотр чистой базы стоит 3,3 КБ и бюджета НЕ тратит,
 *    поэтому очередь честно доходит до жирных.
 *
 * `collect_info` читается ПО ОДНОЙ базе (список — только id), иначе в памяти
 * роута оказывались бы все жирные строки сразу; на обычной отмене это два чтения
 * и два обрезающих запроса. Частичный проход безопасен: функция идемпотентна
 * (второй раз снимать нечего — см. проверку идентичности ниже).
 */
async function dropCancelledBaseHarvest(db: SupabaseClient, projectId: string, userId: string): Promise<void> {
  const { data, error } = await db
    .from('he_bases')
    .select('id')
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'failed')
    .eq('error', HE_ENG_CANCELLED_BASE_ERROR)
    .order('updated_at', { ascending: false })
    // Детерминированный порядок внутри одной отмены: `updated_at` у её баз
    // совпадает до миллисекунды.
    .order('created_at', { ascending: false })
    .limit(CANCEL_HARVEST_SCAN_BASES);
  if (error) {
    await logError(`${CLIENT_EVENT}.harvest_read_failed`, error, { userId, projectId });
    return;
  }
  let trimmed = 0;
  for (const row of data ?? []) {
    if (trimmed >= CANCEL_HARVEST_CLEANUP_BASES) break;
    const baseId = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null;
    if (!baseId) continue;
    const { data: full, error: readErr } = await db
      .from('he_bases')
      .select('collect_info')
      .eq('id', baseId)
      .maybeSingle();
    if (readErr) {
      await logError(`${CLIENT_EVENT}.harvest_read_failed`, readErr, { userId, projectId, baseId });
      continue;
    }
    const info = (full as { collect_info?: unknown } | null)?.collect_info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    // `stripTaskHarvest` отдаёт ТОТ ЖЕ объект, когда харвеста нет, — по
    // идентичности и решаем, нужна ли запись: у баз, отменённых до этой правки
    // или ещё до фазы сбора, запроса не будет.
    const thin = stripTaskHarvest({ collect_info: info });
    if (thin.collect_info === info) continue;
    trimmed += 1;
    const { error: writeErr } = await db
      .from('he_bases')
      .update({ collect_info: thin.collect_info })
      .eq('id', baseId)
      // Второй барьер между чтением и записью: пишем только пока база всё ещё
      // отменена — иначе уборка могла бы обрезать чекпойнт ожившей сборки.
      .eq('status', 'failed')
      .eq('error', HE_ENG_CANCELLED_BASE_ERROR);
    if (writeErr) {
      await logError(`${CLIENT_EVENT}.harvest_write_failed`, writeErr, { userId, projectId, baseId });
    }
  }
}
