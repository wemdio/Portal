/**
 * Единый жизненный цикл фоновых задач.
 *
 * Одна библиотека вместо самописных claim/recover/resetStuck в каждом воркере.
 * Spec: docs/superpowers/specs/2026-09-02-job-lifecycle-design.md.
 *
 * Что делает:
 *  1. Захват. pending → running с новым run_token и арендой lease_until (CAS по
 *     status). Если pending нет — running с истёкшей (lt now) или обнулённой
 *     (null) арендой. Через PostgREST, без RPC: тот же паттерн, что годами
 *     работает в конструкторе баз.
 *  2. Продление. Пока run() идёт, независимый setInterval продлевает аренду с
 *     фильтром run_token. После markShuttingDown() продления молчат (инцидент
 *     11.08.2026: heartbeat затирал handoff). Продление независимо от тела, и
 *     потому само по себе означает «процесс жив», а не «задача движется»: для
 *     второго есть опция progress — она прекращает продление, когда колонка
 *     прогресса стоит дольше порога (см. JobRunnerOptions.progress).
 *  3. Чекпойнт. ctx.saveCheckpoint пишет checkpoint + продлевает аренду; false —
 *     строку перехватили, воркер обязан остановиться (мы ещё и abort'им signal).
 *  4. Остановка. shutdown(): markShuttingDown, abort всех run, при желании
 *     воркера — beforeRelease (закрыть внешние ресурсы, пока строка ещё наша),
 *     затем lease_until=null своим задачам дважды с паузой в секунду
 *     (перебивает продление, ушедшее до сигнала), ждём run-промисы до
 *     shutdownGraceMs. Новая реплика подхватит задачу на первом опросе.
 *  5. Восстановления при старте НЕТ. Брошенная задача = истёкшая/обнулённая
 *     аренда. Поэтому механизм корректен при любом числе реплик.
 *
 * attempts — бюджет неудач, а не счётчик запусков: его тратят потери аренды
 * (crash/OOM/SIGKILL) и исключения в run(), а любой сохранённый чекпойнт
 * возвращает его в ноль. Поэтому три транзиентных сбоя за сутки не роняют
 * задачу, которая всё это время двигалась. Чистая передача при shutdown
 * (lease_until=null) попыткой не считается — иначе три деплоя подряд роняли бы
 * трёхчасовую задачу.
 *
 * ЧТО БИБЛИОТЕКА ТРЕБУЕТ ОТ run() (контракт для всех воркеров на ней):
 *  - Слушать ctx.signal. Он взводится не только на SIGTERM, но и когда аренда
 *    потеряна или провисела дольше срока; после этого задача уже не наша и
 *    любое внешнее действие (отправка в Telegram, платный запрос обогащения,
 *    звонок, запись в чужие таблицы) — работа за чужой счёт. Записи в саму
 *    таблицу задач ограждены жетоном, всё остальное — нет.
 *  - Быть возобновляемой с последнего чекпойнта: остановка происходит в
 *    произвольной точке, продолжит другая реплика.
 *  - Терпеть, что сосед начал ту же задачу раньше, чем мы дописали свою:
 *    shutdown отпускает аренду намеренно, не дожидаясь конца тела. Пересечение
 *    коротко, но существует, и шаги задачи должны быть идемпотентны.
 *    Задаче, у которой пересечение стоит не переделанной работы, а сожжённого
 *    ресурса (живая MTProto-сессия: второе подключение той же сессии даёт
 *    AUTH_KEY_DUPLICATED и выключает аккаунт навсегда), идемпотентности мало —
 *    ей нужен beforeRelease, см. JobRunnerOptions.beforeRelease.
 */

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isShuttingDown, markShuttingDown } from '@/lib/workerShutdown';

export type JobLogger = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface JobStatuses {
  pending: string;
  running: string;
  done: string;
  failed: string;
}

export interface JobContext<C> {
  jobId: string;
  runToken: string;
  /** Чекпойнт с прошлого захвата или null. */
  checkpoint: C | null;
  /** Взводится при shutdown и при потере аренды. Передавать в fetch/паузы. */
  signal: AbortSignal;
  shouldStop(): boolean;
  /**
   * Записать прогресс и продлить аренду.
   *
   * Возвращает ответ про ВЛАДЕНИЕ, не про запись: true — строка всё ещё наша,
   * false — её перехватили и работу над задачей надо прекратить. Сама запись
   * best-effort: при сбое БД она повторяется дважды, и если не удалась даже
   * так, вернётся true (мы владельцы), а checkpoint в базе останется прежним.
   * Поэтому выбрасывать состояние из памяти сразу после успешного вызова
   * нельзя — в худшем случае задача переиграет отрезок с прошлого чекпойнта.
   */
  saveCheckpoint(data: C): Promise<boolean>;
  log: JobLogger;
}

/**
 * Минимальный срез supabase-js, который использует библиотека (и который умеет
 * фейк в тестах). Тип запроса — any: цепочка PostgREST-билдера меняет форму на
 * каждом шаге, а нам от неё нужны только .data/.error в конце.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryBuilder = any;
export type JobDbClient = { from(table: string): QueryBuilder };

export interface JobRunnerOptions<Row extends { id: string }, C> {
  table: string;
  workerId: string;
  statuses: JobStatuses;
  /** Аренда в секундах; продление каждые leaseSeconds/3. */
  leaseSeconds: number;
  /**
   * Сколько потерь аренды / исключений ПОДРЯД, БЕЗ ВИДИМОГО ПРОГРЕССА, до
   * status=failed. По умолчанию 3.
   *
   * Счётчик обнуляет и чекпойнт, и любое замеченное движение колонки progress.
   * Отсюда важное следствие: задача, которая каждый раз успевает сдвинуть
   * прогресс и только потом падает (OOM в середине шага), до предела не дойдёт
   * никогда и будет перезапускаться бесконечно — failedPatch её не остановит.
   * Это осознанный размен: так вело себя и до миграции, и он лечит храповик,
   * из-за которого долгая живая задача умирала от трёх грубых остановок. Но
   * если воркеру нужен жёсткий предел на повторяющееся падение, ставить его
   * надо своими средствами, а не этой опцией.
   */
  maxAttempts?: number;
  /** Сколько задач одновременно на этой реплике. По умолчанию 1. */
  concurrency?: number;
  /** Колонка порядка захвата pending. По умолчанию created_at. */
  orderBy?: string;
  /**
   * Дополнительный фильтр ОТБОРА задач: пары [колонка, значение] или
   * [колонка, значения[]] (массив идёт в .in(), скаляр — в .eq()).
   *
   * Зачем: одна таблица нередко обслуживает несколько типов задач
   * (parser_jobs — HH-вакансии, ATS-компании, ENG-найм). Тип обязан входить в
   * САМ захват, а не проверяться после него: иначе воркер в гонке уводит чужую
   * задачу и либо делает её неправильно, либо возвращает уже испорченной.
   * Поэтому фильтр применяется на обоих путях захвата (pending и перехват
   * истёкшей аренды) и в обоих запросах каждого пути — и в выборе кандидата, и
   * в CAS-UPDATE.
   *
   * Это фильтр ОТБОРА и только. Ограждение записей остаётся на run_token:
   * where не мешает соседу с тем же фильтром перехватить строку и не заменяет
   * жетон ни в одной записи после захвата.
   */
  where?: Array<[string, string | number | Array<string | number>]>;
  /** Что читать в job для run(). id, checkpoint, attempts, run_token добавляются всегда. */
  select?: string;
  /**
   * Дополнительные поля при ЛЮБОМ захвате — и нового pending, и перехвата
   * чужой истёкшей аренды (например started_at). На перехвате они особенно
   * нужны: без них строка уносит с собой отметку прогресса прежнего владельца.
   */
  claimPatch?: () => Record<string, unknown>;
  /**
   * Признак живости по прогрессу, а не по процессу.
   *
   * Продление аренды идёт независимым таймером, поэтому здоровый процесс с
   * намертво зависшим телом задачи (повисший scrape, неотвечающий AI-вызов)
   * продлевал бы аренду вечно и задачу не подобрал бы никто. Раньше от этого
   * защищал порог по started_at, который двигался только на реальном прогрессе.
   *
   * Если задано, каждое продление сперва читает `column` у своей строки. Пока
   * значение меняется — это прогресс: таймер простоя сбрасывается, а бюджет
   * попыток обнуляется (иначе воркер без чекпойнтов копит попытки в одну
   * сторону и уходит в failed после трёх грубых остановок). Если значение не
   * менялось дольше `stalledAfterMs` — продления прекращаются, run прерывается
   * с reason 'progress-stalled', и аренда НЕ отпускается: она истекает сама,
   * задачу подбирает соседняя реплика и потеря честно считается падением.
   *
   * `column` должна быть СКАЛЯРНОЙ (число, текст, timestamp). Сравнение идёт
   * через !==, и jsonb/массив каждый раз разбирается в новый объект — такая
   * колонка всегда «двигается» и молча выключает и детектор простоя, и предел
   * попыток. Обычно это счётчик обработанного или отметка последнего шага.
   */
  progress?: { column: string; stalledAfterMs: number };
  /**
   * Дополнительные поля при переводе в failed (например error_message).
   *
   * Вторым аргументом идёт id задачи: у части воркеров колонки под причину нет
   * вовсе, зато есть свой журнал, который читает человек, — и написать в него
   * без идентификатора невозможно. Такой воркер возвращает пустой патч (или
   * одну отметку времени), а строку в журнал пишет побочным действием.
   */
  failedPatch?: (reason: string, jobId: string) => Record<string, unknown>;
  /**
   * Чекпойнт не записался, хотя задача осталась нашей.
   *
   * saveCheckpoint отвечает про ВЛАДЕНИЕ и в этом случае вернёт true, поэтому
   * сам по себе провал записи для воркера невидим: предупреждение уходит в
   * stdout контейнера, а в журнале самой задачи не появляется ничего. Между тем
   * реальный случай — чекпойнт, который PostgREST не принимает по размеру
   * (у TG-парсера в него копится список пользователей), и тогда продолжение с
   * места молча мертво ровно на тех задачах, которым оно нужнее всего.
   *
   * Колбэк — шанс воркеру написать об этом в СВОЙ, видимый пользователю журнал
   * задачи. Зовётся без ожидания результата, исключения из него гасятся; он
   * обязан быть дешёвым и не бросать.
   */
  onCheckpointUnpersisted?: (jobId: string) => void | Promise<void>;
  /**
   * true (по умолчанию): библиотека сама ставит done/failed/pending по итогу run().
   * false: run() пишет терминальный статус сам (конструктор баз, TG-парсер);
   * библиотека тогда держит аренду, отпускает её при остановке, а после
   * штатного возврата run() снимает со строки владение (lease_until, run_token,
   * worker_id) — но только если статус уже НЕ running, то есть тело
   * действительно закрыло задачу, а не оставило её на возобновление.
   */
  manageTerminalStatus?: boolean;
  /**
   * Весь бюджет остановки: от сигнала до момента, когда shutdown() возвращает
   * управление. По умолчанию 10 с, максимум MAX_SHUTDOWN_GRACE_MS, потому что
   * деплой даёт контейнеру `docker stop --timeout 15`.
   *
   * Из этого бюджета последовательно тратятся: beforeRelease (если задан), два
   * прохода освобождения аренды с паузой в секунду между ними, контрольное
   * чтение строк — и только ОСТАТОК достаётся ожиданию run-промисов. Раньше
   * ожидание отсчитывалось после освобождений, то есть реальная остановка
   * стоила grace + секунда паузы + запросы и в худшем случае не влезала в
   * пятнадцать секунд деплоя. Большее значение обрезается: SIGKILL раньше
   * отпущенной аренды означает простой на полный leaseSeconds.
   */
  shutdownGraceMs?: number;
  /**
   * Закрыть внешние ресурсы задач ДО того, как их аренда отпущена.
   *
   * Обычной задаче это не нужно: пересечение владельцев стоит переделанной
   * работы, и от неё защищает идемпотентность шагов. Но у TG-аутрича единица
   * работы — кампания с дюжиной живых MTProto-сессий, и там порядок обратный:
   * сосед, подхвативший строку раньше, чем уходящий процесс отключил клиентов,
   * подключит ТЕ ЖЕ сессии, получит AUTH_KEY_DUPLICATED и после трёх таких
   * подряд аккаунт выключается насовсем (lib/tgOutreach/gramClient.ts) —
   * восстановление только руками, с перевыпуском сессии с телефона.
   *
   * Зовётся один раз за остановку, ПОСЛЕ abort всех run (тело обязано уже
   * прекратить пользоваться клиентами, пока хук их закрывает) и ДО первого
   * освобождения аренды. Получает id задач, которые прямо сейчас наши.
   *
   * Хук не может помешать освобождению: он и не бросает наружу (исключение
   * логируется), и не висит дольше beforeReleaseTimeoutMs. Так и задумано —
   * НЕотпущенная аренда хуже отпущенной на несколько секунд позже: задачу с
   * живой арендой не подберёт никто до конца leaseSeconds, а перехват потом
   * запишет это как падение и потратит попытку.
   */
  beforeRelease?: (jobIds: string[]) => void | Promise<void>;
  /**
   * Потолок ожидания beforeRelease. По умолчанию 5 с; больше shutdownGraceMs
   * быть не может — иначе хук съедал бы бюджет целиком и аренду отпускал бы уже
   * SIGKILL, то есть никто.
   */
  beforeReleaseTimeoutMs?: number;
  now?: () => number;
  db?: JobDbClient;
  log: JobLogger;
  run(job: Row & { checkpoint: C | null; attempts: number }, ctx: JobContext<C>): Promise<void>;
}

export interface JobRunner {
  /**
   * Один опрос. true — зови снова сразу (задачу взяли, либо кандидат был, но
   * гонку за него проиграли: очередь непуста). false — брать нечего, можно
   * спать до следующего тика.
   *
   * Не реентерабелен: рассчитан на последовательного вызывающего (pollLoop
   * воркера). Два параллельных вызова на одной реплике могут вдвоём пройти
   * проверку concurrency и захватить на задачу больше положенного.
   */
  pollOnce(): Promise<boolean>;
  /** Идемпотентно. Отпускает аренды, прерывает run(), ждёт до shutdownGraceMs. */
  shutdown(): Promise<void>;
  activeJobIds(): string[];
}

/** Потолок ожидания в shutdown, см. JobRunnerOptions.shutdownGraceMs. */
const MAX_SHUTDOWN_GRACE_MS = 12_000;
/** Повторы записи чекпойнта при сбое БД (владение при этом не теряется). */
const CHECKPOINT_WRITE_TRIES = 3;
const CHECKPOINT_BACKOFF_MS = 200;
/**
 * Повторы терминальной записи (done/failed/pending). Без них один моргнувший
 * запрос оставляет строку в running: аренда истечёт, и сосед переделает уже
 * сделанную задачу. Та же причина, что у updateJobWithRetry в
 * app/src/lib/tools/baseConstructorWorker.ts. Суммарно не больше 1,5 с, чтобы
 * влезать в бюджет остановки.
 */
const TERMINAL_WRITE_TRIES = 3;
const TERMINAL_BACKOFF_MS = 500;
/** Повторы освобождения аренды: короткие, они идут внутри бюджета остановки. */
const RELEASE_WRITE_TRIES = 2;
const RELEASE_BACKOFF_MS = 300;
/**
 * Потолок ожидания beforeRelease по умолчанию, см. JobRunnerOptions.
 * Пять секунд — это примерно вдвое больше, чем занимает закрытие дюжины
 * клиентов gramJS, и вдвое меньше бюджета остановки по умолчанию.
 */
const DEFAULT_BEFORE_RELEASE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Таймер продления не должен держать процесс живым, если воркер уже всё доделал. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybe = timer as unknown as { unref?: () => void };
  if (typeof maybe.unref === 'function') maybe.unref();
}

/** Итог ограждённой записи: владеем ли строкой и легла ли правка в базу. */
type FenceResult = { owned: boolean; persisted: boolean };

export function createJobRunner<Row extends { id: string }, C = unknown>(
  opts: JobRunnerOptions<Row, C>,
): JobRunner {
  const configured: JobDbClient | null = opts.db ?? (supabaseAdmin as unknown as JobDbClient | null);
  if (!configured) throw new Error('createJobRunner: supabaseAdmin is not configured');
  const client: JobDbClient = configured;
  const {
    table, workerId, statuses, log,
    maxAttempts = 3, concurrency = 1, orderBy = 'created_at',
    manageTerminalStatus = true,
  } = opts;
  const requestedGrace = opts.shutdownGraceMs ?? 10_000;
  const shutdownGraceMs = Math.min(requestedGrace, MAX_SHUTDOWN_GRACE_MS);
  if (requestedGrace > MAX_SHUTDOWN_GRACE_MS) {
    log('warn', `[${table}] shutdownGraceMs ${requestedGrace} обрезан до ${MAX_SHUTDOWN_GRACE_MS}: не влезает в docker stop --timeout 15`);
  }
  const requestedHookCap = opts.beforeReleaseTimeoutMs ?? DEFAULT_BEFORE_RELEASE_MS;
  const beforeReleaseCapMs = Math.min(requestedHookCap, shutdownGraceMs);
  if (requestedHookCap > shutdownGraceMs) {
    log('warn', `[${table}] beforeReleaseTimeoutMs ${requestedHookCap} обрезан до ${beforeReleaseCapMs}: хук не может съесть весь бюджет остановки, аренду надо успеть отпустить`);
  }
  const now = opts.now ?? Date.now;
  const leaseMs = Math.max(1_000, opts.leaseSeconds * 1_000);
  const heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3));
  // run_token обязателен в выборке: по нему ограждаются все дальнейшие записи.
  const baseSelect = 'id, checkpoint, attempts, run_token';
  const select = opts.select ? `${baseSelect}, ${opts.select}` : baseSelect;

  type ClaimedJob = Row & { checkpoint: C | null; attempts: number };
  /**
   * Итог попытки захвата. Три «незахвата» разведены намеренно — от того, какой
   * из них вернулся, зависит, звать ли снова:
   *
   *  - 'empty'  — кандидатов нет. Спим до следующего тика.
   *  - 'lost'   — кандидат был, но CAS вернул НОЛЬ СТРОК БЕЗ ОШИБКИ: строку
   *               забрал сосед. Очередь непуста, звать снова стоит (с короткой
   *               паузой), а не ждать realtime — он будит только по
   *               status=pending, и перехват освобождённых аренд им не покрыт.
   *  - 'failed' — сам запрос захвата не выполнился (таймаут по блокировкам на
   *               горячей очереди, права/RLS, PostgREST, отвечающий ошибкой на
   *               запись). Ноль строк тут ничего не говорит об очереди, и
   *               просить позвать снова нельзя: pollLoop зовёт немедленно и без
   *               паузы, так что двенадцать реплик ушли бы в цикл по два
   *               запроса на круг против базы, которой и так плохо.
   */
  type ClaimOutcome =
    | { kind: 'claimed'; job: ClaimedJob; runToken: string }
    | { kind: 'empty' }
    | { kind: 'lost' }
    | { kind: 'failed' };
  const EMPTY: ClaimOutcome = { kind: 'empty' };
  const LOST: ClaimOutcome = { kind: 'lost' };
  const FAILED: ClaimOutcome = { kind: 'failed' };

  const iso = (ms: number) => new Date(ms).toISOString();
  const leaseUntil = () => iso(now() + leaseMs);
  /**
   * PostgREST-фильтр «аренда истекла или обнулена». Значение в кавычках:
   * внутри ISO-даты есть точки, без кавычек грамматика or=(…) режет их как
   * разделители оператора.
   *
   * Истечение судится по часам претендента, а не по часам базы: реплика,
   * часы которой убежали вперёд, сочла бы живую аренду истёкшей. Сегодня все
   * реплики живут на одном хосте (139) с общим временем, так что риск
   * теоретический; при разъезде по хостам сюда нужен now() из базы.
   */
  const expiredFilter = () => `lease_until.is.null,lease_until.lt."${iso(now())}"`;
  const clearOwnership = { lease_until: null, run_token: null, worker_id: null };

  /** Навесить where-фильтр на любой запрос захвата (см. JobRunnerOptions.where). */
  function applyWhere(query: QueryBuilder): QueryBuilder {
    let q = query;
    for (const [column, value] of opts.where ?? []) {
      q = Array.isArray(value) ? q.in(column, value) : q.eq(column, value);
    }
    return q;
  }

  type Owned = {
    runToken: string;
    abort: AbortController;
    promise: Promise<void>;
    stopHeartbeat: () => void;
  };
  const owned = new Map<string, Owned>();
  let stopping = false;
  /** Промис идущей остановки — чтобы повторный shutdown() дожидался первого. */
  let shutdownRun: Promise<void> | null = null;
  /**
   * Пропуск на освобождение аренды во время остановки.
   *
   * Пока beforeRelease не отработал, аренду не отпускает НИКТО — ни shutdown,
   * ни тело, которое бросило на отмене и торопится отдать строку соседу. Иначе
   * хук закрывал бы клиентов уже после того, как строка стала свободной, и
   * весь его смысл терялся бы на самом частом пути (тело, брошенное abort'ом,
   * доходит до своего catch за один микротаск).
   *
   * Промис никогда не отвергается и всегда разрешается в пределах потолка, так
   * что ждать его безопасно откуда угодно.
   */
  let releaseGate: Promise<void> | null = null;

  /** Останавливаемся: свой флаг раннера или общий процессный. */
  const halting = () => stopping || isShuttingDown();

  /**
   * UPDATE с ограждением по жетону.
   *
   * owned=false — строку перехватили. Сбой сети даёт owned=true при
   * persisted=false: он не доказательство потери владения, все записи и так
   * ограждены жетоном, а ложный abort стоил бы часов работы. От зависшей
   * навсегда базы защищает не он, а самопроверка аренды в heartbeat.
   */
  async function fencedUpdate(
    jobId: string,
    runToken: string,
    patch: Record<string, unknown>,
  ): Promise<FenceResult> {
    const { data, error } = await client
      .from(table)
      .update(patch)
      .eq('id', jobId)
      .eq('status', statuses.running)
      .eq('run_token', runToken)
      .select('id')
      .maybeSingle();
    if (error) {
      log('warn', `[${table}] fenced update failed for ${jobId}: ${error.message}`);
      return { owned: true, persisted: false };
    }
    return { owned: !!data, persisted: !!data };
  }

  /** То же с повторами: только для записей, которые нельзя потерять. */
  async function fencedUpdateWithRetry(
    jobId: string,
    runToken: string,
    patch: Record<string, unknown>,
    tries: number,
    backoffMs: number,
  ): Promise<FenceResult> {
    let result = await fencedUpdate(jobId, runToken, patch);
    for (let attempt = 1; attempt < tries && result.owned && !result.persisted; attempt += 1) {
      await sleep(backoffMs * attempt);
      result = await fencedUpdate(jobId, runToken, patch);
    }
    return result;
  }

  /**
   * Отпустить аренду, оставив жетон: строку сразу подберёт сосед.
   *
   * С повтором: часть освобождений — единственное, что стоит между строкой и
   * простоем на весь leaseSeconds с записью «падение» (захват во время
   * shutdown, падение при manageTerminalStatus=false). Два прохода shutdown()
   * их не прикрывают.
   */
  const releaseLease = (jobId: string, runToken: string) =>
    fencedUpdateWithRetry(jobId, runToken, { lease_until: null }, RELEASE_WRITE_TRIES, RELEASE_BACKOFF_MS);

  /**
   * Снять владение со строки, терминальный статус которой записало само тело
   * задачи (manageTerminalStatus: false — конструктор баз, TG-парсер, архив HH,
   * Директ; сюда же попадает отмена пользователем).
   *
   * Раньше библиотека в этом случае не писала ничего, и завершённая или
   * отменённая задача НАВСЕГДА оставалась с непустыми lease_until, run_token и
   * worker_id. Захвату это не мешало (все его пути фильтруют по running), но
   * ровно так же выглядит и по-настоящему арендованная строка — и дежурный
   * запрос «кто держит аренду» показывал давно закрытые задачи. Три воркера с
   * одним и тем же осадком — повод чинить здесь, а не патчить каждый.
   *
   * Два условия, оба обязательны:
   *  - .eq(run_token) — обычное ограждение: строку могли перехватить, и тогда
   *    жетон уже чужой, а владение не наше;
   *  - .neq(status, running) — строку могли ОСТАВИТЬ в running намеренно, чтобы
   *    другая реплика продолжила с чекпойнта (так делает путь прерывания). Ей
   *    жетон и аренда нужны живыми, и стирать их нельзя. Так что это именно
   *    «статус уже не running», а не «run() вернулся».
   */
  async function releaseOwnershipAfterForeignTerminal(jobId: string, runToken: string): Promise<void> {
    for (let attempt = 0; attempt < RELEASE_WRITE_TRIES; attempt += 1) {
      if (attempt > 0) await sleep(RELEASE_BACKOFF_MS * attempt);
      const { error } = await client
        .from(table)
        .update(clearOwnership)
        .eq('id', jobId)
        .eq('run_token', runToken)
        .neq('status', statuses.running)
        .select('id')
        .maybeSingle();
      if (!error) return;
      log('warn', `[${table}] ownership release for ${jobId} failed: ${error.message}`);
    }
  }

  async function claimPending(): Promise<ClaimOutcome> {
    const { data: candidate, error: selectError } = await applyWhere(
      client
        .from(table)
        .select('id, attempts')
        .eq('status', statuses.pending),
    )
      .order(orderBy, { ascending: true })
      .limit(1)
      .maybeSingle();
    if (selectError) {
      log('warn', `[${table}] pending candidate query failed: ${selectError.message}`);
      return FAILED;
    }
    if (!candidate) return EMPTY;
    const runToken = randomUUID();
    const { data, error } = await applyWhere(
      client
        .from(table)
        .update({
          status: statuses.running,
          run_token: runToken,
          worker_id: workerId,
          lease_until: leaseUntil(),
          ...(opts.claimPatch?.() ?? {}),
        })
        .eq('id', candidate.id)
        // CAS: строку получит ровно та реплика, для которой она ещё pending.
        .eq('status', statuses.pending),
    )
      .select(select)
      .maybeSingle();
    // Ошибку захвата НЕЛЬЗЯ трактовать как проигранную гонку: ноль строк из-за
    // сбоя ничего не говорит об очереди, а 'lost' просит позвать снова.
    if (error) {
      log('warn', `[${table}] pending claim of ${candidate.id} failed: ${error.message}`);
      return FAILED;
    }
    // Жетон берём свой, а не из ответа: представление могло не отдать колонку,
    // и тогда все дальнейшие ограждённые записи били бы мимо (baseConstructor.ts:143).
    return data ? { kind: 'claimed', job: data as ClaimedJob, runToken } : LOST;
  }

  async function claimExpired(): Promise<ClaimOutcome> {
    const { data: candidate, error: selectError } = await applyWhere(
      client
        .from(table)
        .select('id, attempts, lease_until')
        .eq('status', statuses.running)
        .or(expiredFilter()),
    )
      .order(orderBy, { ascending: true })
      .limit(1)
      .maybeSingle();
    if (selectError) {
      log('warn', `[${table}] expired candidate query failed: ${selectError.message}`);
      return FAILED;
    }
    if (!candidate) return EMPTY;
    // null — чистая передача при shutdown, не попытка. Иначе — crash/kill.
    const lost = candidate.lease_until != null;
    const attempts = (candidate.attempts ?? 0) + (lost ? 1 : 0);
    if (lost && attempts >= maxAttempts) {
      const reason = `исполнитель терял задачу ${attempts} раз(а) подряд — остановлено`;
      // where и здесь. По id строка та же, что отобрал кандидатский запрос, так
      // что для сегодняшнего parser_type фильтр избыточен. Но колонка отбора —
      // обычная колонка, и ничто не мешает ей смениться между чтением и этой
      // записью (перенос задачи в другой тип/очередь руками или экраном).
      // Тогда мы поставили бы failed чужой задаче, а стоит фильтр ноль. Правило
      // проще держать целиком: where применяется ко ВСЕМ запросам захвата.
      await applyWhere(
        client
          .from(table)
          .update({
            status: statuses.failed,
            attempts,
            ...clearOwnership,
            ...(opts.failedPatch?.(reason, candidate.id) ?? {}),
          })
          .eq('id', candidate.id)
          .eq('status', statuses.running)
          .or(expiredFilter()),
      )
        .select('id')
        .maybeSingle();
      log('warn', `[${table}] job ${candidate.id} failed: ${reason}`);
      return EMPTY;
    }
    const runToken = randomUUID();
    const { data, error } = await applyWhere(
      client
        .from(table)
        .update({
          run_token: runToken,
          worker_id: workerId,
          lease_until: leaseUntil(),
          attempts,
          // Тот же claimPatch, что и на pending-пути: «поля при захвате» — это
          // поля при любом захвате. Без него перехваченная строка сохраняет
          // отметку прогресса прежнего владельца, и монитор здоровья считает
          // задачу зависшей в ту же секунду, как её подобрали.
          ...(opts.claimPatch?.() ?? {}),
        })
        .eq('id', candidate.id)
        .eq('status', statuses.running)
        // Тот же фильтр в UPDATE: между чтением кандидата и записью аренду мог
        // перехватить сосед — тогда строка уже не «истёкшая» и мы её не тронем.
        .or(expiredFilter()),
    )
      .select(select)
      .maybeSingle();
    // Как и на pending-пути: сбой запроса — не проигранная гонка.
    if (error) {
      log('warn', `[${table}] reclaim of ${candidate.id} failed: ${error.message}`);
      return FAILED;
    }
    if (data) log('info', `[${table}] reclaimed job ${candidate.id} (${lost ? 'lease expired' : 'released'})`);
    return data ? { kind: 'claimed', job: data as ClaimedJob, runToken } : LOST;
  }

  function execute(job: ClaimedJob, runToken: string): void {
    const abort = new AbortController();
    const jobLog: JobLogger = (level, msg, extra) => log(level, `[${table}][${job.id}] ${msg}`, extra);
    /** Момент последнего УСПЕШНОГО продления — по нему судим о своей аренде. */
    let lastRenewedAt = now();
    /**
     * Сколько неудач числится за задачей сейчас. Снимок с захвата, но записанный
     * чекпойнт обнуляет его вместе с колонкой в базе — иначе исключение после
     * многочасовой работы считалось бы по счётчику на момент захвата, и задача,
     * подобранная с attempts=2, падала бы в failed при первой же осечке.
     */
    let attemptsBase = job.attempts ?? 0;

    /** Идёт ли прямо сейчас запрос продления (см. guard ниже). */
    let beating = false;
    const progress = opts.progress;
    /** Последнее увиденное значение колонки прогресса и когда оно менялось. */
    let progressValue: unknown = progress
      ? (job as unknown as Record<string, unknown>)[progress.column]
      : undefined;
    let progressSeeded = progressValue !== undefined;
    let lastProgressAt = now();
    /** Об ошибке чтения колонки прогресса кричим один раз на задачу. */
    let progressReadFailed = false;

    /**
     * moving — колонка сдвинулась (это и есть прогресс);
     * idle — не сдвинулась, но порог простоя ещё не выбран;
     * stalled — стоит дольше порога, продление прекращено и run прерван.
     */
    const checkProgress = async (): Promise<'moving' | 'idle' | 'stalled'> => {
      if (!progress) return 'idle';
      const { data, error } = await client
        .from(table)
        .select(`id, ${progress.column}`)
        .eq('id', job.id)
        .maybeSingle();
      // Читать под жетоном незачем: значение нужно нам самим, а не для записи.
      // Ошибку чтения не считаем ни прогрессом, ни простоем — мёртвую базу
      // ловит проверка протухшей аренды выше.
      if (error || !data) {
        // Но молчать нельзя: опечатка в имени колонки даёт ошибку на КАЖДОМ
        // тике, progressSeeded никогда не станет true, ветка простоя не
        // сработает — и воркер с выключенной страховкой выглядит здоровым.
        // Логируем один раз на задачу, чтобы не залить журнал.
        if (!progressReadFailed) {
          progressReadFailed = true;
          jobLog('error', `progress column "${progress.column}" is unreadable — stall detection is OFF for this job: ${error?.message ?? 'row not found'}`);
        }
        return 'idle';
      }
      const value = (data as Record<string, unknown>)[progress.column];
      if (!progressSeeded) {
        // Первое чтение — точка отсчёта, а не прогресс: бюджет попыток за него
        // не возвращаем, иначе одного тика хватало бы, чтобы обнулить счётчик.
        progressValue = value;
        progressSeeded = true;
        lastProgressAt = now();
        return 'idle';
      }
      if (value !== progressValue) {
        progressValue = value;
        lastProgressAt = now();
        return 'moving';
      }
      const idleMs = now() - lastProgressAt;
      if (idleMs <= progress.stalledAfterMs) return 'idle';
      jobLog('warn', `no progress in ${progress.column} for ${Math.round(idleMs / 1000)}s — abandoning lease`);
      abort.abort('progress-stalled');
      return 'stalled';
    };

    const heartbeat = async () => {
      if (abort.signal.aborted || halting()) return;
      // Проверка ДО запроса, а не после: иначе она мертва в главном сценарии,
      // ради которого заведена. У undici нет таймаута по умолчанию, и зависшее
      // соединение с PostgREST не возвращается никогда — свежие тики честно
      // приходят, но все встают на том же await и до проверки не доходят
      // (тот же класс отказа, что heartbeat в app/worker/_shared.ts и зависший
      // воркер ЯКарт 27.07.2026). В базе аренда к этому моменту истекла, задачу
      // забрал сосед, и мы узнаём об этом только по часам. Иначе двое делают
      // одну работу, а ограждение жетоном спасает лишь таблицу задач — не
      // отправки, платные запросы и записи в чужие таблицы.
      // На первых тиках проверка безвредна: дельта тогда порядка leaseMs/3.
      if (now() - lastRenewedAt > leaseMs) {
        jobLog('warn', `lease not renewed for ${Math.round((now() - lastRenewedAt) / 1000)}s — aborting`);
        abort.abort('lease-expired');
        return;
      }
      // Guard от наложения: setInterval с async-колбэком не ждёт предыдущий,
      // и на залипшем соединении вызовы копятся все часы работы задачи. Стоит
      // ПОСЛЕ проверки протухания — она обязана работать как раз тогда, когда
      // запрос завис.
      if (beating) return;
      beating = true;
      try {
        // Прогресс проверяем ДО продления: узнав о простое из ответа на само
        // продление, мы бы этим же запросом продлили аренду ещё на срок и
        // отодвинули перехват соседом на целый leaseSeconds.
        const liveness = await checkProgress();
        if (liveness === 'stalled') return;
        /**
         * Точка отсчёта аренды — момент ПЕРЕД запросом, а не после ответа.
         *
         * lease_until считается от неё же, и база истечёт ровно в
         * renewedFrom + leaseMs. Если записать сюда время ОТВЕТА, то самопроверка
         * ниже поверит в аренду, которой в базе уже нет, ровно на длительность
         * запроса — а длинные запросы бывают именно тогда, когда база больна,
         * то есть в единственном сценарии, ради которого проверка и заведена.
         * На здоровой базе разница — десятки миллисекунд, на умирающей — минуты
         * лишнего пересечения с соседом, который строку уже забрал.
         */
        const renewedFrom = now();
        const patch: Record<string, unknown> = { lease_until: iso(renewedFrom + leaseMs) };
        if (liveness === 'moving') {
          // Задача видимо движется — бюджет неудач возвращается, как и на
          // чекпойнте. Пишем в колонку, а не только в память: перехват после
          // грубой остановки считает попытки по строке в базе.
          attemptsBase = 0;
          patch.attempts = 0;
        }
        const result = await fencedUpdate(job.id, runToken, patch);
        if (result.persisted) lastRenewedAt = renewedFrom;
        if (abort.signal.aborted) return;
        if (!result.owned) {
          jobLog('warn', 'lease lost to another worker — aborting');
          abort.abort('lease-lost');
        }
      } finally {
        beating = false;
      }
    };
    const timer = setInterval(() => { void heartbeat(); }, heartbeatMs);
    unrefTimer(timer);
    let heartbeatStopped = false;
    const stopHeartbeat = () => {
      if (heartbeatStopped) return;
      heartbeatStopped = true;
      clearInterval(timer);
    };

    const ctx: JobContext<C> = {
      jobId: job.id,
      runToken,
      checkpoint: (job.checkpoint ?? null) as C | null,
      signal: abort.signal,
      shouldStop: () => abort.signal.aborted || halting(),
      log: jobLog,
      saveCheckpoint: async (data) => {
        if (abort.signal.aborted) return false;
        // Прогресс возвращает бюджет попыток: задача, которая двигается,
        // не должна падать из-за трёх разнесённых во времени сбоев.
        const patch: Record<string, unknown> = { checkpoint: data, attempts: 0 };
        // Во время остановки чекпойнт сохраняем, а аренду не продлеваем:
        // именно продление в shutdown отменяло быструю передачу (11.08.2026).
        // Точка отсчёта — как в heartbeat, момент до запроса.
        const renewedFrom = now();
        const renewing = !halting();
        if (renewing) patch.lease_until = iso(renewedFrom + leaseMs);
        const result = await fencedUpdateWithRetry(
          job.id, runToken, patch, CHECKPOINT_WRITE_TRIES, CHECKPOINT_BACKOFF_MS,
        );
        if (!result.owned) {
          jobLog('warn', 'checkpoint rejected — job was reclaimed, aborting');
          abort.abort('lease-lost');
          return false;
        }
        if (result.persisted) {
          // Только если аренду и правда продлили: на остановке lease_until в
          // патч не попал, и двигать точку отсчёта было бы враньём.
          if (renewing) lastRenewedAt = renewedFrom;
          // Ровно то же, что записали в колонку: иначе сброс жил бы только в
          // базе, а терминальная запись считала бы попытки по старому снимку.
          attemptsBase = 0;
        } else {
          jobLog('warn', 'checkpoint not persisted after retries — progress may be replayed');
          // Воркеру дают знать, чтобы он показал это в журнале задачи, а не
          // только в stdout. Ошибку колбэка гасим: журнал не повод ронять run.
          if (opts.onCheckpointUnpersisted) {
            void (async () => opts.onCheckpointUnpersisted?.(job.id))()
              .catch((err) => jobLog('warn', 'onCheckpointUnpersisted threw', err));
          }
        }
        return true;
      },
    };

    // Владение регистрируем ДО запуска тела: и сам run (shouldStop,
    // saveCheckpoint), и finally с owned.delete обязаны видеть готовую карту.
    const entry: Owned = { runToken, abort, promise: Promise.resolve(), stopHeartbeat };
    owned.set(job.id, entry);

    // Тело задачи стартует отдельной микротаской: pollOnce обязан вернуть
    // управление циклу опроса, а не выполнять код воркера в своём стеке.
    // Иначе задача, падающая сразу, успевает вернуться в pending внутри того
    // же опроса и он же захватывает её снова — все maxAttempts сгорают за
    // микросекунды, а остальная очередь стоит.
    entry.promise = Promise.resolve().then(async () => {
      try {
        await opts.run(job, ctx);
        // На прерывании не пишем ничего: строка остаётся в running с
        // отпущенной арендой, и это делает shutdown() (двумя проходами, жетон
        // намеренно сохраняя). Влезать сюда — значит либо дублировать его
        // запись, либо стереть жетон под ещё дорабатывающим телом.
        if (!abort.signal.aborted) {
          if (manageTerminalStatus) {
            await fencedUpdateWithRetry(
              job.id, runToken, { status: statuses.done, ...clearOwnership },
              TERMINAL_WRITE_TRIES, TERMINAL_BACKOFF_MS,
            );
          } else {
            // Терминальный статус уже записало тело (или отмена пользователем) —
            // снимаем осадок владения. Строку, оставленную в running ради
            // возобновления, .neq(status) не тронет.
            await releaseOwnershipAfterForeignTerminal(job.id, runToken);
          }
        }
      } catch (err) {
        if (abort.signal.aborted) {
          jobLog('info', 'run interrupted (shutdown or lease lost); row left for reclaim');
          // Отпускаем аренду только если ушли сами: при lease-lost/lease-expired
          // строкой уже владеет сосед, и лезть к ней нечего.
          // Сюда попадает только тело, которое БРОСИЛО на отмене; тело, которое
          // отмену поймало и вернулось штатно, идёт успешным путём, и его
          // аренду отпускают два прохода shutdown().
          if (abort.signal.reason === 'shutdown') {
            // Но не раньше, чем закрыты внешние ресурсы: строка, отпущенная
            // здесь, уходит соседу немедленно (см. releaseGate).
            if (releaseGate) await releaseGate;
            await releaseLease(job.id, runToken);
          }
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        jobLog('error', `run failed: ${reason}`, err);
        if (!manageTerminalStatus) {
          // Терминальный статус пишет сам воркер, но он до этого не дошёл.
          // Без явного освобождения строка простояла бы весь leaseSeconds и
          // была бы перехвачена как падение — с тратой попытки.
          await releaseLease(job.id, runToken);
          return;
        }
        const attempts = attemptsBase + 1;
        const patch = attempts >= maxAttempts
          ? { status: statuses.failed, attempts, ...clearOwnership, ...(opts.failedPatch?.(reason, job.id) ?? {}) }
          : { status: statuses.pending, attempts, ...clearOwnership };
        await fencedUpdateWithRetry(job.id, runToken, patch, TERMINAL_WRITE_TRIES, TERMINAL_BACKOFF_MS);
      } finally {
        stopHeartbeat();
        if (owned.get(job.id)?.runToken === runToken) owned.delete(job.id);
      }
    });
  }

  return {
    async pollOnce() {
      if (halting()) return false;
      if (owned.size >= concurrency) {
        await sleep(500);
        return true;
      }
      const pending = await claimPending();
      const claim = pending.kind === 'empty' ? await claimExpired() : pending;
      // Запрос захвата не выполнился: об очереди мы ничего не узнали, а база
      // уже отвечает ошибками. Отвечаем «брать нечего», чтобы pollLoop выждал
      // свой интервал, а не долбил её без пауз.
      if (claim.kind === 'failed') return false;
      // Гонку проиграли: CAS вернул ноль строк без ошибки — строку только что
      // забрал сосед, значит в очереди было что брать. Просим позвать снова,
      // вместо сна до 30 с на ожидании realtime. Пауза перед этим — как в ветке
      // «все слоты заняты»: круг стоит два запроса, и на общей очереди из
      // двенадцати реплик без неё получается заметный холостой трафик.
      if (claim.kind === 'lost') {
        await sleep(500);
        return true;
      }
      if (claim.kind === 'empty') return false;
      /**
       * Раннер не берёт задачу, которую сам же ещё выполняет.
       *
       * Захват истёкшей аренды смотрит только на строку, а строка выглядит
       * свободной и тогда, когда её прежний прогон в ЭТОМ процессе ещё не
       * размотался: аренду перестают продлевать сразу после abort (потеря
       * аренды, простой дольше порога), а тело может дорабатывать минутами,
       * если стоит внутри зависшего сетевого вызова. Без этой проверки
       * получалось бы два тела одной задачи в одном процессе — для TG-аутрича
       * это второе подключение тех же MTProto-сессий и выключенные навсегда
       * аккаунты, для остальных очередей — двойная работа и двойные внешние
       * запросы.
       *
       * Аренду отпускаем: строка должна достаться кому-то, когда прежнее тело
       * закончит. Захват сюда же вернётся на следующем опросе — это не гонка на
       * месте, пауза между опросами есть всегда (pollLoop ждёт свой интервал на
       * ответ false).
       */
      if (owned.has(claim.job.id)) {
        log('warn', `[${table}] job ${claim.job.id} claimed while its previous run is still unwinding — releasing, will retry`);
        await releaseLease(claim.job.id, claim.runToken);
        return false;
      }
      // Сигнал мог прийти, пока захват был в полёте: shutdown() уже снял свой
      // снимок owned, и эту задачу никто бы не прервал и не отпустил — она
      // дожила бы до SIGKILL с живой арендой, а сосед прождал бы полный
      // leaseSeconds и записал бы это как падение.
      // beforeRelease здесь не нужен и звать его нечем: тело этой задачи не
      // запускалось (execute ниже не вызывался), внешних ресурсов у неё нет, а
      // строка простояла бы полный leaseSeconds.
      if (halting()) {
        log('info', `[${table}] claimed ${claim.job.id} during shutdown — releasing immediately`);
        await releaseLease(claim.job.id, claim.runToken);
        return false;
      }
      execute(claim.job, claim.runToken);
      return true;
    },

    // Повторный вызов возвращает ТОТ ЖЕ промис, а не пустой: воркеры зовут
    // shutdown() из обработчика сигнала и ещё раз после pollLoop, и второй
    // вызов обязан дождаться первого, иначе `await runner.shutdown()` в конце
    // main() только выглядит страховкой — процесс уходил бы, пока аренды ещё
    // отпускаются. Эту форму скопируют все ~29 воркеров.
    shutdown() {
      shutdownRun ??= runShutdown();
      return shutdownRun;
    },

    activeJobIds: () => Array.from(owned.keys()),
  };

  /**
   * Дать воркеру закрыть внешние ресурсы, пока аренда ещё наша.
   *
   * Ни исключение, ни зависание хука не должны помешать освобождению — поэтому
   * ошибка гасится в лог, а ожидание идёт с потолком. Функция не отвергается
   * никогда и возвращается не позже beforeReleaseCapMs.
   */
  async function runBeforeRelease(jobIds: string[]): Promise<void> {
    if (!opts.beforeRelease) return;
    let settled = false;
    const hook = Promise.resolve()
      .then(() => opts.beforeRelease?.(jobIds))
      .then(
        () => { settled = true; },
        (err) => {
          settled = true;
          log('error', `[${table}] beforeRelease threw — аренда отпускается всё равно`, err);
        },
      );
    await Promise.race([hook, sleep(beforeReleaseCapMs)]);
    if (!settled) {
      log('warn', `[${table}] beforeRelease не уложился в ${beforeReleaseCapMs} мс — отпускаю аренду, внешние ресурсы могут быть ещё открыты`);
    }
  }

  async function runShutdown(): Promise<void> {
      stopping = true;
      markShuttingDown();
      const snapshot = Array.from(owned.entries());
      for (const [, o] of snapshot) {
        o.abort.abort('shutdown');
        // Тело может зависнуть и не дойти до finally — таймер снимаем сами,
        // иначе продления живут до конца процесса.
        o.stopHeartbeat();
      }
      const release = () =>
        Promise.all(snapshot.map(([id, o]) => releaseLease(id, o.runToken)));
      if (snapshot.length > 0) {
        /**
         * Бюджет остановки заводится ОДНИМ таймером и здесь, до всего
         * остального: и хук, и паузы между проходами освобождения тратят то же
         * время, что достанется ожиданию тел. Раньше ожидание отсчитывалось
         * после освобождений, и реальная остановка стоила grace плюс секунда
         * паузы плюс запросы — за пятнадцать секунд деплоя это уже не влезало.
         */
        const graceExpired = sleep(shutdownGraceMs);
        /*
         * Хук — ПОСЛЕ abort и ДО первого освобождения.
         *
         * После abort: тело обязано перестать пользоваться клиентами прежде,
         * чем их закроют, иначе отправка налетит на рвущийся сокет.
         * До освобождения: в этом и весь смысл — пока lease_until не обнулён,
         * строку не подберёт никто, и сессии Telegram успевают закрыться до
         * того, как их откроет сосед.
         *
         * Присваивание releaseGate синхронно, до первого await: тело, брошенное
         * abort'ом выше, доберётся до своего catch не раньше следующего
         * микротаска и увидит уже готовый пропуск.
         */
        releaseGate = runBeforeRelease(snapshot.map(([id]) => id));
        await releaseGate;
        log('info', `[${table}] releasing ${snapshot.length} job(s) for fast handoff: ${snapshot.map(([id]) => id).join(', ')}`);
        await release();
        // Второй проход: продление, улетевшее в PostgREST до сигнала, могло
        // приземлиться после первого и снова сделать аренду живой.
        await sleep(1_000);
        await release();
        // Контрольное чтение: продление, ушедшее ещё раньше, могло приземлиться
        // и после второго прохода. Жетон в освобождении не трогаем — иначе
        // последний чекпойнт дорабатывающего тела не пройдёт ограждение.
        // Параллельно: последовательные чтения девяти задач на медленном
        // PostgREST не влезут в docker stop --timeout 15.
        await Promise.all(snapshot.map(async ([id, o]) => {
          const { data } = await client
            .from(table)
            .select('id, lease_until')
            .eq('id', id)
            .eq('run_token', o.runToken)
            .maybeSingle();
          if (data && data.lease_until != null) {
            log('warn', `[${table}] lease on ${id} came back after release — releasing again`);
            await releaseLease(id, o.runToken);
          }
        }));
        // Остаток бюджета — телам. Таймер тот же, что заведён в начале
        // остановки, так что хук и паузы освобождения уже вычтены.
        await Promise.race([
          Promise.allSettled(snapshot.map(([, o]) => o.promise)),
          graceExpired,
        ]);
      }
  }
}
