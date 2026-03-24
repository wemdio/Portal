import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SalesCopilotConfig, CopilotDraftMessage } from './types';
import { generateDraft, classifyDialog } from './llm';
import { searchChunks } from '../knowledgeBase/contextRetriever';
import { COPILOT_KB_CATEGORIES } from '../knowledgeBase/types';
import {
  initialSync,
  hourlySync,
  ensureDialog,
  syncDialogMessages,
  loadChatHistory,
} from './dialogSync';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isInSleepPeriod(sleepPeriods: string[], timezoneOffset: number): boolean {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const localMinutes = (utcH * 60 + utcM + timezoneOffset * 60 + 1440) % 1440;

  for (const period of sleepPeriods) {
    const match = period.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!match) continue;
    const startMin = Number(match[1]) * 60 + Number(match[2]);
    const endMin = Number(match[3]) * 60 + Number(match[4]);

    if (startMin <= endMin) {
      if (localMinutes >= startMin && localMinutes < endMin) return true;
    } else {
      if (localMinutes >= startMin || localMinutes < endMin) return true;
    }
  }
  return false;
}

async function autoDismissStaledrafts(
  db: SupabaseClient,
  configId: string,
  tgUserId: number,
  dialogId: string | null,
): Promise<void> {
  const { data: pending } = await db
    .from('sales_copilot_drafts')
    .select('id, created_at')
    .eq('config_id', configId)
    .eq('tg_user_id', tgUserId)
    .eq('status', 'pending');
  if (!pending?.length || !dialogId) return;

  for (const draft of pending) {
    const { count } = await db
      .from('copilot_messages')
      .select('id', { count: 'exact', head: true })
      .eq('dialog_id', dialogId)
      .eq('role', 'assistant')
      .gt('message_date', draft.created_at);

    if ((count ?? 0) > 0) {
      await db
        .from('sales_copilot_drafts')
        .update({ status: 'dismissed', acted_at: new Date().toISOString() })
        .eq('id', draft.id);
    }
  }
}

async function hasPendingDraft(
  db: SupabaseClient,
  configId: string,
  tgUserId: number,
): Promise<boolean> {
  const { count } = await db
    .from('sales_copilot_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('config_id', configId)
    .eq('tg_user_id', tgUserId)
    .eq('status', 'pending');
  return (count ?? 0) > 0;
}

const DISMISS_COOLDOWN_DAYS = 30;

async function isDismissedRecently(
  db: SupabaseClient,
  configId: string,
  tgUserId: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - DISMISS_COOLDOWN_DAYS * 24 * 3600 * 1000).toISOString();
  const { count } = await db
    .from('sales_copilot_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('config_id', configId)
    .eq('tg_user_id', tgUserId)
    .eq('draft_type', 'proactive')
    .eq('status', 'dismissed')
    .gte('acted_at', cutoff);
  return (count ?? 0) > 0;
}

async function loadCompiledBrief(db: SupabaseClient): Promise<string> {
  try {
    const { data } = await db
      .from('kb_compiled_brief')
      .select('brief')
      .eq('id', 'default')
      .single();
    return data?.brief?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Fetch 2-3 KB chunks relevant to the current conversation.
 * Single DB query, no LLM call. Returns ~300-600 tokens.
 */
const RU_STOPWORDS = new Set([
  'это', 'как', 'что', 'для', 'или', 'при', 'так', 'уже', 'все', 'вот',
  'они', 'мне', 'мой', 'вас', 'ваш', 'его', 'она', 'нас', 'наш', 'они',
  'тут', 'там', 'был', 'был', 'еще', 'нет', 'да', 'ну', 'бы', 'же',
  'очень', 'если', 'тоже', 'здравствуйте', 'добрый', 'день', 'привет',
  'спасибо', 'пожалуйста', 'могу', 'можно', 'нужно', 'хочу',
]);

async function fetchRelevantDetails(
  db: SupabaseClient,
  chatMessages: CopilotDraftMessage[],
): Promise<string> {
  try {
    const keywords = chatMessages
      .slice(-4)
      .map(m => m.content)
      .join(' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !RU_STOPWORDS.has(w.toLowerCase()))
      .slice(0, 8)
      .join(' ');

    if (!keywords) return '';

    const { chunks } = await searchChunks(db, keywords, {
      categories: COPILOT_KB_CATEGORIES,
      limit: 5,
    });
    if (chunks.length === 0) return '';

    return chunks
      .map(c => `[${c.document_title}]\n${c.content}`)
      .join('\n\n');
  } catch {
    return '';
  }
}

function buildKbPrompt(brief: string, details: string): string {
  const parts: string[] = [];
  if (brief) parts.push(`## Общие знания о компании\n${brief}`);
  if (details) parts.push(`## Детали по теме разговора\n${details}`);
  if (parts.length === 0) return '';
  return `\n\n[БАЗА ЗНАНИЙ КОМПАНИИ]\n${parts.join('\n\n')}\n[/БАЗА ЗНАНИЙ КОМПАНИИ]`;
}

async function generateDraftText(
  history: CopilotDraftMessage[],
  systemPrompt: string,
  model: string,
): Promise<string | null> {
  const result = await generateDraft(history, systemPrompt, model);
  return result.text;
}

async function writeLog(db: SupabaseClient, configId: string, level: string, message: string) {
  await db.from('sales_copilot_logs').insert({ config_id: configId, level, message }).then(() => {});
}

/**
 * Register a real-time NewMessage event handler for reactive draft generation.
 * Fires instantly when a private message arrives — no polling needed.
 * Returns a cleanup function to remove the handler.
 */
async function setupReactiveHandler(
  client: TelegramClient,
  config: SalesCopilotConfig,
  db: SupabaseClient,
  log: LogFn,
): Promise<() => void> {
  const { NewMessage } = await import('telegram/events');

  const processingUsers = new Set<number>();

  const handler = async (event: { message: Api.Message }) => {
    const message = event.message;
    if (!message.isPrivate) return;

    if (!config.reactive_enabled) return;
    if (isInSleepPeriod(config.sleep_periods ?? [], config.timezone_offset ?? 3)) return;

    let sender: Api.User;
    try {
      const s = await message.getSender();
      if (!s || !(s instanceof Api.User)) return;
      sender = s;
    } catch { return; }

    const displayName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.username || `ID:${sender.id}`;

    if (config.ignore_bots && sender.bot) return;
    if (config.ignore_no_username && !sender.username) return;

    const tgUserId = Number(sender.id);
    if (config.excluded_chat_ids?.includes(tgUserId)) return;
    if (sender.username && config.excluded_usernames?.some(u => u.toLowerCase() === sender.username!.toLowerCase())) return;

    if (processingUsers.has(tgUserId)) return;
    processingUsers.add(tgUserId);

    try {
      const dbDialog = await ensureDialog(db, config.id, sender);
      await syncDialogMessages(client, db, dbDialog, sender, log, {
        updateKb: true,
        userId: config.user_id,
      });

      await autoDismissStaledrafts(db, config.id, tgUserId, dbDialog.id);
      if (await hasPendingDraft(db, config.id, tgUserId)) return;

      const chatMessages = await loadChatHistory(db, dbDialog.id, config.reactive_history_limit);
      if (chatMessages.length === 0) return;

      const lastIncoming = chatMessages.filter(m => m.role === 'user').pop();
      const kbBrief = await loadCompiledBrief(db);
      const details = await fetchRelevantDetails(db, chatMessages);
      const fullPrompt = config.reactive_system_prompt + buildKbPrompt(kbBrief, details);
      const draftText = await generateDraftText(chatMessages, fullPrompt, config.llm_model);
      if (!draftText) return;

      await db.from('sales_copilot_drafts').insert({
        config_id: config.id,
        tg_user_id: tgUserId,
        tg_username: sender.username ?? null,
        tg_display_name: displayName,
        draft_text: draftText,
        draft_type: 'reactive',
        chat_history: chatMessages,
        last_incoming_text: lastIncoming?.content ?? null,
        llm_model: config.llm_model,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });

      if (config.reactive_set_tg_draft) {
        try {
          await client.invoke(new Api.messages.SaveDraft({ peer: sender, message: draftText }));
        } catch (err) {
          log('warning', `Не удалось поставить draft в TG для ${displayName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      log('info', `Reactive draft (realtime): ${displayName} (${draftText.length} симв.)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('error', `Reactive event ошибка для ${displayName}: ${errMsg}`);
    } finally {
      processingUsers.delete(tgUserId);
    }
  };

  client.addEventHandler(handler, new NewMessage({ incoming: true }));
  log('info', 'Reactive: подписка на входящие сообщения (real-time)');

  return () => {
    client.removeEventHandler(handler, new NewMessage({ incoming: true }));
  };
}

async function scanProactive(
  _client: TelegramClient,
  config: SalesCopilotConfig,
  db: SupabaseClient,
  log: LogFn,
  kbBrief: string,
) {
  if (!config.proactive_enabled) return;
  if (!config.initial_sync_completed) {
    log('info', 'Proactive: ожидание завершения первичной синхронизации');
    return;
  }

  const silenceCutoff = new Date(
    Date.now() - config.proactive_silence_days * 24 * 3600 * 1000,
  ).toISOString();

  const { data: candidates } = await db
    .from('copilot_dialogs')
    .select('*')
    .eq('config_id', config.id)
    .not('last_message_date', 'is', null)
    .lt('last_message_date', silenceCutoff)
    .order('last_message_date', { ascending: true })
    .limit(config.proactive_max_drafts_per_scan * 3);

  if (!candidates?.length) {
    log('info', 'Proactive: нет молчащих диалогов');
    return;
  }

  log('info', `Proactive: ${candidates.length} кандидатов из БД`);
  let generated = 0;

  for (const dialog of candidates) {
    if (generated >= config.proactive_max_drafts_per_scan) break;

    const tgUserId = dialog.tg_user_id;
    if (config.excluded_chat_ids?.includes(tgUserId)) continue;
    if (dialog.tg_username && config.excluded_usernames?.some(u => u.toLowerCase() === dialog.tg_username!.toLowerCase())) continue;
    if (config.ignore_bots && dialog.is_bot) continue;
    if (config.ignore_no_username && !dialog.tg_username) continue;

    const lastMsgDate = new Date(dialog.last_message_date);
    const silenceDays = Math.floor((Date.now() - lastMsgDate.getTime()) / (24 * 3600 * 1000));

    await autoDismissStaledrafts(db, config.id, tgUserId, dialog.id);
    if (await hasPendingDraft(db, config.id, tgUserId)) continue;
    if (await isDismissedRecently(db, config.id, tgUserId)) continue;

    try {
      const chatMessages = await loadChatHistory(db, dialog.id, config.reactive_history_limit);
      if (chatMessages.length === 0) continue;

      const displayName = dialog.tg_display_name;

      const classification = await classifyDialog(chatMessages, silenceDays, config.llm_model);
      if (!classification.shouldReengage) {
        log('info', `Proactive skip: ${displayName} — AI решил не писать`);
        await sleep(500);
        continue;
      }

      const basePrompt = config.proactive_system_prompt.replace(/\{silence_days\}/g, String(silenceDays));
      const details = await fetchRelevantDetails(db, chatMessages);
      const fullPrompt = basePrompt + buildKbPrompt(kbBrief, details);
      const draftText = await generateDraftText(chatMessages, fullPrompt, config.llm_model);
      if (!draftText) continue;

      await db.from('sales_copilot_drafts').insert({
        config_id: config.id,
        tg_user_id: tgUserId,
        tg_username: dialog.tg_username ?? null,
        tg_display_name: displayName,
        draft_text: draftText,
        draft_type: 'proactive',
        chat_history: chatMessages,
        silence_days: silenceDays,
        llm_model: config.llm_model,
        expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      });

      log('info', `Proactive draft: ${displayName} (${silenceDays}д молчания)`);
      generated++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('error', `Proactive ошибка для ${tgUserId}: ${errMsg}`);
    }

    await sleep(500);
  }
}

async function expireOldDrafts(db: SupabaseClient, configId: string) {
  await db
    .from('sales_copilot_drafts')
    .update({ status: 'expired' })
    .eq('config_id', configId)
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString());
}

export async function runCopilotLoop(
  configId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
) {
  const logToDb = async (level: 'info' | 'warning' | 'error', msg: string) => {
    console.log(`[sales-copilot][${configId.slice(0, 8)}][${level}] ${msg}`);
    await writeLog(db, configId, level, msg);
  };

  const log: LogFn = (level, msg) => { void logToDb(level, msg); };

  const { data: config, error: cfgErr } = await db
    .from('sales_copilot_configs')
    .select('*')
    .eq('id', configId)
    .single();

  if (cfgErr || !config) {
    log('error', 'Конфиг не найден');
    return;
  }

  if (!process.env.OPENROUTER_SALES_COPILOT_API_KEY && !process.env.OPENROUTER_TG_OUTREACH_API_KEY) {
    log('error', 'OPENROUTER_SALES_COPILOT_API_KEY не задан');
    await db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    return;
  }

  let sessionStr = '';
  let accountLabel = configId.slice(0, 8);

  const inlineSession = config.session_data as Record<string, unknown> | null;
  if (inlineSession?.session_string) {
    sessionStr = inlineSession.session_string as string;
    accountLabel = config.tg_username || config.phone || accountLabel;
  } else if (config.account_id) {
    const { data: account } = await db
      .from('tg_pool_accounts')
      .select('*')
      .eq('id', config.account_id)
      .single();

    if (!account) {
      log('error', 'Аккаунт не найден (ни inline session, ни пул)');
      return;
    }
    sessionStr = (account.session_data?.session_string as string) ?? '';
    accountLabel = account.username || account.phone || account.id.slice(0, 8);
  }

  if (!sessionStr) {
    log('error', 'Нет session_string — подключите аккаунт');
    await db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    return;
  }

  const { StringSession } = await import('telegram/sessions');
  const { TelegramClient } = await import('telegram');

  const session = new StringSession(sessionStr);

  const apiId = Number(process.env.TG_API_ID) || 0;
  const apiHash = process.env.TG_API_HASH ?? '';

  let client: InstanceType<typeof TelegramClient>;
  try {
    client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
    await client.connect();
    log('info', `Подключён к аккаунту ${accountLabel}`);
  } catch (err) {
    log('error', `Ошибка подключения: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    return;
  }

  let removeReactiveHandler: (() => void) | null = null;

  try {
    // Run initial sync if not yet completed
    if (!config.initial_sync_completed) {
      log('info', 'Первичная синхронизация не завершена — запуск...');
      await initialSync(client, config as SalesCopilotConfig, db, log, shouldStop);
      Object.assign(config, { initial_sync_completed: true });
    }

    // Real-time reactive: subscribe to incoming messages instead of polling
    removeReactiveHandler = await setupReactiveHandler(
      client, config as SalesCopilotConfig, db, log,
    );

    const HOURLY_SYNC_INTERVAL_MS = 60 * 60 * 1000;
    let lastHourlySync = config.last_full_sync_at
      ? new Date(config.last_full_sync_at).getTime()
      : 0;

    while (!shouldStop()) {
      const { data: fresh } = await db
        .from('sales_copilot_configs')
        .select('*')
        .eq('id', configId)
        .single();

      if (!fresh?.is_enabled) {
        log('info', 'Copilot выключен — выход');
        break;
      }

      Object.assign(config, fresh);

      if (isInSleepPeriod(config.sleep_periods ?? [], config.timezone_offset ?? 3)) {
        log('info', 'Спящий период — пауза 60 сек');
        await sleep(60_000);
        continue;
      }

      // Hourly sync: lightweight getDialogs to catch messages sent outside copilot
      if (Date.now() - lastHourlySync >= HOURLY_SYNC_INTERVAL_MS) {
        try {
          await hourlySync(client, config as SalesCopilotConfig, db, log);
          lastHourlySync = Date.now();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('Constructor ID')) {
            log('warning', `GramJS TL schema устарела — Telegram вернул неизвестный объект. Нужно обновить пакет 'telegram'. Синхронизация пропущена.`);
          } else {
            log('warning', `Ошибка периодической синхронизации: ${errMsg}`);
          }
          lastHourlySync = Date.now();
        }
      }

      await expireOldDrafts(db, configId);

      const kbBrief = await loadCompiledBrief(db);
      await scanProactive(client, config as SalesCopilotConfig, db, log, kbBrief);

      const interval = (config.scan_interval_seconds ?? 300) * 1000;
      log('info', `Скан завершён. Пауза ${Math.round(interval / 1000)} сек`);
      await sleep(interval);
    }
  } finally {
    if (removeReactiveHandler) removeReactiveHandler();
    try { await client.disconnect(); } catch { /* ignore */ }
    log('info', 'Copilot остановлен');
  }
}
