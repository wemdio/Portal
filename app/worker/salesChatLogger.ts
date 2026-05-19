/**
 * Воркер «Анализатор сейлз-переписок».
 *
 * Держит постоянные MTProto-соединения для всех active-аккаунтов
 * (таблица sales_chat_accounts), сверяя БД ↔ память каждые RECONCILE_MS.
 * Для каждого аккаунта:
 *   - live-обработчик NewMessage пишет сообщения в реальном времени;
 *   - при backfill_status='pending' прогоняется полный бэкфилл истории.
 *
 * ПОЛНОСТЬЮ ИЗОЛИРОВАН от tgParser / tgOutreach / tgTranscribe и аккаунта «Лёши».
 */

import { Api, type TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { createSalesChatClient } from '@/lib/salesChatAnalyzer/gramClient';
import { unsealSession } from '@/lib/salesChatAnalyzer/session';
import { backfillAccount, persistLiveMessage, type SalesChatAccountLite } from '@/lib/salesChatAnalyzer/capture';
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const RECONCILE_MS = 15_000;
const WORKER_ID = `sales-chat-logger-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

interface ConnectedAccount {
  client: TelegramClient;
  account: SalesChatAccountLite;
  selfName: string;
}

const connected = new Map<string, ConnectedAccount>();
const backfillsInFlight = new Set<string>();

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

/** Сбрасывает зависший backfill_status='running' в 'pending' после рестарта. */
async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data } = await db
    .from('sales_chat_accounts')
    .update({ backfill_status: 'pending' })
    .eq('backfill_status', 'running')
    .select('id');
  if (data?.length) log('info', `Startup recovery: reset ${data.length} backfills to pending`);
}

async function markAuthError(accountId: string, message: string): Promise<void> {
  const db = requireSupabaseAdmin(log);
  await db
    .from('sales_chat_accounts')
    .update({ status: 'auth_error', last_error: message.slice(0, 500) })
    .eq('id', accountId);
}

/** Фоновый бэкфилл истории аккаунта. */
function startBackfill(entry: ConnectedAccount): void {
  const { account, client, selfName } = entry;
  if (backfillsInFlight.has(account.id)) return;
  backfillsInFlight.add(account.id);

  void (async () => {
    const db = requireSupabaseAdmin(log);
    try {
      await db.from('sales_chat_accounts').update({ backfill_status: 'running' }).eq('id', account.id);
      await backfillAccount({ admin: db, account, client, selfName, log });
      await db.from('sales_chat_accounts').update({ backfill_status: 'done' }).eq('id', account.id);
      log('info', `[${account.id}] backfill complete`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `[${account.id}] backfill failed`, err);
      await db
        .from('sales_chat_accounts')
        .update({ backfill_status: 'error', last_error: msg.slice(0, 500) })
        .eq('id', account.id);
    } finally {
      backfillsInFlight.delete(account.id);
    }
  })();
}

/** Подключает аккаунт: соединение, live-обработчик, бэкфилл при необходимости. */
async function connectAccount(row: {
  id: string;
  label: string | null;
  tg_user_id: number | null;
  session_sealed: string;
  backfill_status: string;
}): Promise<void> {
  const db = requireSupabaseAdmin(log);
  let client: TelegramClient;
  try {
    client = createSalesChatClient(unsealSession(row.session_sealed));
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      throw new Error('AUTH_KEY_UNREGISTERED: сессия недействительна');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', `[${row.id}] connect failed: ${msg}`);
    if (isAuthError(msg)) await markAuthError(row.id, msg);
    return;
  }

  const account: SalesChatAccountLite = {
    id: row.id,
    tg_user_id: row.tg_user_id,
    label: row.label,
  };
  let selfName = row.label ?? 'Аккаунт';
  try {
    selfName = selfDisplayName(await client.getMe(), selfName);
  } catch {
    // не критично
  }

  const entry: ConnectedAccount = { client, account, selfName };

  // Live-обработчик: пишет каждое новое сообщение (входящее и исходящее).
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const chat = await event.getChat();
      await persistLiveMessage({ admin: db, account, chat, msg: event.message, selfName });
    } catch (err) {
      log('warn', `[${row.id}] live message failed`, err);
    }
  }, new NewMessage({}));

  connected.set(row.id, entry);
  await db
    .from('sales_chat_accounts')
    .update({ last_connected_at: new Date().toISOString(), last_error: null })
    .eq('id', row.id);
  log('info', `[${row.id}] connected (${selfName})`);

  if (row.backfill_status === 'pending') startBackfill(entry);
}

async function disconnectAccount(accountId: string): Promise<void> {
  const entry = connected.get(accountId);
  if (!entry) return;
  connected.delete(accountId);
  await entry.client.disconnect().catch(() => {});
  log('info', `[${accountId}] disconnected`);
}

/** Сверяет список active-аккаунтов в БД с реально подключёнными. */
async function reconcile(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data: rows, error } = await db
    .from('sales_chat_accounts')
    .select('id,label,tg_user_id,session_sealed,backfill_status')
    .eq('status', 'active');
  if (error) {
    log('error', 'reconcile: failed to load accounts', error);
    return;
  }

  const desired = new Set((rows ?? []).map((r) => r.id as string));

  // Отключаем то, что больше не active.
  for (const accountId of [...connected.keys()]) {
    if (!desired.has(accountId)) await disconnectAccount(accountId);
  }

  // Подключаем новое; чиним разорванные соединения.
  for (const row of rows ?? []) {
    const existing = connected.get(row.id as string);
    if (!existing) {
      await connectAccount(row as Parameters<typeof connectAccount>[0]);
      continue;
    }
    if (!existing.client.connected) {
      try {
        await existing.client.connect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', `[${row.id}] reconnect failed: ${msg}`);
        await disconnectAccount(row.id as string);
        if (isAuthError(msg)) await markAuthError(row.id as string, msg);
      }
    }
  }
}

async function main(): Promise<void> {
  log('info', `Starting Sales Chat Logger worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  await startupRecovery();

  const shouldStop = setupGracefulShutdown(log);
  log('info', `Reconcile loop started (${RECONCILE_MS}ms)`);

  while (!shouldStop()) {
    try {
      await reconcile();
    } catch (err) {
      log('error', 'reconcile loop error', err);
    }
    await sleep(RECONCILE_MS);
  }

  log('info', 'Shutting down — disconnecting all accounts...');
  for (const accountId of [...connected.keys()]) {
    await disconnectAccount(accountId);
  }
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
