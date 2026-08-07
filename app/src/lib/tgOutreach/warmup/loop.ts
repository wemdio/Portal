/**
 * Прогрев: главный цикл.
 *
 * Держится на состоянии в БД, а не в памяти: за четыре дня процесс
 * гарантированно перезапустится (деплой, сторожевой таймер на 15 минут
 * простоя), и прогрев обязан продолжиться с той же точки. Каждый проход —
 * «какой сейчас день → есть ли план на него → какие переписки пора провести».
 *
 * Прогрев и боевой цикл кампании взаимоисключающие (это гарантируют API и
 * реестр запущенных кампаний в воркере), поэтому оба свободно пишут в общий
 * cooldown_until без конфликта и им не нужен отдельный счётчик пауз.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OutreachAccount,
  OutreachCampaign,
  OutreachProxy,
  TelegramSettings,
} from '../types';
import { buildClients, disconnectAll, type ActiveClient } from '../gramClient';
import type { LoopControl } from '../watchdog';
import { downloadSessionToTemp } from '../campaignLoop';
import { openaiGenerate } from '../openaiChat';
import { planDay } from './schedule';
import { warmupOpenAISettings } from './prompt';
import { runWarmupConversation, WarmupSendError, type WarmupSide } from './conversation';
import { resolveWarmupPeer, dropImportedContact, type ResolvedPeer } from './peer';
import { bootstrapAccountIdentity } from './identity';
import { withTimeout } from '../withTimeout';
import * as wdb from './db';
import type { WarmupConversation, WarmupMessage, WarmupRun } from './types';

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
): Promise<void> {
  const run = await wdb.getActiveRun(db, campaignId);
  if (!run) {
    // Логировать некуда — записи прогрева привязаны к запуску, а его нет.
    // Кампанию на всякий случай возвращаем из «прогрева» в «остановлена»:
    // иначе она застрянет в статусе, из которого нельзя запустить аутрич.
    await wdb.setCampaignWarming(db, campaignId, false);
    return;
  }

  const log: LogFn = (level, message, accountId) => {
    void wdb
      .logWarmup(db, { runId: run.id, campaignId, accountId, level, message })
      .catch(() => {
        // Логи прогрева — диагностика, а не бизнес-логика: сбой записи не
        // должен ронять сам прогрев.
      });
  };

  const { data: campaignRow } = await db
    .from('tg_outreach_campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  const campaign = campaignRow as OutreachCampaign | null;
  if (!campaign) {
    await wdb.setRunStatus(db, run.id, { status: 'failed', error_message: 'campaign_not_found' });
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
    await wdb.setRunStatus(db, run.id, {
      status: 'failed',
      error_message: 'need_at_least_two_accounts',
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
  if (clients.length < 2) {
    await disconnectAll(clients);
    await wdb.setRunStatus(db, run.id, {
      status: 'failed',
      error_message: 'not_enough_clients',
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

  // Процесс только что поднялся: то, что числится «идёт», осталось от прошлого
  // воркера и никуда уже не едет. Возвращаем в очередь сразу, а не ждём 45 минут
  // до признания переписки брошенной.
  const requeued = await wdb.requeueStuckConversations(db, run.id);
  if (requeued > 0) {
    log(
      'info',
      `Прогрев: возвращено в очередь ${requeued} переписок, прерванных перезапуском воркера.`,
    );
  }

  if (run.status === 'pending') {
    const startedAt = new Date().toISOString();
    await wdb.setRunStatus(db, run.id, {
      status: 'running',
      started_at: startedAt,
      current_day: 1,
    });
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
    if (shouldStop()) break;
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

  try {
    while (!shouldStop()) {
      onProgress?.();

      const fresh = await wdb.getActiveRun(db, campaignId);
      if (!fresh) break;

      const now = new Date();
      const day = dayNumber(run, now, tg.timezone_offset ?? 3);

      if (day > run.days) {
        const summary = await wdb.buildSummary(
          db,
          run.id,
          accounts.map((a) => ({ id: a.id, session_name: a.session_name })),
        );
        await wdb.skipRemainingForDay(db, run.id, run.days, 'run_finished');
        await wdb.setRunStatus(db, run.id, {
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
        await wdb.setRunStatus(db, run.id, { current_day: day });
        if (day > 1) await wdb.skipRemainingForDay(db, run.id, day - 1, 'day_over');
      }

      if (!(await wdb.isDayPlanned(db, run.id, day))) {
        const plan = planDay({
          accountIds: [...byAccountId.keys()],
          day,
          previousPairs: await wdb.loadPreviousPairs(db, run.id),
          window: planningWindow(now, tg),
          random: Math.random,
        });
        await wdb.saveDayPlan(db, run, day, plan);
        log('info', `Прогрев: день ${day} из ${run.days}, запланировано ${plan.length} переписок.`);
      }

      const due = await wdb.loadDueConversations(db, run.id, day, now);
      for (const conv of due) {
        if (shouldStop()) break;
        onProgress?.();
        await runOneConversation(db, conv, byAccountId, accountNames, log, onProgress);
      }

      await interruptibleSleep(POLL_INTERVAL_MS, shouldStop);
    }
  } finally {
    await disconnectAll(clients);
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
  log: LogFn,
  /**
   * Признак жизни для сторожевого таймера воркера. Переписка идёт минутами, и
   * без отметок на каждом шаге здоровый разговор выглядит зависшим циклом.
   */
  onProgress?: () => void,
): Promise<void> {
  const nameOf = (id: string) => accountNames.get(id) ?? id.slice(0, 8);
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

  let peerForA: ResolvedPeer | null = null;
  let peerForB: ResolvedPeer | null = null;
  try {
    // Таймауты стоят внутри resolveWarmupPeer — по одному на каждую попытку,
    // иначе внешний общий таймаут гасит функцию до перехода на запасной путь
    // через телефон, и переписка падает целиком вместо fallback.
    peerForA = await resolveWarmupPeer(a.client, {
      tg_username: b.account.tg_username ?? null,
      phone: b.account.phone ?? null,
    });
    onProgress?.();
    peerForB = await resolveWarmupPeer(b.client, {
      tg_username: a.account.tg_username ?? null,
      phone: a.account.phone ?? null,
    });
    onProgress?.();
  } catch (e) {
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
        ),
      sleep,
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
    if (e instanceof WarmupSendError) {
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
