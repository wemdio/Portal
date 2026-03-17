import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SalesCopilotConfig, CopilotDraftMessage } from './types';
import { generateDraft } from './llm';

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

async function hasPendingDraft(
  db: SupabaseClient,
  configId: string,
  accountId: string,
  tgUserId: number,
): Promise<boolean> {
  const { count } = await db
    .from('sales_copilot_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('config_id', configId)
    .eq('account_id', accountId)
    .eq('tg_user_id', tgUserId)
    .eq('status', 'pending');
  return (count ?? 0) > 0;
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

async function scanReactive(
  client: TelegramClient,
  config: SalesCopilotConfig,
  accountId: string,
  db: SupabaseClient,
  log: LogFn,
) {
  if (!config.reactive_enabled) return;

  const dialogs = await client.getDialogs({ limit: 30 });

  for (const dialog of dialogs) {
    if (dialog.unreadCount === 0) continue;
    if (!dialog.entity || !(dialog.entity instanceof Api.User)) continue;

    const user = dialog.entity;
    if (config.ignore_bots && user.bot) continue;
    if (config.ignore_no_username && !user.username) continue;

    const tgUserId = Number(user.id);
    if (config.excluded_chat_ids?.includes(tgUserId)) continue;

    if (await hasPendingDraft(db, config.id, accountId, tgUserId)) continue;

    try {
      const history = await client.getMessages(user, { limit: config.reactive_history_limit });

      const chatMessages: CopilotDraftMessage[] = [];
      for (const msg of history.reverse()) {
        if (!msg.message) continue;
        chatMessages.push({
          role: msg.out ? 'assistant' : 'user',
          content: msg.message,
          timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : undefined,
        });
      }

      if (chatMessages.length === 0) continue;

      const lastIncoming = chatMessages.filter(m => m.role === 'user').pop();
      const draftText = await generateDraftText(chatMessages, config.reactive_system_prompt, config.llm_model);
      if (!draftText) continue;

      const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || `ID:${tgUserId}`;

      await db.from('sales_copilot_drafts').insert({
        config_id: config.id,
        account_id: accountId,
        tg_user_id: tgUserId,
        tg_username: user.username ?? null,
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
          await client.invoke(new Api.messages.SaveDraft({ peer: user, message: draftText }));
        } catch (err) {
          log('warning', `Не удалось поставить draft в TG для ${displayName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      log('info', `Reactive draft: ${displayName} (${draftText.length} симв.)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('FloodWaitError') || errMsg.includes('PeerFloodError')) {
        log('warning', `FloodWait — пропуск реактивного скана`);
        break;
      }
      log('error', `Reactive ошибка для ${tgUserId}: ${errMsg}`);
    }

    await sleep(2000);
  }
}

async function scanProactive(
  client: TelegramClient,
  config: SalesCopilotConfig,
  accountId: string,
  db: SupabaseClient,
  log: LogFn,
) {
  if (!config.proactive_enabled) return;

  const dialogs = await client.getDialogs({ limit: 100 });
  let generated = 0;

  for (const dialog of dialogs) {
    if (generated >= config.proactive_max_drafts_per_scan) break;
    if (!dialog.entity || !(dialog.entity instanceof Api.User)) continue;

    const user = dialog.entity;
    if (config.ignore_bots && user.bot) continue;
    if (config.ignore_no_username && !user.username) continue;

    const tgUserId = Number(user.id);
    if (config.excluded_chat_ids?.includes(tgUserId)) continue;

    const lastMsgDate = dialog.date ? new Date(dialog.date * 1000) : null;
    if (!lastMsgDate) continue;

    const silenceDays = Math.floor((Date.now() - lastMsgDate.getTime()) / (24 * 3600 * 1000));
    if (silenceDays < config.proactive_silence_days) continue;

    if (await hasPendingDraft(db, config.id, accountId, tgUserId)) continue;

    try {
      const history = await client.getMessages(user, { limit: config.reactive_history_limit });

      const chatMessages: CopilotDraftMessage[] = [];
      for (const msg of history.reverse()) {
        if (!msg.message) continue;
        chatMessages.push({
          role: msg.out ? 'assistant' : 'user',
          content: msg.message,
          timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : undefined,
        });
      }

      if (chatMessages.length === 0) continue;

      const prompt = config.proactive_system_prompt.replace(/\{silence_days\}/g, String(silenceDays));
      const draftText = await generateDraftText(chatMessages, prompt, config.llm_model);
      if (!draftText) continue;

      const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || `ID:${tgUserId}`;

      await db.from('sales_copilot_drafts').insert({
        config_id: config.id,
        account_id: accountId,
        tg_user_id: tgUserId,
        tg_username: user.username ?? null,
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
      if (errMsg.includes('FloodWaitError') || errMsg.includes('PeerFloodError')) {
        log('warning', `FloodWait — пропуск проактивного скана`);
        break;
      }
      log('error', `Proactive ошибка для ${tgUserId}: ${errMsg}`);
    }

    await sleep(2000);
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

  const { data: account } = await db
    .from('tg_pool_accounts')
    .select('*')
    .eq('id', config.account_id)
    .single();

  if (!account) {
    log('error', 'Аккаунт не найден в пуле');
    return;
  }

  if (!process.env.OPENROUTER_TG_OUTREACH_API_KEY) {
    log('error', 'OPENROUTER_TG_OUTREACH_API_KEY не задан');
    await db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    return;
  }

  const { StringSession } = await import('telegram/sessions');
  const { TelegramClient } = await import('telegram');

  const sessionStr = (account.session_data?.session_string as string) ?? '';
  if (!sessionStr) {
    log('error', 'Аккаунт не имеет session_string');
    await db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    return;
  }
  const session = new StringSession(sessionStr);

  const apiId = Number(process.env.TG_API_ID) || 0;
  const apiHash = process.env.TG_API_HASH ?? '';

  let client: InstanceType<typeof TelegramClient>;
  try {
    client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
    await client.connect();
    log('info', `Подключён к аккаунту ${account.username || account.phone || account.id.slice(0, 8)}`);
  } catch (err) {
    log('error', `Ошибка подключения: ${err instanceof Error ? err.message : String(err)}`);
    await db.from('sales_copilot_configs').update({ is_enabled: false }).eq('id', configId);
    return;
  }

  try {
    while (!shouldStop()) {
      if (isInSleepPeriod(config.sleep_periods ?? [], config.timezone_offset ?? 3)) {
        log('info', 'Спящий период — пауза 60 сек');
        await sleep(60_000);
        continue;
      }

      const { data: fresh } = await db
        .from('sales_copilot_configs')
        .select('is_enabled')
        .eq('id', configId)
        .single();

      if (!fresh?.is_enabled) {
        log('info', 'Copilot выключен — выход');
        break;
      }

      await expireOldDrafts(db, configId);
      await scanReactive(client, config as SalesCopilotConfig, account.id, db, log);
      await scanProactive(client, config as SalesCopilotConfig, account.id, db, log);

      const interval = (config.scan_interval_seconds ?? 300) * 1000;
      log('info', `Скан завершён. Пауза ${Math.round(interval / 1000)} сек`);
      await sleep(interval);
    }
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
    log('info', 'Copilot остановлен');
  }
}
