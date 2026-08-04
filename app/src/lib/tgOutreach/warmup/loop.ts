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
import { downloadSessionToTemp } from '../campaignLoop';
import { openaiGenerate } from '../openaiChat';
import { planDay } from './schedule';
import { warmupOpenAISettings } from './prompt';
import { runWarmupConversation, type WarmupSide } from './conversation';
import { resolveWarmupPeer, dropImportedContact, type ResolvedPeer } from './peer';
import { bootstrapAccountIdentity } from './identity';
import * as wdb from './db';
import type { WarmupConversation, WarmupRun } from './types';

/** Как часто цикл просыпается посмотреть, не пора ли провести переписку. */
const POLL_INTERVAL_MS = 60_000;

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

/** Какой день прогрева идёт сейчас (1-based). */
export function dayNumber(run: Pick<WarmupRun, 'started_at' | 'days'>, now: Date): number {
  if (!run.started_at) return 1;
  const elapsedDays = Math.floor(
    (now.getTime() - new Date(run.started_at).getTime()) / (24 * 3600 * 1000),
  );
  return Math.max(elapsedDays + 1, 1);
}

export async function runWarmupLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  onProgress?: () => void,
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

  const clients = await buildClients(
    accounts,
    proxies,
    (lvl, msg) => log(lvl, msg),
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

  const byAccountId = new Map<string, ActiveClient>(clients.map((c) => [c.account.id, c]));

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
  for (const c of clients) {
    if (shouldStop()) break;
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

  try {
    while (!shouldStop()) {
      onProgress?.();

      const fresh = await wdb.getActiveRun(db, campaignId);
      if (!fresh) break;

      const now = new Date();
      const day = dayNumber(run, now);

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
          totalDays: run.days,
          previousPairs: await wdb.loadPreviousPairs(db, run.id),
          window: activeWindowForDay(now, tg),
          random: Math.random,
        });
        await wdb.saveDayPlan(db, run, day, plan);
        log('info', `Прогрев: день ${day} из ${run.days}, запланировано ${plan.length} переписок.`);
      }

      const due = await wdb.loadDueConversations(db, run.id, day, now);
      for (const conv of due) {
        if (shouldStop()) break;
        onProgress?.();
        await runOneConversation(db, conv, byAccountId, log);
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
  log: LogFn,
): Promise<void> {
  const a = byAccountId.get(conv.account_a_id);
  const b = byAccountId.get(conv.account_b_id);
  if (!a || !b) {
    await wdb.finishConversation(db, conv.id, {
      status: 'failed',
      errorReason: 'account_not_connected',
    });
    return;
  }

  await wdb.markConversationRunning(db, conv.id);

  let peerForA: ResolvedPeer | null = null;
  let peerForB: ResolvedPeer | null = null;
  try {
    peerForA = await resolveWarmupPeer(a.client, {
      tg_username: b.account.tg_username ?? null,
      phone: b.account.phone ?? null,
    });
    peerForB = await resolveWarmupPeer(b.client, {
      tg_username: a.account.tg_username ?? null,
      phone: a.account.phone ?? null,
    });
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
  const sideA: WarmupSide = {
    accountId: a.account.id,
    send: async (text) => { await a.client.sendMessage(resolvedA.entity, { message: text }); },
  };
  const sideB: WarmupSide = {
    accountId: b.account.id,
    send: async (text) => { await b.client.sendMessage(resolvedB.entity, { message: text }); },
  };

  const settings = warmupOpenAISettings();
  try {
    const messages = await runWarmupConversation({
      sideA,
      sideB,
      initiatorAccountId: conv.initiator_account_id,
      plannedMessages: conv.planned_messages,
      generate: (history) => openaiGenerate(settings, history),
      sleep,
      random: Math.random,
    });
    await wdb.finishConversation(db, conv.id, { status: 'done', messages });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await wdb.finishConversation(db, conv.id, { status: 'failed', errorReason: reason });
    log('warning', `Прогрев: переписка не состоялась — ${reason}`, a.account.id);
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
