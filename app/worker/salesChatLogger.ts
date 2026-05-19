/**
 * Воркер «Анализатор сейлз-переписок».
 *
 * Плановая синхронизация переписок в 01:00 МСК + ручной запуск
 * (через таблицу-очередь sales_chat_sync_runs). Каждый запуск проходит
 * по всем active-аккаунтам и инкрементально дотягивает новые сообщения
 * (первый запуск аккаунта — полная история).
 *
 * ПОЛНОСТЬЮ ИЗОЛИРОВАН от tgParser / tgOutreach / tgTranscribe и аккаунта «Лёши».
 */

import { Api, type TelegramClient } from 'telegram';
import { createSalesChatClient } from '@/lib/salesChatAnalyzer/gramClient';
import { unsealSession } from '@/lib/salesChatAnalyzer/session';
import { syncAccount } from '@/lib/salesChatAnalyzer/capture';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
/** Час МСК, после которого создаётся плановый запуск синхронизации. */
const SCHEDULED_HOUR_MSK = 1;
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

/** Возвращает зависшие запуски/аккаунты в очередь после рестарта. */
async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  await db.from('sales_chat_sync_runs').update({ status: 'pending' }).eq('status', 'running');
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

/** Атомарно забирает один pending-запуск. */
async function claimRun(): Promise<SyncRun | null> {
  const db = requireSupabaseAdmin(log);
  const { data: pending } = await db
    .from('sales_chat_sync_runs')
    .select('id, trigger')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pending) return null;

  const { data: claimed } = await db
    .from('sales_chat_sync_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, trigger')
    .maybeSingle();
  return (claimed as SyncRun) ?? null;
}

/** Синхронизирует один аккаунт; возвращает true при успехе. */
async function syncOneAccount(acc: AccountRow): Promise<boolean> {
  const db = requireSupabaseAdmin(log);
  let client: TelegramClient | null = null;
  try {
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
    if (client) await client.disconnect().catch(() => {});
  }
}

/** Прогоняет синхронизацию по всем активным аккаунтам. */
async function runSync(run: SyncRun): Promise<void> {
  const db = requireSupabaseAdmin(log);
  const { data: accounts } = await db
    .from('sales_chat_accounts')
    .select('id, label, tg_user_id, session_sealed, last_synced_at')
    .eq('status', 'active');

  const list = (accounts ?? []) as AccountRow[];
  await db
    .from('sales_chat_sync_runs')
    .update({ accounts_total: list.length, accounts_done: 0 })
    .eq('id', run.id);
  log('info', `Sync run ${run.id} (${run.trigger}): ${list.length} accounts`);

  let done = 0;
  for (const acc of list) {
    await syncOneAccount(acc);
    done += 1;
    await db.from('sales_chat_sync_runs').update({ accounts_done: done }).eq('id', run.id);
  }

  await db
    .from('sales_chat_sync_runs')
    .update({ status: 'done', finished_at: new Date().toISOString() })
    .eq('id', run.id);
  log('info', `Sync run ${run.id} done`);
}

async function pollOnce(): Promise<boolean> {
  await ensureScheduledRun();
  const run = await claimRun();
  if (!run) return false;
  try {
    await runSync(run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Sync run ${run.id} crashed`, err);
    await requireSupabaseAdmin(log)
      .from('sales_chat_sync_runs')
      .update({ status: 'error', error_message: msg.slice(0, 500), finished_at: new Date().toISOString() })
      .eq('id', run.id);
  }
  return true;
}

async function main(): Promise<void> {
  log('info', `Starting Sales Chat sync worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  await startupRecovery();

  const shouldStop = setupGracefulShutdown(log);
  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop,
    pollOnce,
    realtimeTables: ['sales_chat_sync_runs'],
  });
  log('info', 'Worker stopped');
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
