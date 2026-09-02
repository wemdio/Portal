/**
 * Прогрев: главный цикл.
 *
 * Держится на состоянии в БД, а не в памяти: за четыре дня процесс
 * гарантированно перезапустится (деплой, сторожевой таймер на 15 минут
 * простоя), и прогрев обязан продолжиться с той же точки. Каждый проход —
 * «какой сейчас день → есть ли план на него → какие переписки пора провести».
 *
 * Прогрев и боевой цикл кампании взаимоисключающие, поэтому оба свободно пишут
 * в общий cooldown_until без конфликта и им не нужен отдельный счётчик пауз.
 * Держит это правило СТАТУС КАМПАНИИ, а не реестр запущенных кампаний в памяти
 * воркера: греющаяся кампания стоит в `warming`, боевая — в `running`, и одна
 * колонка не бывает двумя значениями сразу. Подробности — в комментарии к
 * проверке `campaignBusyWithOutreach` ниже.
 */
import { Api } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OutreachAccount,
  OutreachCampaign,
  OutreachProxy,
  TelegramSettings,
} from '../types';
import {
  buildClients,
  disconnectAll,
  getUpdatedSessionString,
  type ActiveClient,
} from '../gramClient';
import type { LoopControl } from '../watchdog';
import { downloadSessionToTemp } from '../campaignLoop';
import { openaiGenerate } from '../openaiChat';
import { planDay } from './schedule';
import {
  dailyLimits,
  normalizeWarmupSettings,
  type DailyLimits,
  type WarmupSettings,
} from './settings';
import { warmupOpenAISettings } from './prompt';
import { runWarmupConversation, WarmupSendError, type WarmupSide } from './conversation';
import { resolveWarmupPeer, dropImportedContact, type ResolvedPeer } from './peer';
import { bootstrapAccountIdentity } from './identity';
import { withTimeout } from '../withTimeout';
import * as cdb from './chatDb';
import {
  loadPeerCache,
  peerIdentity,
  peerKey,
  savePeer,
  toInputPeer,
  type CachedPeer,
} from './peerCache';
import { assignChats, planChatActivities } from './chatSchedule';
import { runActivity, runJoin } from './chatRunner';
import * as wdb from './db';
import type {
  WarmupChat,
  WarmupConversation,
  WarmupMessage,
  WarmupRun,
  WarmupSummary,
} from './types';
import { CONVERSATION_STALE_MINUTES } from './types';

/** Как часто цикл просыпается посмотреть, не пора ли провести переписку. */
const POLL_INTERVAL_MS = 60_000;

/**
 * Сколько ждать ответа Telegram на один вызов внутри переписки.
 *
 * Минуты хватает с запасом на отправку сообщения и на поиск собеседника. Всё,
 * что дольше, — это не медленный ответ, а запрос, ушедший в сменившийся IP
 * мобильного прокси: он не вернётся никогда. Держать его нельзя — цикл
 * перестаёт отчитываться, и сторожевой таймер воркера через 15 минут роняет
 * весь процесс со всеми кампаниями (инцидент 06.08.2026, прогрев ATOL-1).
 */
const TELEGRAM_CALL_TIMEOUT_MS = Number(process.env.TG_WARMUP_CALL_TIMEOUT_MS) || 60_000;

type LogFn = (
  level: 'info' | 'warning' | 'error',
  msg: string,
  accountId?: string,
) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) {
    await sleep(Math.min(2000, Math.max(end - Date.now(), 0)));
  }
}

/**
 * Пауза между репликами переписки, которую рвёт сигнал остановки.
 *
 * Пауза доходит до 90 секунд (REPLY_DELAY_RANGE_SEC), и досидеть её до конца
 * после SIGTERM нельзя: контейнеру на остановку отводятся секунды, а после
 * перехвата прогона соседом следующая реплика ушла бы уже за чужой счёт — в тот
 * же диалог, который сосед в этот момент ведёт сам.
 *
 * Отменённая пауза БРОСАЕТ, а не возвращается: вернувшись, она отправила бы
 * следующую реплику немедленно, то есть остановка превратилась бы в пачку
 * сообщений подряд — ровно тот машинный след, ради ухода от которого паузы и
 * заведены. Ошибку разбирает вызывающий по `signal.aborted`, а не по её тексту.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(new Error('прогрев остановлен'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('прогрев остановлен'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Что раннер единого жизненного цикла (lib/jobs/lifecycle.ts) даёт телу
 * прогрева. Необязателен: та же функция должна оставаться вызываемой и без
 * аренды.
 */
export interface WarmupRunContext {
  /** Строка прогона, которую мы арендовали. Сверяется с активной. */
  runId: string;
  /** Взводится на SIGTERM воркера и при потере аренды. */
  signal: AbortSignal;
  /**
   * Жетон текущего захвата. Им ограждается КАЖДАЯ запись в строку прогона:
   * терминальный статус пишет само тело (manageTerminalStatus: false), и без
   * жетона вытесненный исполнитель проштамповал бы итог поверх работы нового
   * владельца.
   */
  runToken: string;
  /** false — прогон перехватили: работу прекратить. */
  saveCheckpoint(data: WarmupCheckpoint): Promise<boolean>;
}

/**
 * Чекпойнт прогрева — намеренно минимальный.
 *
 * Возобновляться по нему почти не нужно: день прогрева считается от
 * `started_at`, статусы переписок и уже отправленные сообщения лежат в
 * собственных строках, ключи сессий сохраняются по ходу. То есть перехваченный
 * прогон продолжается с того же места и с пустым чекпойнтом.
 *
 * Он нужен для другого, и это его главная работа: каждая запись продлевает
 * аренду и обнуляет бюджет попыток (attempts). Без него прогон, переживший три
 * грубые остановки за четверо суток — а деплоев за это время больше, — ушёл бы
 * в `failed` по счётчику потерь. День и последний диалог здесь для человека,
 * который смотрит на строку глазами: они говорят, где прогон был в момент
 * перехвата.
 */
export interface WarmupCheckpoint {
  day: number;
  last_conversation_id: number | null;
}

/** Снятие владения вместе с терминальным статусом — как в lib/jobs/lifecycle.ts. */
const CLEAR_OWNERSHIP = { lease_until: null, run_token: null, worker_id: null } as const;

/**
 * Статусы кампании, означающие «кампанией владеет боевой аутрич».
 *
 * `paused` в этом списке потому, что пауза — это середина передачи боевой
 * кампании между процессами (скрипт остановки деплоя ставит running → paused и
 * кладёт команду «старт»), а не свободная кампания.
 */
const OUTREACH_OWNED_STATUSES = new Set(['running', 'paused']);

/**
 * Активное окно суток по sleep_periods кампании, в UTC.
 *
 * Берём первый период сна («00:00-08:00» по умолчанию): его конец — момент
 * подъёма, начало — момент отбоя. Ночью аккаунты молчат, иначе переписка в
 * четыре утра сама по себе выглядит машинной.
 */
export function activeWindowForDay(
  now: Date,
  tg: Pick<TelegramSettings, 'sleep_periods' | 'timezone_offset'>,
): { start: Date; end: Date } {
  const offset = tg.timezone_offset ?? 3;
  const periods = tg.sleep_periods?.length ? tg.sleep_periods : ['00:00-08:00'];
  const parsed = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(periods[0]);
  const sleepHour = parsed ? Number(parsed[1]) : 0;
  const wakeHour = parsed ? Number(parsed[3]) : 8;

  const start = new Date(now);
  start.setUTCHours(wakeHour - offset, 0, 0, 0);
  const activeHours = ((sleepHour - wakeHour) + 24) % 24 || 16;
  const end = new Date(start.getTime() + activeHours * 3600 * 1000);
  return { start, end };
}

/**
 * Час по времени кампании, с которого начинается новый день прогрева.
 *
 * Раньше день отсчитывался ровно 24 часа от момента запуска. Прогрев, начатый в
 * 20:20, менял день в 20:20 — то есть посреди вечера, и «день прогрева» ехал по
 * суткам вместе со случайным временем нажатия кнопки. Оператор мыслит
 * календарём: новый день начинается утром.
 */
const DAY_START_HOUR = Number(process.env.TG_WARMUP_DAY_START_HOUR ?? '8');

/** Номер календарных суток прогрева для момента `t` (сутки начинаются в DAY_START_HOUR). */
function warmupDayIndex(t: Date, timezoneOffset: number): number {
  const localMs = t.getTime() + timezoneOffset * 3600_000 - DAY_START_HOUR * 3600_000;
  return Math.floor(localMs / 86_400_000);
}

/**
 * Какой день прогрева идёт сейчас (1-based).
 *
 * День меняется в DAY_START_HOUR, а не через 24 часа после старта. Побочный
 * эффект осознанный: прогрев, запущенный вечером, проживёт первый день
 * укороченным — до утра. Это ровно то, что значит «меньше дней = меньше
 * отправок», и лучше, чем ползающая по суткам граница.
 */
export function dayNumber(
  run: Pick<WarmupRun, 'started_at' | 'days'>,
  now: Date,
  timezoneOffset = 3,
): number {
  if (!run.started_at) return 1;
  const elapsed =
    warmupDayIndex(now, timezoneOffset) - warmupDayIndex(new Date(run.started_at), timezoneOffset);
  return Math.max(elapsed + 1, 1);
}

/**
 * Окно, по которому раскидываются переписки дня.
 *
 * Если день планируется уже после начала активного окна (воркер перезапустился
 * днём, прогрев только сейчас дошёл до нового дня), брать окно целиком нельзя:
 * прошедшие времена окажутся просроченными и все переписки уедут одной пачкой —
 * ровно та резкость, от которой уходили в кривой нагрузки.
 */
export function planningWindow(
  now: Date,
  tg: Pick<TelegramSettings, 'sleep_periods' | 'timezone_offset'>,
): { start: Date; end: Date } {
  const w = activeWindowForDay(now, tg);
  if (now > w.start && now < w.end) return { start: now, end: w.end };
  return w;
}

export async function runWarmupLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  onProgress?: () => void,
  control?: LoopControl,
  ctx?: WarmupRunContext,
): Promise<void> {
  const signal = ctx?.signal;
  /** Остановка: сигнал раннера (SIGTERM, потеря аренды) или флаг вызывающего. */
  const stopping = () => shouldStop() || signal?.aborted === true;

  const run = await wdb.getActiveRun(db, campaignId);
  if (!run) {
    // Логировать некуда — записи прогрева привязаны к запуску, а его нет.
    // Кампанию на всякий случай возвращаем из «прогрева» в «остановлена»:
    // иначе она застрянет в статусе, из которого нельзя запустить аутрич.
    await wdb.setCampaignWarming(db, campaignId, false);
    return;
  }
  // Арендовали одну строку, а активной оказалась другая — прогон, который мы
  // держим, уже не тот (оператор остановил его и завёл новый). Уникальный
  // частичный индекс не даёт двум прогонам кампании быть активными сразу, так
  // что это проверка от неожиданности, а не штатная ветка. Терминального
  // статуса не пишем: своей строке мы им соврали бы, чужую трогать нельзя.
  if (ctx && run.id !== ctx.runId) return;

  /**
   * Терминальная запись итога прогона.
   *
   * Два обязательных свойства, оба — следствие аренды:
   *  - на прерывании НЕ ПИШЕТ НИЧЕГО. Решение принимается по `signal.aborted`,
   *    а не по имени или тексту ошибки: настоящий таймаут обязан остаться
   *    отказом, а остановка воркера — не итог прогона. Строка остаётся в
   *    `running` с отпущенной арендой, и её штатно подберут;
   *  - снимает владение вместе со статусом (lease_until/run_token/worker_id),
   *    ровно как это делает библиотека в своей терминальной записи. Иначе
   *    законченный прогон навсегда остался бы похожим на арендованный.
   */
  const finishRun = async (patch: {
    status: WarmupRun['status'];
    error_message?: string | null;
    finished_at?: string;
    current_day?: number;
    summary?: WarmupSummary;
  }): Promise<void> => {
    if (signal?.aborted) return;
    await wdb.setRunStatus(db, run.id, { ...patch, ...(ctx ? CLEAR_OWNERSHIP : {}) }, ctx?.runToken);
  };

  /**
   * Рабочая (не терминальная) запись в строку прогона — с тем же ограждением.
   *
   * Владение не снимает: строка остаётся нашей и живёт дальше.
   */
  const updateRun = (patch: {
    status?: WarmupRun['status'];
    current_day?: number;
    started_at?: string;
  }): Promise<void> => wdb.setRunStatus(db, run.id, patch, ctx?.runToken);

  const log: LogFn = (level, message, accountId) => {
    void wdb
      .logWarmup(db, { runId: run.id, campaignId, accountId, level, message })
      .catch(() => {
        // Логи прогрева — диагностика, а не бизнес-логика: сбой записи не
        // должен ронять сам прогрев.
      });
  };

  /**
   * Тот же лог, но одна и та же фраза пишется один раз за прогон.
   *
   * Для жалоб на состояние, а не на событие: «в списке нет ни одного чата» —
   * правда на каждом круге, а круг идёт раз в минуту, и повторять её тысячу раз
   * значит утопить журнал, который оператор читает глазами. Сказали один раз —
   * дальше молчим, пока воркер не перезапустится.
   */
  const alreadySaid = new Set<string>();
  const logOnce: LogFn = (level, message, accountId) => {
    if (alreadySaid.has(message)) return;
    alreadySaid.add(message);
    log(level, message, accountId);
  };

  const { data: campaignRow } = await db
    .from('tg_outreach_campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  const campaign = campaignRow as OutreachCampaign | null;
  if (!campaign) {
    await finishRun({ status: 'failed', error_message: 'campaign_not_found' });
    return;
  }

  /*
   * Взаимное исключение с боевым аутричем — ЧЕМ ОНО ДЕРЖИТСЯ ТЕПЕРЬ.
   *
   * Раньше его держала карта в памяти воркера: прогрев и боевой цикл занимали
   * один и тот же слот в runningCampaigns, и второй просто не запускался. Такой
   * замок жил ровно столько, сколько процесс, и между репликами не работал
   * вовсе. Под арендой карты больше нет — обе стороны теперь опираются на одну
   * колонку, `tg_outreach_campaigns.status`, и на то, что она не бывает двумя
   * значениями сразу:
   *
   *  - боевой аутрич (задача 4) арендует САМУ строку кампании со статусом
   *    выполнения `running`. Кампания под прогревом стоит в `warming`, то есть
   *    для его раннера она структурно невидима — ни как ожидающая, ни как
   *    брошенная. Отдельного механизма ему не нужно, и заводить второй нельзя:
   *    два замка на одном ресурсе расходятся при первом же расхождении;
   *  - прогрев арендует строку прогона, а не кампании, и статусом кампании
   *    фильтровать захват не может (опция `where` библиотеки работает только по
   *    колонкам своей таблицы). Поэтому его половина замка — проверка здесь, в
   *    начале работы, до подключения хотя бы одного клиента Telegram.
   *
   * Состояние «прогон активен, а кампания занята аутричем» недостижимо через
   * интерфейс: POST warmup отказывает при `running`, POST start — при
   * `warming`. Значит попасть сюда можно только правкой базы руками или
   * ошибкой, и правильный ответ — остановить прогон с внятной причиной, а не
   * пытаться его переждать. Переждать было бы хуже: прогон, который выходит
   * молча, раннер захватит снова, потратит попытку и через три круга запишет в
   * `failed` уже без объяснения.
   */
  if (OUTREACH_OWNED_STATUSES.has(campaign.status)) {
    log(
      'error',
      'Прогрев остановлен: кампания сейчас занята боевым аутричем. Греть и писать клиентам одними аккаунтами одновременно нельзя — остановите аутрич и запустите прогрев заново.',
    );
    await finishRun({
      status: 'failed',
      error_message: 'campaign_busy_with_outreach',
      finished_at: new Date().toISOString(),
    });
    return;
  }

  await wdb.setCampaignWarming(db, campaignId, true);
  const tg = campaign.telegram_settings as TelegramSettings;

  const { data: accountRows } = await db
    .from('tg_outreach_accounts')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);
  const accounts = (accountRows ?? []) as OutreachAccount[];
  if (accounts.length < 2) {
    await finishRun({
      status: 'failed',
      error_message: 'need_at_least_two_accounts',
      finished_at: new Date().toISOString(),
    });
    log('error', 'Прогрев: нужно минимум два активных аккаунта — греть не с кем.');
    await wdb.setCampaignWarming(db, campaignId, false);
    return;
  }

  const { data: proxyRows } = await db
    .from('tg_outreach_proxies')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);
  const proxies = (proxyRows ?? []) as OutreachProxy[];

  // onProgress на каждую строку лога подключения: 16 аккаунтов по 30с таймаута
  // (а с ретраем и все 60с) — это до четверти часа, за которые сторожевой
  // таймер воркера успевает счесть кампанию зависшей и убить процесс.
  const clients = await buildClients(
    accounts,
    proxies,
    (lvl, msg) => { onProgress?.(); log(lvl, msg); },
    (storagePath) => downloadSessionToTemp(db, storagePath),
    db,
  );
  /*
   * Всё, что после подключения, идёт под общим finally, и это обязательное
   * условие жизни под арендой: клиенты Telegram закрываются на ЛЮБОМ пути
   * выхода — на успехе, на исключении, на остановке. Клиент, переживший выход
   * из цикла, — это второе соединение той же сессией, когда прогон подберёт
   * следующий владелец: AUTH_KEY_DUPLICATED, три подряд — и аккаунт
   * выключается насовсем (lib/tgOutreach/gramClient.ts). Раньше половина
   * ранних выходов закрывала клиенты вручную, а часть путей (исключение в
   * загрузке кэша собеседников, в уборке переписок) не закрывала вовсе.
   */
  try {
    if (clients.length < 2) {
      await finishRun({
        status: 'failed',
        error_message: 'not_enough_clients',
        finished_at: new Date().toISOString(),
      });
      log(
        'error',
        `Прогрев: подключились только ${clients.length} аккаунтов из ${accounts.length} — прогревать не с кем. Проверьте прокси.`,
      );
      await wdb.setCampaignWarming(db, campaignId, false);
      return;
    }

    // Ручка для сторожевого таймера: погасить только эту кампанию, не роняя
    // воркер с остальными.
    if (control) control.forceDisconnect = () => disconnectAll(clients);

    const byAccountId = new Map<string, ActiveClient>(clients.map((c) => [c.account.id, c]));
    // Имена всех аккаунтов кампании, включая не подключившихся: сбой
    // «не подключён» должен называть виновника по имени, а не по uuid.
    const accountNames = new Map<string, string>(accounts.map((a) => [a.id, a.session_name]));

    // Собеседники, найденные в прошлые дни и прошлые прогоны. Загружаем один раз:
    // без этого каждая переписка начиналась бы с импорта контакта, а по этому
    // счётчику Telegram и придушил прогрев 07.08.2026 на четвёртом дне.
    const peerCache = await loadPeerCache(db, campaignId);
    if (peerCache.size) {
      log('info', `Прогрев: ${peerCache.size} собеседников взято из памяти, искать заново не нужно.`);
    }

    // Перехват переписок — только теперь, когда прогон уже наш: см. развёрнутое
    // объяснение порога в requeueStuckConversations (warmup/db.ts).
    const requeued = await wdb.requeueStuckConversations(db, run.id);
    if (requeued > 0) {
      log(
        'info',
        `Прогрев: возвращено в очередь ${requeued} переписок, брошенных прошлым исполнителем.`,
      );
    }

    // Признак «прогон ещё ни разу не стартовал» — пустой started_at, а НЕ
    // статус `pending`: библиотека переводит строку в `running` при захвате, и
    // к этому месту статус уже `running` всегда. По статусу условие молча
    // никогда бы не выполнилось, started_at остался бы null, и dayNumber() до
    // конца прогона возвращал бы первый день.
    if (!run.started_at) {
      const startedAt = new Date().toISOString();
      await updateRun({ status: 'running', started_at: startedAt, current_day: 1 });
      run.started_at = startedAt;
      run.status = 'running';
      log('info', `Прогрев начат: ${run.days} дней, подключено ${clients.length} аккаунтов.`);
    }

    // Личность нужна до первой переписки: без tg_username/phone аккаунт нечем
    // адресовать, и все его переписки провалятся на резолве.
    //
    // onProgress на каждом аккаунте обязателен: этот цикл идёт последовательно по
    // всем клиентам и до 05.08.2026 был самым длинным участком без единого
    // признака жизни — от последнего «подключён» до входа в главный цикл. Именно
    // здесь прогрев и вставал, а сторожевой таймер убивал воркер целиком.
    for (const c of clients) {
      if (stopping()) break;
      onProgress?.();
      try {
        const identity = await bootstrapAccountIdentity(db, c.client, c.account);
        c.account.tg_user_id = identity.tg_user_id;
        c.account.tg_username = identity.tg_username;
        if (identity.phone) c.account.phone = identity.phone;
      } catch (e) {
        log(
          'warning',
          `Прогрев: не смог определить личность аккаунта — ${e instanceof Error ? e.message : String(e)}`,
          c.account.id,
        );
      }
    }
    onProgress?.();

    const chatsById = new Map<string, WarmupChat>();
    /** Свои tg_user_id: на публике аккаунты не должны отвечать друг другу. */
    const ownUserIds = new Set<number>();
    for (const a of accounts) if (a.tg_user_id) ownUserIds.add(Number(a.tg_user_id));

    /*
     * Уборка после прошлого исполнителя — ровно один раз, до первого круга.
     *
     * `requeueStuckActivities` тоже гейтится порогом устаревания (см. её
     * комментарий в chatDb.ts): под арендой «всё, что в работе, — чужое и
     * мёртвое» больше не верно.
     *
     * Зовём независимо от того, включён ли этап чатов: если выключен, активностей
     * нет и апдейт не заденет ни строки.
     */
    const requeuedOnStart = await cdb.requeueStuckActivities(db, run.id);
    if (requeuedOnStart > 0) {
      log('info', `Активность в чатах: возвращено в очередь ${requeuedOnStart} действий после перезапуска.`);
    }

    while (!stopping()) {
      onProgress?.();

      const fresh = await wdb.getActiveRun(db, campaignId);
      // Прогона среди активных больше нет — его остановил оператор (команда
      // «warmup_stop» ставит `stopped` прямо в строку). Терминальный статус уже
      // записан, писать свой нечего.
      if (!fresh) break;

      const now = new Date();
      const day = dayNumber(run, now, tg.timezone_offset ?? 3);

      // Настройки перечитываются каждый круг: оператор может понизить нагрузку,
      // не останавливая прогрев. План дня строится один раз, поэтому правки
      // вступают со следующего дня — так и написано в интерфейсе.
      const settings = normalizeWarmupSettings(fresh.settings);
      const publicChatsEnabled = settings.public_chats;
      const limits = dailyLimits(settings, day);

      if (day > run.days) {
        const summary = await wdb.buildSummary(
          db,
          run.id,
          accounts.map((a) => ({ id: a.id, session_name: a.session_name })),
        );
        await wdb.skipRemainingForDay(db, run.id, run.days, 'run_finished');
        if (publicChatsEnabled) {
          await cdb.skipRemainingActivities(db, run.id, run.days, 'прогрев завершён');
        }
        await finishRun({
          status: 'finished',
          finished_at: new Date().toISOString(),
          current_day: run.days,
          summary,
        });
        log(
          'info',
          `Прогрев завершён: ${summary.conversations_done} переписок, ${summary.messages_sent} сообщений, аккаунтов с проблемами — ${summary.accounts_failed}. Боевой аутрич запускается вручную.`,
        );
        // Кампания снова доступна для запуска аутрича — решение за оператором.
        await wdb.setCampaignWarming(db, campaignId, false);
        break;
      }

      if (fresh.current_day !== day) {
        await updateRun({ current_day: day });
        if (day > 1) {
          await wdb.skipRemainingForDay(db, run.id, day - 1, 'day_over');
          // Вчерашние активности тоже закрываем: не выполненная вечером реакция
          // сегодня уже не нужна, а «в плане» из позавчера в ленте путает.
          if (publicChatsEnabled) {
            await cdb.skipRemainingActivities(db, run.id, day - 1, 'день закончился');
          }
        }
        // Смена дня — второе место чекпойнта: она случается раз в сутки, но
        // ровно после неё стоит зафиксировать, где прогон находится.
        if (ctx && !(await ctx.saveCheckpoint({ day, last_conversation_id: null }))) break;
      }

      if (!(await wdb.isDayPlanned(db, run.id, day))) {
        const plan = planDay({
          accountIds: [...byAccountId.keys()],
          conversationsPerAccount: limits.conversations,
          messagesPerConversation: limits.messages,
          previousPairs: await wdb.loadPreviousPairs(db, run.id),
          window: planningWindow(now, tg),
          random: Math.random,
        });
        await wdb.saveDayPlan(db, run, day, plan);
        log('info', `Прогрев: день ${day} из ${run.days}, запланировано ${plan.length} переписок.`);
      }

      const due = await wdb.loadDueConversations(db, run.id, day, now);
      for (const conv of due) {
        if (stopping()) break;
        onProgress?.();
        await runOneConversation(
          db, conv, byAccountId, accountNames, peerCache, log, onProgress, signal,
        );
        // Чекпойнт после каждой переписки. Возобновление он почти не двигает
        // (день считается от started_at, статусы переписок и ушедшие сообщения
        // уже в своих строках) — его работа в другом: продлить аренду и вернуть
        // бюджет попыток в ноль, чтобы четырёхсуточный прогон не ушёл в failed
        // по счётчику деплоев. false — прогон перехватили, работу прекращаем.
        if (ctx && !(await ctx.saveCheckpoint({ day, last_conversation_id: conv.id }))) break;
      }

      if (publicChatsEnabled) {
        await ensureChatStageReady({
          db, run, campaignId, accountIds: [...byAccountId.keys()],
          chatsById, settings, tg, log, logOnce,
        });
        if (chatsById.size) {
          await runChatStage({
            db, run, day, now, tg, limits,
            byAccountId, accountNames, chatsById, ownUserIds,
            shouldStop: stopping, log, onProgress,
          });
        }
      }

      await persistSessions(db, clients, log);

      await interruptibleSleep(POLL_INTERVAL_MS, stopping);
    }
  } finally {
    // Перед разрывом соединений — последний раз: цикл мог выйти сразу после
    // переселения на другой дата-центр, и без этого ключ уехал бы вместе с
    // процессом.
    await persistSessions(db, clients, log);
    await disconnectAll(clients);
  }
}

/**
 * Сохранить ключи сессий, если Telegram их обновил.
 *
 * Ключ меняется, когда Telegram переселяет аккаунт на другой дата-центр. Боевой
 * цикл сохраняет его после каждого круга, а прогрев до 09.08.2026 не сохранял
 * вовсе — притом что живёт он несколько суток и переживает по десятку
 * перезапусков воркера. Потерянный ключ означает, что после рестарта аккаунт в
 * Telegram уже не войдёт и сессию придётся выпускать заново руками.
 *
 * Сбой записи не должен ронять прогрев: в худшем случае ключ сохранится на
 * следующем проходе, они идут раз в минуту.
 */
async function persistSessions(
  db: SupabaseClient,
  clients: ActiveClient[],
  log: LogFn,
): Promise<void> {
  for (const { client, account } of clients) {
    try {
      const updated = await getUpdatedSessionString(client);
      if (!updated || updated === account.session_data) continue;

      const { error } = await db
        .from('tg_outreach_accounts')
        .update({ session_data: updated })
        .eq('id', account.id);
      if (error) {
        log(
          'warning',
          `Аккаунт ${account.session_name}: не смог сохранить обновлённый ключ сессии — ${error.message}.`,
          account.id,
        );
        continue;
      }
      // Обновляем и в памяти, иначе на каждом проходе будем видеть расхождение
      // и переписывать одно и то же.
      account.session_data = updated;
      log('info', `Аккаунт ${account.session_name}: ключ сессии обновился, сохранил.`, account.id);
    } catch {
      // Клиент мог уже отвалиться — не повод прерывать проход по остальным.
    }
  }
}

/**
 * Подготовить этап публичных чатов: подтянуть список чатов и разложить по ним
 * аккаунты.
 *
 * Зовётся каждый круг, а не один раз при старте: этап можно включить настройкой
 * посреди прогрева. Раскладка защищена проверкой `hasChatAssignments` — состав
 * чатов у аккаунта должен быть постоянным, иначе он весь прогрев мигрирует по
 * чатам, а это само по себе заметный след.
 */
async function ensureChatStageReady(params: {
  db: SupabaseClient;
  run: WarmupRun;
  campaignId: string;
  accountIds: string[];
  chatsById: Map<string, WarmupChat>;
  settings: WarmupSettings;
  tg: TelegramSettings;
  log: LogFn;
  /**
   * Лог «один раз за прогон» — для жалобы на пустой список чатов: она верна на
   * каждом круге, а круги идут раз в минуту.
   */
  logOnce: LogFn;
}): Promise<void> {
  const { db, run, campaignId, accountIds, chatsById, settings, tg, log, logOnce } = params;

  const chats = await cdb.loadUsableChats(db, campaignId);
  chatsById.clear();
  for (const c of chats) chatsById.set(c.id, c);

  if (!chats.length) {
    logOnce('warning', 'Активность в чатах включена, но в списке нет ни одного проверенного чата — этап пропущен.');
    return;
  }

  if (!(await cdb.hasChatAssignments(db, run.id))) {
    const perAccount = Math.min(settings.chats_per_account, chats.length);
    const assignments = assignChats(accountIds, chats.map((c) => c.id), settings.chats_per_account);
    const w = planningWindow(new Date(), tg);
    const span = Math.max(w.end.getTime() - w.start.getTime(), 1);
    const plannedAt = new Map<string, string>(
      assignments.map((a) => [
        `${a.accountId}|${a.chatId}`,
        // Вступления растянуты по окну: шестнадцать аккаунтов, зашедших в один
        // чат за минуту, — очевидный след.
        new Date(w.start.getTime() + Math.floor(Math.random() * span)).toISOString(),
      ]),
    );
    await cdb.saveChatAssignments(db, run, assignments, plannedAt);
    log(
      'info',
      `Активность в чатах: ${chats.length} чатов, каждому аккаунту назначено до ${perAccount}. Вступление растянуто на сегодня.`,
    );
  }
}

/**
 * Один проход этапа публичных чатов: вступления и активности, которым пора.
 *
 * Вынесено из главного цикла отдельной функцией: тело цикла и так ведёт день,
 * план и переписки, а этап добавляет к нему вторую очередь работ со своими
 * правилами. Ни одна ошибка здесь не поднимается наверх — этап необязательный
 * и не должен ронять прогрев, ради которого всё и запускалось.
 */
async function runChatStage(args: {
  db: SupabaseClient;
  run: WarmupRun;
  day: number;
  now: Date;
  tg: TelegramSettings;
  /** Дневные нормы прогона: сколько ответов и реакций даёт один аккаунт. */
  limits: DailyLimits;
  byAccountId: Map<string, ActiveClient>;
  accountNames: Map<string, string>;
  chatsById: Map<string, WarmupChat>;
  ownUserIds: Set<number>;
  shouldStop: () => boolean;
  log: LogFn;
  onProgress?: () => void;
}): Promise<void> {
  const {
    db, run, day, now, tg, limits, byAccountId, accountNames, chatsById, ownUserIds,
    shouldStop, log, onProgress,
  } = args;

  const nameOf = (id: string) => accountNames.get(id) ?? id.slice(0, 8);

  // Вступления: у каждого своё время внутри дня, поэтому проверяем на каждом
  // проходе, а не разом при старте.
  const dueJoins = await cdb.loadDueJoins(db, run.id, now);
  for (const member of dueJoins) {
    if (shouldStop()) return;
    onProgress?.();
    const chat = chatsById.get(member.chat_id);
    const client = byAccountId.get(member.account_id);
    if (!chat || !client) continue;
    await runJoin({
      db,
      member: {
        id: member.id,
        account_id: member.account_id,
        chat_id: member.chat_id,
        campaign_id: member.campaign_id,
      },
      chat,
      client: client.client,
      accountName: nameOf(member.account_id),
      log,
    });
  }

  // План дня строим только по тем парам, где вступление уже состоялось: писать
  // в чат, куда не вошёл, всё равно нельзя.
  if (!(await cdb.isActivityDayPlanned(db, run.id, day))) {
    const joined = await cdb.loadJoinedAssignments(db, run.id);
    if (joined.length) {
      const plan = planChatActivities({
        assignments: joined,
        replies: limits.chatMessages,
        reactions: limits.chatReactions,
        window: planningWindow(now, tg),
        random: Math.random,
      });
      await cdb.saveActivityPlan(db, run, day, plan);
      const replies = plan.filter((p) => p.kind === 'reply').length;
      log(
        'info',
        `Активность в чатах: день ${day}, запланировано ${replies} ответов и ${plan.length - replies} реакций.`,
      );
    }
  }

  const dueActivities = await cdb.loadDueActivities(
    db, run.id, day, now, CONVERSATION_STALE_MINUTES,
  );
  for (const activity of dueActivities) {
    if (shouldStop()) return;
    onProgress?.();
    const chat = chatsById.get(activity.chat_id);
    const client = byAccountId.get(activity.account_id);
    if (!chat || !client) {
      await cdb.finishActivity(db, activity.id, {
        status: 'skipped',
        errorReason: client ? 'чат недоступен' : 'аккаунт не подключён',
      });
      continue;
    }
    await runActivity({
      db,
      activity,
      chat,
      client,
      ownUserIds,
      accountName: nameOf(activity.account_id),
      log,
      onProgress,
    });
  }
}

/**
 * Провести одну запланированную переписку.
 *
 * Резолвим peer с обеих сторон заранее: писать будут оба аккаунта по очереди, и
 * узнать на середине разговора, что вторая сторона не может ответить, хуже, чем
 * не начинать вовсе.
 */
async function runOneConversation(
  db: SupabaseClient,
  conv: WarmupConversation,
  byAccountId: Map<string, ActiveClient>,
  accountNames: Map<string, string>,
  /** Запомненные собеседники: переживают перезапуск воркера, живут в БД. */
  peerCache: Map<string, CachedPeer>,
  log: LogFn,
  /**
   * Признак жизни для сторожевого таймера воркера. Переписка идёт минутами, и
   * без отметок на каждом шаге здоровый разговор выглядит зависшим циклом.
   */
  onProgress?: () => void,
  /**
   * Сигнал остановки раннера. Решение «остановка или настоящий сбой»
   * принимается ТОЛЬКО по нему: на остановке переписка не помечается ни
   * done, ни failed — она остаётся как есть, с уже сохранёнными сообщениями,
   * и её подберёт следующий владелец прогона. По тексту или имени ошибки такое
   * решение принимать нельзя: настоящий таймаут обязан остаться отказом.
   */
  signal?: AbortSignal,
): Promise<void> {
  const nameOf = (id: string) => accountNames.get(id) ?? id.slice(0, 8);
  if (signal?.aborted) return;
  const a = byAccountId.get(conv.account_a_id);
  const b = byAccountId.get(conv.account_b_id);
  if (!a || !b) {
    // Виновник — по имени, и только он: раньше немой «account_not_connected»
    // помечал обоих участников, и жертва выглядела сломанной наравне с виновником.
    const missing = [conv.account_a_id, conv.account_b_id].filter((id) => !byAccountId.has(id));
    const missingNames = missing.map(nameOf).join(', ');
    await wdb.finishConversation(db, conv.id, {
      status: 'failed',
      errorReason: `account_not_connected: ${missingNames}`,
    });
    log(
      'warning',
      `Прогрев: переписка ${nameOf(conv.account_a_id)} ↔ ${nameOf(conv.account_b_id)} не состоялась — не подключён к Telegram: ${missingNames} (причина в ошибках подключения выше).`,
      missing.length === 1 ? missing[0] : undefined,
    );
    return;
  }

  await wdb.markConversationRunning(db, conv.id);

  /**
   * Найти собеседника — или взять запомненного.
   *
   * Каждый поиск это либо резолв @username, либо импорт телефона в контакты, а
   * второе Telegram считает по жёсткому счётчику: 07.08.2026 прогрев упёрся в
   * него на четвёртом дне, и 32 переписки из 37 сорвались здесь же. Состав
   * аккаунтов постоянный, поэтому каждую пару ищем один раз за кампанию.
   */
  const resolveCached = async (
    viewer: ActiveClient,
    target: ActiveClient,
  ): Promise<ResolvedPeer | null> => {
    const key = peerKey(viewer.account.id, target.account.id);
    const cached = peerCache.get(key);
    if (cached) return { entity: toInputPeer(cached), imported: false };

    const found = await resolveWarmupPeer(viewer.client, {
      tg_username: target.account.tg_username ?? null,
      phone: target.account.phone ?? null,
    });
    if (!found) return null;

    if (found.entity instanceof Api.User) {
      const identity = peerIdentity(found.entity);
      if (identity) {
        peerCache.set(key, identity);
        await savePeer(db, {
          campaignId: conv.campaign_id,
          viewerAccountId: viewer.account.id,
          targetAccountId: target.account.id,
          peer: identity,
        });
      }
    }
    return found;
  };

  let peerForA: ResolvedPeer | null = null;
  let peerForB: ResolvedPeer | null = null;
  try {
    // Таймауты стоят внутри resolveWarmupPeer — по одному на каждую попытку,
    // иначе внешний общий таймаут гасит функцию до перехода на запасной путь
    // через телефон, и переписка падает целиком вместо fallback.
    peerForA = await resolveCached(a, b);
    onProgress?.();
    peerForB = await resolveCached(b, a);
    onProgress?.();
  } catch (e) {
    // Нас остановили посреди поиска — это не отказ переписки. Оставляем её как
    // есть: следующий владелец прогона возьмёт её заново.
    if (signal?.aborted) return;
    const reason = e instanceof Error ? e.message : String(e);
    await wdb.finishConversation(db, conv.id, {
      status: 'failed',
      errorReason: `resolve_failed: ${reason}`,
    });
    log('warning', `Прогрев: не смог найти собеседника — ${reason}`, a.account.id);
    return;
  }

  if (!peerForA || !peerForB) {
    await wdb.finishConversation(db, conv.id, {
      status: 'failed',
      errorReason: 'peer_not_resolvable',
    });
    log(
      'warning',
      `Прогрев: у аккаунта нет ни @username, ни телефона — адресовать нечем.`,
      (peerForA ? b : a).account.id,
    );
    return;
  }

  const resolvedA = peerForA;
  const resolvedB = peerForB;
  // Отправка под таймаутом: без него один запрос, ушедший в сменившийся IP
  // прокси, вешает переписку навсегда — и вместе с ней весь воркер.
  const sideA: WarmupSide = {
    accountId: a.account.id,
    send: async (text) => {
      await withTimeout(
        a.client.sendMessage(resolvedA.entity, { message: text }),
        TELEGRAM_CALL_TIMEOUT_MS,
        'отправка сообщения',
        signal,
      );
    },
  };
  const sideB: WarmupSide = {
    accountId: b.account.id,
    send: async (text) => {
      await withTimeout(
        b.client.sendMessage(resolvedB.entity, { message: text }),
        TELEGRAM_CALL_TIMEOUT_MS,
        'отправка сообщения',
        signal,
      );
    },
  };

  const settings = warmupOpenAISettings();
  const preview = (s: string) => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
  };
  // Копим отправленное и после каждой реплики пишем в журнал и в строку
  // переписки: сообщение, ушедшее в Telegram, обязано пережить смерть процесса
  // и быть видимым в UI сразу, а не после финиша всей переписки.
  const sentSoFar: WarmupMessage[] = [];
  try {
    const messages = await runWarmupConversation({
      sideA,
      sideB,
      initiatorAccountId: conv.initiator_account_id,
      plannedMessages: conv.planned_messages,
      // Зависший запрос к модели тоже останавливает цикл; сбой генерации
      // переписка переживает — вместо реплики подставляется банальная фраза.
      generate: (history) =>
        withTimeout(
          openaiGenerate(settings, history),
          TELEGRAM_CALL_TIMEOUT_MS,
          'генерация реплики',
          signal,
        ),
      // Пауза между репликами рвётся сигналом — иначе остановка ждала бы до
      // 90 секунд на каждой реплике (см. abortableSleep).
      sleep: (ms) => abortableSleep(ms, signal),
      random: Math.random,
      onMessage: async (msg, index, total) => {
        // Отметка жизни на каждой реплике: переписка из десяти сообщений с
        // паузами до 90 секунд идёт дольше порога сторожевого таймера, и без
        // этого здоровый разговор выглядел бы зависанием.
        onProgress?.();
        const sender = msg.account_id === a.account.id ? a.account : b.account;
        const receiver = msg.account_id === a.account.id ? b.account : a.account;
        log(
          'info',
          `${sender.session_name} → ${receiver.session_name} (${index + 1}/${total}): «${preview(msg.content)}»`,
          sender.id,
        );
        sentSoFar.push(msg);
        await wdb.updateConversationMessages(db, conv.id, [...sentSoFar]);
      },
    });
    await wdb.finishConversation(db, conv.id, { status: 'done', messages });
  } catch (e) {
    // Остановка — не итог переписки. Строка остаётся в «выполняется» с уже
    // сохранёнными сообщениями: следующий владелец прогона подберёт её по тому
    // же порогу устаревания, что и любую брошенную. Решаем по сигналу, а не по
    // типу ошибки: и прерванная пауза, и прерванная отправка приходят сюда
    // обычным Error, а настоящий таймаут обязан остаться отказом.
    if (signal?.aborted) {
      log(
        'info',
        `Прогрев: переписка ${a.account.session_name} ↔ ${b.account.session_name} прервана остановкой воркера (ушло ${sentSoFar.length} из ${conv.planned_messages}) — статус не меняем.`,
      );
    } else if (e instanceof WarmupSendError) {
      await wdb.finishConversation(db, conv.id, {
        status: 'failed',
        messages: e.sent,
        errorReason: `отправка не удалась (${nameOf(e.failedAccountId)}): ${e.message}`,
      });
      log(
        'warning',
        `Прогрев: переписка ${a.account.session_name} ↔ ${b.account.session_name} оборвалась на отправке от ${nameOf(e.failedAccountId)} (ушло ${e.sent.length} из ${conv.planned_messages}) — ${e.message}`,
        e.failedAccountId,
      );
    } else {
      const reason = e instanceof Error ? e.message : String(e);
      await wdb.finishConversation(db, conv.id, { status: 'failed', errorReason: reason });
      log('warning', `Прогрев: переписка не состоялась — ${reason}`, a.account.id);
    }
  } finally {
    // Импортированные контакты убираем всегда: постоянная взаимная сеть из всех
    // аккаунтов партии — легко вычисляемый след.
    for (const [client, peer] of [
      [a.client, resolvedA],
      [b.client, resolvedB],
    ] as const) {
      if (!peer.imported) continue;
      try {
        await dropImportedContact(client, peer.entity);
      } catch {
        // Контакт мог не создаться или уже быть удалён — не повод валить переписку.
      }
    }
  }
}
