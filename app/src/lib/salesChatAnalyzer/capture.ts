import 'server-only';

import { Api, TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mapMessage, bigToNum, type MappedMessage } from './messageMapper';
import { putMainS3Object } from '@/lib/mainS3Server';

/** Простой логгер, совместимый с WorkerLogger воркера. */
type LogFn = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** Максимум сообщений на диалог при ПОЛНОЙ выгрузке (инкремент не ограничен). */
const MAX_MESSAGES_PER_DIALOG = 5000;
/** Размер батча для вставки сообщений. */
const INSERT_BATCH = 200;
const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = Math.max(
  1,
  Number(process.env.SALES_CHAT_MAX_ATTACHMENT_BYTES ?? DEFAULT_MAX_ATTACHMENT_BYTES),
);

/** Сколько диалогов одного аккаунта обрабатывать параллельно. */
const DIALOG_CONCURRENCY = Math.max(
  1,
  Number(process.env.SALES_CHAT_SYNC_DIALOG_CONCURRENCY ?? 3),
);
/** Сколько вложений одного аккаунта скачивать параллельно (общий пул на все диалоги). */
const ATTACHMENT_CONCURRENCY = Math.max(
  1,
  Number(process.env.SALES_CHAT_SYNC_ATTACHMENT_CONCURRENCY ?? 3),
);

/**
 * Минималистичный семафор для ограничения параллелизма промисов.
 * Возвращает функцию-обёртку: `await limit(() => doWork())`.
 */
function createSemaphore(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;
  const next = (): void => {
    active -= 1;
    const fn = queue.shift();
    if (fn) fn();
  };
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
  };
}

type Semaphore = ReturnType<typeof createSemaphore>;

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

/** Дата (unix-секунды) последнего сообщения диалога, если известна. */
function dialogLastDate(dialog: { message?: { date?: number } | null; date?: number }): number | null {
  const d = dialog.message?.date ?? dialog.date;
  return typeof d === 'number' ? d : null;
}

/** Дата (unix-секунды) произвольного Telegram-сообщения. */
function rawMessageDate(msg: unknown): number | null {
  const d = (msg as { date?: number }).date;
  return typeof d === 'number' ? d : null;
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

function sanitizeStorageFilename(value: string | null, fallback: string): string {
  const raw = (value?.trim() || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return raw || fallback;
}

function buildAttachmentKey(accountId: string, peer: PeerInfo, mapped: MappedMessage): string {
  const filename = sanitizeStorageFilename(
    mapped.attachment?.file_name ?? null,
    `telegram-document-${mapped.tg_message_id}.bin`,
  );
  return [
    'tools',
    'sales-chat-analyzer',
    'attachments',
    accountId,
    String(peer.tg_peer_id),
    `${mapped.tg_message_id}-${filename}`,
  ].join('/');
}

async function findMessageId(
  admin: SupabaseClient,
  dialogId: string,
  tgMessageId: number,
): Promise<string | null> {
  const { data, error } = await admin
    .from('sales_chat_messages')
    .select('id')
    .eq('dialog_id', dialogId)
    .eq('tg_message_id', tgMessageId)
    .maybeSingle();
  if (error) throw new Error(`findMessageId: ${error.message}`);
  return (data?.id as string | undefined) ?? null;
}

async function attachmentAlreadyUploaded(
  admin: SupabaseClient,
  dialogId: string,
  tgMessageId: number,
): Promise<boolean> {
  const { data, error } = await admin
    .from('sales_chat_message_attachments')
    .select('status,s3_key')
    .eq('dialog_id', dialogId)
    .eq('tg_message_id', tgMessageId)
    .maybeSingle();
  if (error) throw new Error(`attachmentAlreadyUploaded: ${error.message}`);
  return Boolean(data?.status === 'uploaded' && data?.s3_key);
}

async function dialogNeedsAttachmentBackfill(admin: SupabaseClient, dialogId: string): Promise<boolean> {
  const { data: documentMessages, error } = await admin
    .from('sales_chat_messages')
    .select('tg_message_id')
    .eq('dialog_id', dialogId)
    .eq('media_type', 'document')
    .order('sent_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`dialogNeedsAttachmentBackfill: ${error.message}`);
  const ids = (documentMessages ?? [])
    .map((row) => Number((row as { tg_message_id?: unknown }).tg_message_id))
    .filter((id) => Number.isFinite(id));
  if (ids.length === 0) return false;

  // Берём все загруженные вложения этого диалога одним запросом БЕЗ .in([...]) —
  // .in() на 1000 bigint'ов раздувает URL до ~11KB и упирается в nginx-лимит на длину URI.
  // Индекс (dialog_id, tg_message_id) обслуживает запрос так же быстро.
  const { data: uploaded, error: uploadedError } = await admin
    .from('sales_chat_message_attachments')
    .select('tg_message_id')
    .eq('dialog_id', dialogId)
    .eq('status', 'uploaded');
  if (uploadedError) throw new Error(`dialogNeedsAttachmentBackfill uploaded: ${uploadedError.message}`);

  const uploadedIds = new Set((uploaded ?? []).map((row) => Number((row as { tg_message_id?: unknown }).tg_message_id)));
  return ids.some((id) => !uploadedIds.has(id));
}

async function upsertAttachment(
  admin: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from('sales_chat_message_attachments')
    .upsert(row, { onConflict: 'dialog_id,tg_message_id' });
  if (error) throw new Error(`upsertAttachment: ${error.message}`);
}

async function captureAttachment(opts: {
  admin: SupabaseClient;
  client: TelegramClient;
  msg: Api.Message;
  mapped: MappedMessage;
  accountId: string;
  dialogId: string;
  peer: PeerInfo;
  log: LogFn;
}): Promise<void> {
  const { admin, client, msg, mapped, accountId, dialogId, peer, log } = opts;
  const attachment = mapped.attachment;
  if (!attachment) return;

  try {
    if (await attachmentAlreadyUploaded(admin, dialogId, mapped.tg_message_id)) return;

    const messageId = await findMessageId(admin, dialogId, mapped.tg_message_id);
    const baseRow = {
      message_id: messageId,
      account_id: accountId,
      dialog_id: dialogId,
      tg_message_id: mapped.tg_message_id,
      tg_peer_id: peer.tg_peer_id,
      media_type: attachment.media_type,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      file_size_bytes: attachment.file_size_bytes,
    };

    if (attachment.file_size_bytes && attachment.file_size_bytes > MAX_ATTACHMENT_BYTES) {
      await upsertAttachment(admin, {
        ...baseRow,
        status: 'skipped',
        error_message: `File is larger than SALES_CHAT_MAX_ATTACHMENT_BYTES (${attachment.file_size_bytes} bytes)`,
      });
      return;
    }

    const downloaded = await client.downloadMedia(msg, {});
    if (!Buffer.isBuffer(downloaded) || downloaded.length === 0) {
      await upsertAttachment(admin, {
        ...baseRow,
        status: 'error',
        error_message: 'Telegram returned an empty media buffer',
      });
      return;
    }

    const key = buildAttachmentKey(accountId, peer, mapped);
    const uploaded = await putMainS3Object({
      key,
      body: downloaded,
      contentType: attachment.mime_type ?? 'application/octet-stream',
      cacheControl: 'private, max-age=300',
    });

    await upsertAttachment(admin, {
      ...baseRow,
      file_size_bytes: attachment.file_size_bytes ?? uploaded.size,
      s3_bucket: uploaded.bucket,
      s3_key: uploaded.key,
      status: 'uploaded',
      error_message: null,
      uploaded_at: new Date().toISOString(),
    });
  } catch (err) {
    const msgText = err instanceof Error ? err.message : String(err);
    log('warn', `[${accountId}] attachment ${mapped.tg_message_id} failed`, err);
    await upsertAttachment(admin, {
      account_id: accountId,
      dialog_id: dialogId,
      tg_message_id: mapped.tg_message_id,
      tg_peer_id: peer.tg_peer_id,
      media_type: attachment.media_type,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      file_size_bytes: attachment.file_size_bytes,
      status: 'error',
      error_message: msgText.slice(0, 500),
    }).catch(() => {});
  }
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
 * Обрабатывает один диалог: текстовые сообщения → вставка батчами,
 * вложения → отложенный параллельный пул (общий на аккаунт).
 */
async function syncOneDialog(opts: {
  admin: SupabaseClient;
  client: TelegramClient;
  entity: unknown;
  dialogId: string;
  peer: PeerInfo;
  accountId: string;
  selfName: string;
  sinceUnix: number;
  attachmentBackfillOnly: boolean;
  attachmentLimit: Semaphore;
  log: LogFn;
}): Promise<void> {
  const {
    admin,
    client,
    entity,
    dialogId,
    peer,
    accountId,
    selfName,
    sinceUnix,
    attachmentBackfillOnly,
    attachmentLimit,
    log,
  } = opts;

  let batch: ReturnType<typeof toRow>[] = [];
  let inserted = false;
  // Сначала ПОТОКОВО прогоняем все сообщения и собираем задачи на вложения.
  // Сами вложения качаем во второй фазе через общий семафор аккаунта,
  // чтобы не блокировать iterMessages I/O-боундом скачивания файлов.
  const pendingAttachments: Array<{ msg: Api.Message; mapped: MappedMessage }> = [];

  for await (const msg of client.iterMessages(
    entity as Parameters<typeof client.iterMessages>[0],
    { limit: MAX_MESSAGES_PER_DIALOG },
  )) {
    // iterMessages идёт от новых к старым — на старых обрываем инкремент.
    const msgDate = rawMessageDate(msg);
    if (!attachmentBackfillOnly && sinceUnix > 0 && msgDate !== null && msgDate <= sinceUnix) break;
    const mapped = mapMessage(msg);
    if (!mapped) continue;
    if (attachmentBackfillOnly && !mapped.attachment) continue;
    batch.push(toRow(mapped, accountId, dialogId, peer, selfName));
    if (mapped.attachment && msg instanceof Api.Message) {
      pendingAttachments.push({ msg, mapped });
    }
    if (batch.length >= INSERT_BATCH) {
      await insertMessages(admin, batch);
      batch = [];
      inserted = true;
    }
  }
  if (batch.length) {
    await insertMessages(admin, batch);
    inserted = true;
  }

  // Все сообщения теперь в БД — captureAttachment может находить message_id по (dialog_id, tg_message_id).
  if (pendingAttachments.length > 0) {
    await Promise.all(
      pendingAttachments.map(({ msg, mapped }) =>
        attachmentLimit(() =>
          captureAttachment({ admin, client, msg, mapped, accountId, dialogId, peer, log }),
        ),
      ),
    );
    inserted = true;
  }

  if (inserted) await recountDialog(admin, dialogId);
}

/**
 * Синхронизирует переписки аккаунта.
 * sinceUnix = 0 — полная выгрузка истории (первый запуск).
 * sinceUnix > 0 — инкремент: тянем только сообщения новее этой отметки;
 *   диалоги без новой активности пропускаются целиком.
 *
 * Параллелизм:
 *  - до DIALOG_CONCURRENCY диалогов обрабатываются одновременно (default 3);
 *  - до ATTACHMENT_CONCURRENCY вложений качаются одновременно на аккаунт (default 3);
 *  - параметры можно крутить через env SALES_CHAT_SYNC_DIALOG_CONCURRENCY /
 *    SALES_CHAT_SYNC_ATTACHMENT_CONCURRENCY (повышать осторожно — Telegram даёт
 *    FLOOD_WAIT при > ~30 RPS на client).
 */
export async function syncAccount(opts: {
  admin: SupabaseClient;
  account: SalesChatAccountLite;
  client: TelegramClient;
  selfName: string;
  sinceUnix: number;
  log: LogFn;
}): Promise<void> {
  const { admin, account, client, selfName, sinceUnix, log } = opts;

  const dialogs: Array<{ entity: unknown; lastDate: number | null }> = [];
  for await (const dialog of client.iterDialogs({})) {
    dialogs.push({ entity: dialog.entity, lastDate: dialogLastDate(dialog) });
  }

  await admin
    .from('sales_chat_accounts')
    .update({ backfill_dialogs_total: dialogs.length, backfill_dialogs_done: 0 })
    .eq('id', account.id);
  log(
    'info',
    `[${account.id}] sync: ${dialogs.length} dialogs (since=${sinceUnix}, ` +
      `dlg_concurrency=${DIALOG_CONCURRENCY}, att_concurrency=${ATTACHMENT_CONCURRENCY})`,
  );

  const dialogLimit = createSemaphore(DIALOG_CONCURRENCY);
  const attachmentLimit = createSemaphore(ATTACHMENT_CONCURRENCY);

  let done = 0;
  let lastReported = 0;
  const reportProgress = async (force = false): Promise<void> => {
    if (!force && done - lastReported < 10) return;
    lastReported = done;
    await admin
      .from('sales_chat_accounts')
      .update({ backfill_dialogs_done: done })
      .eq('id', account.id);
  };

  await Promise.all(
    dialogs.map(({ entity, lastDate }) =>
      dialogLimit(async () => {
        const peer = extractPeer(entity);
        if (peer) {
          try {
            const dialogId = await upsertDialog(admin, account.id, peer);
            const unchanged = sinceUnix > 0 && lastDate !== null && lastDate <= sinceUnix;
            const attachmentBackfillOnly =
              unchanged && (await dialogNeedsAttachmentBackfill(admin, dialogId));
            if (!unchanged || attachmentBackfillOnly) {
              await syncOneDialog({
                admin,
                client,
                entity,
                dialogId,
                peer,
                accountId: account.id,
                selfName,
                sinceUnix,
                attachmentBackfillOnly,
                attachmentLimit,
                log,
              });
            }
          } catch (err) {
            log('warn', `[${account.id}] sync dialog ${peer.tg_peer_id} failed`, err);
          }
        }
        done += 1;
        await reportProgress().catch(() => {});
      }),
    ),
  );
  await reportProgress(true).catch(() => {});
  log('info', `[${account.id}] sync done (${done} dialogs)`);
}
