import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SalesCopilotConfig, CopilotDialog, CopilotDraftMessage } from './types';
import { chunkDialogue } from '../knowledgeBase/chunker';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

const BATCH_SIZE = 100;
const MSG_FETCH_LIMIT = 100;
const MAX_MESSAGES_PER_DIALOG = 1000;
const RATE_LIMIT_DELAY = 2000;

// ---------------------------------------------------------------------------
// TG message fetch helpers
// ---------------------------------------------------------------------------

async function fetchAllMessages(
  client: TelegramClient,
  entity: Api.User,
  log: LogFn,
): Promise<Api.Message[]> {
  const all: Api.Message[] = [];
  let offsetId = 0;

  while (all.length < MAX_MESSAGES_PER_DIALOG) {
    try {
      const batch = await client.getMessages(entity, {
        limit: MSG_FETCH_LIMIT,
        offsetId,
      });
      if (batch.length === 0) break;

      for (const msg of batch) {
        if (msg instanceof Api.Message) all.push(msg);
      }

      if (batch.length < MSG_FETCH_LIMIT) break;
      offsetId = batch[batch.length - 1].id;
      await sleep(500);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('FloodWaitError')) {
        log('warning', 'FloodWait during message fetch, pausing 30s');
        await sleep(30_000);
        continue;
      }
      throw err;
    }
  }

  return all.reverse();
}

async function fetchNewMessages(
  client: TelegramClient,
  entity: Api.User,
  minId: number,
  log: LogFn,
): Promise<Api.Message[]> {
  const all: Api.Message[] = [];
  let offsetId = 0;

  while (true) {
    try {
      const batch = await client.getMessages(entity, {
        limit: MSG_FETCH_LIMIT,
        minId,
        offsetId,
      });
      if (batch.length === 0) break;

      for (const msg of batch) {
        if (msg instanceof Api.Message) all.push(msg);
      }

      if (batch.length < MSG_FETCH_LIMIT) break;
      offsetId = batch[batch.length - 1].id;
      await sleep(500);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('FloodWaitError')) {
        log('warning', 'FloodWait during incremental fetch, pausing 30s');
        await sleep(30_000);
        continue;
      }
      throw err;
    }
  }

  return all.reverse();
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export async function ensureDialog(
  db: SupabaseClient,
  configId: string,
  user: Api.User,
): Promise<CopilotDialog> {
  const tgUserId = Number(user.id);
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    user.username ||
    `ID:${user.id}`;

  const { data: existing } = await db
    .from('copilot_dialogs')
    .select('*')
    .eq('config_id', configId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();

  if (existing) return existing as CopilotDialog;

  const { data: created, error } = await db
    .from('copilot_dialogs')
    .upsert(
      {
        config_id: configId,
        tg_user_id: tgUserId,
        tg_username: user.username ?? null,
        tg_display_name: displayName,
        is_bot: !!user.bot,
      },
      { onConflict: 'config_id,tg_user_id' },
    )
    .select('*')
    .single();

  if (error) throw new Error(`ensureDialog failed: ${error.message}`);
  return created as CopilotDialog;
}

export async function loadChatHistory(
  db: SupabaseClient,
  dialogId: string,
  limit?: number,
): Promise<CopilotDraftMessage[]> {
  let query = db
    .from('copilot_messages')
    .select('role, content, message_date')
    .eq('dialog_id', dialogId)
    .order('message_date', { ascending: true });

  if (limit) query = query.limit(limit);

  const { data } = await query;
  return (data ?? []).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
    timestamp: m.message_date,
  }));
}

// ---------------------------------------------------------------------------
// KB integration — create/update kb_documents + kb_chunks from dialog history
// ---------------------------------------------------------------------------

async function upsertDialogToKb(
  db: SupabaseClient,
  dialog: CopilotDialog,
  userId: string,
): Promise<string | null> {
  const { data: messages } = await db
    .from('copilot_messages')
    .select('role, content, message_date')
    .eq('dialog_id', dialog.id)
    .order('message_date', { ascending: true });

  if (!messages?.length) return null;

  const formatted = messages.map(m => ({
    speaker: m.role === 'assistant' ? 'Менеджер' : 'Клиент',
    text: m.content,
    date: new Date(m.message_date).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  }));

  const title = `${dialog.tg_display_name}${dialog.tg_username ? ` (@${dialog.tg_username})` : ''}`;
  const contentText = formatted
    .map(m => `[${m.date}] ${m.speaker}: ${m.text}`)
    .join('\n');
  const tokenCount = Math.ceil(contentText.length / 4);
  const chunks = chunkDialogue(formatted);

  let docId = dialog.kb_document_id;

  if (docId) {
    await db
      .from('kb_documents')
      .update({
        content_text: contentText,
        token_count: tokenCount,
        metadata: { message_count: messages.length, copilot_dialog_id: dialog.id },
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId);

    await db.from('kb_chunks').delete().eq('document_id', docId);
  } else {
    const { data: doc, error } = await db
      .from('kb_documents')
      .insert({
        user_id: userId,
        title,
        category: 'sales_chats',
        source_type: 'imported',
        description: `Telegram переписка с ${dialog.tg_display_name}`,
        content_text: contentText,
        token_count: tokenCount,
        metadata: { message_count: messages.length, copilot_dialog_id: dialog.id },
        status: 'ready',
      })
      .select('id')
      .single();

    if (error || !doc) return null;
    docId = doc.id;

    await db.from('copilot_dialogs').update({ kb_document_id: docId }).eq('id', dialog.id);
  }

  if (chunks.length > 0 && docId) {
    const rows = chunks.map((c, i) => ({
      document_id: docId!,
      chunk_index: i,
      content: c.content,
      token_count: c.tokenCount,
      metadata: c.metadata,
    }));
    await db.from('kb_chunks').insert(rows);
  }

  return docId;
}

// ---------------------------------------------------------------------------
// syncDialogMessages — incremental or full fetch + save to DB + optional KB
// ---------------------------------------------------------------------------

export async function syncDialogMessages(
  client: TelegramClient,
  db: SupabaseClient,
  dialog: CopilotDialog,
  entity: Api.User,
  log: LogFn,
  options?: { updateKb?: boolean; userId?: string },
): Promise<number> {
  const tgMessages = dialog.last_synced_msg_id
    ? await fetchNewMessages(client, entity, dialog.last_synced_msg_id, log)
    : await fetchAllMessages(client, entity, log);

  if (tgMessages.length === 0) return 0;

  const rows = tgMessages
    .filter(msg => msg.message)
    .map(msg => ({
      dialog_id: dialog.id,
      tg_message_id: msg.id,
      role: msg.out ? 'assistant' : 'user',
      content: msg.message!,
      message_date: new Date(msg.date * 1000).toISOString(),
    }));

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await db
        .from('copilot_messages')
        .upsert(batch, { onConflict: 'dialog_id,tg_message_id' });
    }
  }

  const maxMsgId = Math.max(...tgMessages.map(m => m.id));
  const lastMsg = tgMessages[tgMessages.length - 1];
  const lastMsgDate = lastMsg
    ? new Date(lastMsg.date * 1000).toISOString()
    : dialog.last_message_date;

  const { count } = await db
    .from('copilot_messages')
    .select('id', { count: 'exact', head: true })
    .eq('dialog_id', dialog.id);

  await db
    .from('copilot_dialogs')
    .update({
      last_synced_msg_id: maxMsgId,
      last_message_date: lastMsgDate,
      message_count: count ?? dialog.message_count,
      tg_username: entity.username ?? dialog.tg_username,
      tg_display_name:
        [entity.firstName, entity.lastName].filter(Boolean).join(' ') ||
        entity.username ||
        dialog.tg_display_name,
      updated_at: new Date().toISOString(),
    })
    .eq('id', dialog.id);

  if (options?.updateKb && options.userId) {
    const freshDialog = { ...dialog, last_synced_msg_id: maxMsgId };
    await upsertDialogToKb(db, freshDialog, options.userId);
  }

  return rows.length;
}

// ---------------------------------------------------------------------------
// initialSync — batched first-run sync of all dialogs + messages + KB
// ---------------------------------------------------------------------------

export async function initialSync(
  client: TelegramClient,
  config: SalesCopilotConfig,
  db: SupabaseClient,
  log: LogFn,
  shouldStop: () => boolean,
): Promise<void> {
  log('info', 'Начинаю первичную синхронизацию диалогов...');

  const tgDialogs = await client.getDialogs({});
  const userDialogs = tgDialogs.filter(d => {
    if (!d.entity || !(d.entity instanceof Api.User)) return false;
    const u = d.entity;
    if (config.ignore_bots && u.bot) return false;
    if (config.ignore_no_username && !u.username) return false;
    if (config.excluded_chat_ids?.includes(Number(u.id))) return false;
    return true;
  });

  log('info', `Найдено ${userDialogs.length} диалогов с пользователями (из ${tgDialogs.length} всего)`);

  for (const dialog of userDialogs) {
    await ensureDialog(db, config.id, dialog.entity as Api.User);
  }

  const startOffset = config.initial_sync_offset;
  for (let i = startOffset; i < userDialogs.length; i += BATCH_SIZE) {
    if (shouldStop()) {
      log('info', 'Синхронизация прервана (stop signal)');
      return;
    }

    const end = Math.min(i + BATCH_SIZE, userDialogs.length);
    log(
      'info',
      `Синхронизация батча: диалоги ${i + 1}–${end} из ${userDialogs.length}`,
    );

    for (let j = i; j < end; j++) {
      if (shouldStop()) return;

      const dialog = userDialogs[j];
      const user = dialog.entity as Api.User;
      const displayName =
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.username ||
        `ID:${user.id}`;

      try {
        const dbDialog = await ensureDialog(db, config.id, user);

        if (!dbDialog.last_synced_msg_id) {
          const count = await syncDialogMessages(client, db, dbDialog, user, log, {
            updateKb: true,
            userId: config.user_id,
          });
          log('info', `Синхронизирован: ${displayName} (${count} сообщений)`);
        }

        await sleep(RATE_LIMIT_DELAY);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log('error', `Ошибка синхронизации ${displayName}: ${errMsg}`);
        if (errMsg.includes('FloodWaitError')) {
          log('warning', 'FloodWait — пауза 60 сек');
          await sleep(60_000);
        }
      }
    }

    await db
      .from('sales_copilot_configs')
      .update({ initial_sync_offset: end })
      .eq('id', config.id);
  }

  if (!shouldStop()) {
    await db
      .from('sales_copilot_configs')
      .update({
        initial_sync_completed: true,
        initial_sync_offset: userDialogs.length,
        last_full_sync_at: new Date().toISOString(),
      })
      .eq('id', config.id);
    log('info', `Первичная синхронизация завершена: ${userDialogs.length} диалогов`);
  }
}

// ---------------------------------------------------------------------------
// hourlySync — lightweight check: compare dialog.date, fetch only changed
// ---------------------------------------------------------------------------

export async function hourlySync(
  client: TelegramClient,
  config: SalesCopilotConfig,
  db: SupabaseClient,
  log: LogFn,
): Promise<void> {
  log('info', 'Запуск периодической синхронизации...');

  const tgDialogs = await client.getDialogs({});
  let synced = 0;
  let newCount = 0;

  for (const dialog of tgDialogs) {
    if (!dialog.entity || !(dialog.entity instanceof Api.User)) continue;

    const user = dialog.entity;
    if (config.ignore_bots && user.bot) continue;
    if (config.excluded_chat_ids?.includes(Number(user.id))) continue;

    const lastMsgDate = dialog.date ? new Date(dialog.date * 1000) : null;
    if (!lastMsgDate) continue;

    try {
      const dbDialog = await ensureDialog(db, config.id, user);

      const dbLastDate = dbDialog.last_message_date
        ? new Date(dbDialog.last_message_date)
        : null;
      const needsSync = !dbLastDate || lastMsgDate.getTime() > dbLastDate.getTime();
      const isNew = !dbDialog.last_synced_msg_id;

      if (needsSync || isNew) {
        await syncDialogMessages(client, db, dbDialog, user, log, {
          updateKb: true,
          userId: config.user_id,
        });
        synced++;
        if (isNew) newCount++;
        await sleep(1000);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('FloodWaitError') || errMsg.includes('PeerFloodError')) {
        log('warning', 'FloodWait — прерывание периодической синхронизации');
        break;
      }
      log('warning', `Sync ошибка: ${errMsg}`);
    }
  }

  await db
    .from('sales_copilot_configs')
    .update({ last_full_sync_at: new Date().toISOString() })
    .eq('id', config.id);

  log('info', `Периодическая синхронизация завершена: ${synced} обновлено, ${newCount} новых`);
}
