import 'server-only';

import { Api, TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mapMessage, bigToNum, type MappedMessage } from './messageMapper';

/** Простой логгер, совместимый с WorkerLogger воркера. */
type LogFn = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** Сколько максимум сообщений выкачивать на один диалог при бэкфилле. */
const MAX_BACKFILL_MESSAGES_PER_DIALOG = 5000;
/** Размер батча для вставки сообщений. */
const INSERT_BATCH = 200;

export interface SalesChatAccountLite {
  id: string;
  tg_user_id: number | null;
  label: string | null;
}

interface PeerInfo {
  tg_peer_id: number;
  peer_type: 'user' | 'chat' | 'channel';
  peer_title: string | null;
  peer_username: string | null;
}

/** Человекочитаемое имя из Api.User. */
function userDisplayName(u: Api.User): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || u.username || (u.phone ? `+${u.phone}` : `id${u.id}`);
}

/** Извлекает данные собеседника из Telegram-сущности диалога. */
export function extractPeer(entity: unknown): PeerInfo | null {
  if (entity instanceof Api.User) {
    const id = bigToNum(entity.id);
    if (id === null) return null;
    return {
      tg_peer_id: id,
      peer_type: 'user',
      peer_title: userDisplayName(entity),
      peer_username: entity.username ?? null,
    };
  }
  if (entity instanceof Api.Chat) {
    const id = bigToNum(entity.id);
    if (id === null) return null;
    return { tg_peer_id: id, peer_type: 'chat', peer_title: entity.title ?? null, peer_username: null };
  }
  if (entity instanceof Api.Channel) {
    const id = bigToNum(entity.id);
    if (id === null) return null;
    return {
      tg_peer_id: id,
      peer_type: 'channel',
      peer_title: entity.title ?? null,
      peer_username: entity.username ?? null,
    };
  }
  return null;
}

/** Создаёт/обновляет строку диалога, возвращает её id. */
async function upsertDialog(
  admin: SupabaseClient,
  accountId: string,
  peer: PeerInfo,
): Promise<string> {
  const { data, error } = await admin
    .from('sales_chat_dialogs')
    .upsert(
      {
        account_id: accountId,
        tg_peer_id: peer.tg_peer_id,
        peer_type: peer.peer_type,
        peer_title: peer.peer_title,
        peer_username: peer.peer_username,
      },
      { onConflict: 'account_id,tg_peer_id' },
    )
    .select('id')
    .single();
  if (error) throw new Error(`upsertDialog: ${error.message}`);
  return data.id as string;
}

/** Пересчитывает счётчик сообщений и время последнего сообщения в диалоге. */
async function recountDialog(admin: SupabaseClient, dialogId: string): Promise<void> {
  const { count } = await admin
    .from('sales_chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('dialog_id', dialogId);
  const { data: last } = await admin
    .from('sales_chat_messages')
    .select('sent_at')
    .eq('dialog_id', dialogId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  await admin
    .from('sales_chat_dialogs')
    .update({ message_count: count ?? 0, last_message_at: last?.sent_at ?? null })
    .eq('id', dialogId);
}

function toRow(
  mapped: MappedMessage,
  accountId: string,
  dialogId: string,
  peer: PeerInfo,
  selfName: string,
) {
  return {
    account_id: accountId,
    dialog_id: dialogId,
    tg_message_id: mapped.tg_message_id,
    tg_peer_id: peer.tg_peer_id,
    direction: mapped.direction,
    sender_tg_id: mapped.sender_tg_id,
    // Для 1-1 диалогов точно; для групп «in» — приблизительно (имя диалога).
    sender_name: mapped.direction === 'out' ? selfName : peer.peer_title,
    text: mapped.text,
    media_type: mapped.media_type,
    sent_at: mapped.sent_at,
  };
}

/** Идемпотентная вставка сообщений (дубли игнорируются по unique-индексу). */
async function insertMessages(admin: SupabaseClient, rows: ReturnType<typeof toRow>[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await admin
    .from('sales_chat_messages')
    .upsert(rows, { onConflict: 'account_id,tg_peer_id,tg_message_id', ignoreDuplicates: true });
  if (error) throw new Error(`insertMessages: ${error.message}`);
}

/**
 * Полный бэкфилл истории: перебирает все диалоги аккаунта и выкачивает сообщения.
 * Обновляет backfill_* поля аккаунта по ходу.
 */
export async function backfillAccount(opts: {
  admin: SupabaseClient;
  account: SalesChatAccountLite;
  client: TelegramClient;
  selfName: string;
  log: LogFn;
}): Promise<void> {
  const { admin, account, client, selfName, log } = opts;

  const dialogs: Array<{ entity: unknown }> = [];
  for await (const dialog of client.iterDialogs({})) {
    dialogs.push({ entity: dialog.entity });
  }

  await admin
    .from('sales_chat_accounts')
    .update({ backfill_dialogs_total: dialogs.length, backfill_dialogs_done: 0 })
    .eq('id', account.id);
  log('info', `[${account.id}] backfill: ${dialogs.length} dialogs`);

  let done = 0;
  for (const { entity } of dialogs) {
    const peer = extractPeer(entity);
    if (peer) {
      try {
        const dialogId = await upsertDialog(admin, account.id, peer);
        let batch: ReturnType<typeof toRow>[] = [];
        for await (const msg of client.iterMessages(
          entity as Parameters<typeof client.iterMessages>[0],
          { limit: MAX_BACKFILL_MESSAGES_PER_DIALOG },
        )) {
          const mapped = mapMessage(msg);
          if (!mapped) continue;
          batch.push(toRow(mapped, account.id, dialogId, peer, selfName));
          if (batch.length >= INSERT_BATCH) {
            await insertMessages(admin, batch);
            batch = [];
          }
        }
        await insertMessages(admin, batch);
        await recountDialog(admin, dialogId);
      } catch (err) {
        log('warn', `[${account.id}] backfill dialog ${peer.tg_peer_id} failed`, err);
      }
    }
    done += 1;
    if (done % 5 === 0 || done === dialogs.length) {
      await admin
        .from('sales_chat_accounts')
        .update({ backfill_dialogs_done: done })
        .eq('id', account.id);
    }
  }
  log('info', `[${account.id}] backfill done (${done} dialogs)`);
}

/** Записывает одно «живое» сообщение (из обработчика NewMessage). */
export async function persistLiveMessage(opts: {
  admin: SupabaseClient;
  account: SalesChatAccountLite;
  chat: unknown;
  msg: unknown;
  selfName: string;
}): Promise<void> {
  const { admin, account, chat, msg, selfName } = opts;
  const mapped = mapMessage(msg);
  if (!mapped) return;
  const peer = extractPeer(chat);
  if (!peer) return;

  const dialogId = await upsertDialog(admin, account.id, peer);
  await insertMessages(admin, [toRow(mapped, account.id, dialogId, peer, selfName)]);
  await recountDialog(admin, dialogId);
  await admin
    .from('sales_chat_accounts')
    .update({ last_event_at: new Date().toISOString() })
    .eq('id', account.id);
}
