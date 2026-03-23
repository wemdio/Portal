import fs from 'fs';
import path from 'path';
import os from 'os';
import { Api } from 'telegram';
import type { Dialog } from 'telegram/tl/custom/dialog';
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OutreachCampaign,
  OutreachAccount,
  TelegramSettings,
  OpenAISettings,
  DialogMessage,
} from './types';
import { DEFAULT_FOLLOW_UP } from './types';
import { buildClients, disconnectAll, getUpdatedSessionString } from './gramClient';
import { openaiGenerate, detectTrigger } from './openaiChat';
import { truncateMessage } from '@/lib/logger';

const BUCKET_SESSIONS = 'tg-outreach-sessions';
const sessionPathCache = new Map<string, string>();

async function downloadSessionToTemp(db: SupabaseClient, storagePath: string): Promise<string> {
  const cached = sessionPathCache.get(storagePath);
  if (cached && fs.existsSync(cached)) return cached;
  const { data, error } = await db.storage.from(BUCKET_SESSIONS).download(storagePath);
  if (error || !data) throw new Error(error?.message ?? 'Не удалось скачать .session');
  const localPath = path.join(os.tmpdir(), `tg-session-${storagePath.replace(/\//g, '-')}`);
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  sessionPathCache.set(storagePath, localPath);
  return localPath;
}

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function randomRange([min, max]: [number, number]): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

async function isProcessed(db: SupabaseClient, campaignId: string, tgUserId: number): Promise<boolean> {
  const { count } = await db
    .from('tg_outreach_processed')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('tg_user_id', tgUserId);
  return (count ?? 0) > 0;
}

async function markProcessed(db: SupabaseClient, campaignId: string, tgUserId: number, tgUsername: string | null) {
  await db.from('tg_outreach_processed').upsert(
    { campaign_id: campaignId, tg_user_id: tgUserId, tg_username: tgUsername },
    { onConflict: 'campaign_id,tg_user_id' },
  );
}

async function upsertDialog(
  db: SupabaseClient,
  campaignId: string,
  accountId: string,
  tgUserId: number,
  tgUsername: string | null,
  messages: DialogMessage[],
  status?: string,
) {
  const { data: existing } = await db
    .from('tg_outreach_dialogs')
    .select('id, messages, status')
    .eq('campaign_id', campaignId)
    .eq('account_id', accountId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing) {
    await db.from('tg_outreach_dialogs').update({
      messages,
      tg_username: tgUsername,
      last_message_at: now,
      ...(status ? { status } : {}),
    }).eq('id', existing.id);
  } else {
    await db.from('tg_outreach_dialogs').insert({
      campaign_id: campaignId,
      account_id: accountId,
      tg_user_id: tgUserId,
      tg_username: tgUsername,
      messages,
      status: status ?? 'none',
      last_message_at: now,
    });
  }
}

async function writeLog(
  db: SupabaseClient,
  campaignId: string,
  level: string,
  message: string,
  traceContext?: { requestId: string },
) {
  await db.from('tg_outreach_logs').insert({ campaign_id: campaignId, level, message }).then(() => {});

  if (traceContext) {
    const appLevel = level === 'warning' ? 'warn' : level;
    await db
      .from('application_logs')
      .insert({
        level: appLevel,
        source: 'server',
        event: 'tg-outreach.campaign.log',
        message: truncateMessage(message),
        context: { campaign_id: campaignId },
        request_id: traceContext.requestId,
        route: 'tg_outreach_worker',
      })
      .then(() => {});
  }
}

async function forwardToTargetChat(
  client: TelegramClient,
  fromPeer: Api.TypeEntityLike,
  messageIds: number[],
  targetUsername: string,
  log: LogFn,
) {
  if (!targetUsername) return;
  const target = targetUsername.startsWith('@') ? targetUsername.slice(1) : targetUsername;
  try {
    await client.forwardMessages(target, { fromPeer, messages: messageIds });
    log('info', `Переслано в ${targetUsername}`);
  } catch (err) {
    log('error', `Ошибка пересылки в ${targetUsername}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface HandleChatResult {
  replied: boolean;
  triggerType: 'positive' | 'negative' | null;
}

async function handleChat(
  client: TelegramClient,
  account: OutreachAccount,
  dialog: Dialog,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
): Promise<HandleChatResult> {
  const oai = campaign.openai_settings as OpenAISettings;
  const tg = campaign.telegram_settings as TelegramSettings;
  const entity = dialog.entity;

  if (!entity || !(entity instanceof Api.User)) {
    return { replied: false, triggerType: null };
  }

  const tgUserId = Number(entity.id);
  const tgUsername = entity.username ?? null;
  const displayName = tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`;

  if (tg.ignore_bot_usernames && entity.bot) {
    return { replied: false, triggerType: null };
  }
  if (tg.ignore_no_username && !tgUsername) {
    return { replied: false, triggerType: null };
  }

  if (await isProcessed(db, campaign.id, tgUserId)) {
    return { replied: false, triggerType: null };
  }

  const preReadDelay = randomRange(tg.pre_read_delay_range) * 1000;
  await sleep(preReadDelay);

  await client.invoke(new Api.messages.ReadHistory({ peer: entity, maxId: 0 }));

  const history = await client.getMessages(entity, { limit: tg.history_limit });
  const chatMessages: DialogMessage[] = [];

  for (const msg of history.reverse()) {
    if (!msg.message) continue;
    const isOut = msg.out ?? false;
    chatMessages.push({
      role: isOut ? 'assistant' : 'user',
      content: msg.message,
      timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : undefined,
    });
  }

  if (chatMessages.length === 0) {
    return { replied: false, triggerType: null };
  }

  if (tg.reply_only_if_previously_wrote) {
    const hasOurMessage = chatMessages.some(m => m.role === 'assistant');
    if (!hasOurMessage) {
      return { replied: false, triggerType: null };
    }
  }

  let replyText: string | null = null;
  try {
    replyText = await openaiGenerate(oai, chatMessages);
  } catch (err) {
    log('error', `${displayName}: OpenAI ошибка — ${err instanceof Error ? err.message : String(err)}`);
    if (oai.use_fallback_on_fail && oai.fallback_text) {
      replyText = oai.fallback_text;
    }
  }

  if (!replyText) {
    return { replied: false, triggerType: null };
  }

  const readReplyDelay = randomRange(tg.read_reply_delay_range) * 1000;
  await sleep(readReplyDelay);

  const sent = await client.sendMessage(entity, { message: replyText });
  log('info', `${displayName}: отправлен ответ (${replyText.length} симв.)`);

  chatMessages.push({
    role: 'assistant',
    content: replyText,
    timestamp: new Date().toISOString(),
  });

  const triggerType = detectTrigger(replyText, oai);

  if (triggerType) {
    log('info', `${displayName}: триггер "${triggerType}"`);

    const targetChat = triggerType === 'positive'
      ? oai.target_chats_positive
      : oai.target_chats_negative;

    if (targetChat) {
      const messageIdsToForward = history
        .slice(-tg.forward_limit)
        .map(m => m.id)
        .concat(sent.id);
      await forwardToTargetChat(client, entity, messageIdsToForward, targetChat, log);
    }

    await markProcessed(db, campaign.id, tgUserId, tgUsername);
    await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, triggerType === 'positive' ? 'lead' : 'not_lead');
  } else {
    await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages);
  }

  return { replied: true, triggerType };
}

async function handleFollowUp(
  client: TelegramClient,
  account: OutreachAccount,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
) {
  const tg = campaign.telegram_settings as TelegramSettings;
  const oai = campaign.openai_settings as OpenAISettings;

  const followUpPrompt = tg.follow_up?.prompt || DEFAULT_FOLLOW_UP.prompt;
  const delayHours = tg.follow_up?.delay_hours ?? 0;
  const delayMinutes = tg.follow_up?.delay_minutes ?? 0;
  const totalDelayMs = (delayHours * 3600 + delayMinutes * 60) * 1000;
  if (!tg.follow_up?.enabled || totalDelayMs <= 0 || !followUpPrompt) return;

  const cutoff = new Date(Date.now() - totalDelayMs).toISOString();

  const { data: dialogs } = await db
    .from('tg_outreach_dialogs')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .eq('status', 'none')
    .lt('last_message_at', cutoff)
    .limit(10);

  if (!dialogs?.length) return;

  for (const dialog of dialogs) {
    const tgUserId = dialog.tg_user_id as number;
    if (await isProcessed(db, campaign.id, tgUserId)) continue;

    const messages = dialog.messages as DialogMessage[];
    if (messages.length === 0) continue;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'assistant') continue;

    const alreadySentFollowUp = messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Система: пользователь не ответил'));
    if (alreadySentFollowUp) continue;

    try {
      const followUpMessages: DialogMessage[] = [
        ...messages,
        { role: 'user', content: `[Система: пользователь не ответил ${delayHours}ч ${delayMinutes}мин. ${followUpPrompt}]` },
      ];

      const reply = await openaiGenerate(oai, followUpMessages);
      if (!reply) continue;

      await sleep(randomRange(tg.read_reply_delay_range) * 1000);
      const entity = await client.getEntity(tgUserId);
      await client.sendMessage(entity, { message: reply });

      messages.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      await upsertDialog(db, campaign.id, account.id, tgUserId, dialog.tg_username as string | null, messages);
      log('info', `Follow-up: ${dialog.tg_username ? `@${dialog.tg_username}` : `ID:${tgUserId}`}`);
    } catch (err) {
      log('warning', `Follow-up ошибка ${tgUserId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type TraceContext = { requestId: string };

export async function runCampaignLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  traceContext?: TraceContext,
) {
  const logToDb = async (level: 'info' | 'warning' | 'error', msg: string) => {
    console.log(`[tg-outreach][${campaignId.slice(0, 8)}][${level}] ${msg}`);
    await writeLog(db, campaignId, level, msg, traceContext);
  };

  const log: LogFn = (level, msg) => { void logToDb(level, msg); };

  const { data: campaign, error: cErr } = await db
    .from('tg_outreach_campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (cErr || !campaign) {
    log('error', 'Кампания не найдена');
    return;
  }

  const tg = campaign.telegram_settings as TelegramSettings;
  const _oai = campaign.openai_settings as OpenAISettings;

  if (!process.env.OPENROUTER_TG_OUTREACH_API_KEY) {
    log('error', 'OPENROUTER_TG_OUTREACH_API_KEY не задан в .env');
    await db.from('tg_outreach_campaigns').update({ status: 'error' }).eq('id', campaignId);
    return;
  }

  const { data: accounts } = await db
    .from('tg_outreach_accounts')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  if (!accounts?.length) {
    log('error', 'Нет активных аккаунтов');
    await db.from('tg_outreach_campaigns').update({ status: 'error' }).eq('id', campaignId);
    return;
  }

  const { data: proxies } = await db
    .from('tg_outreach_proxies')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  log('info', `Запуск кампании "${campaign.name}": ${accounts.length} аккаунтов, ${proxies?.length ?? 0} прокси`);

  const downloadSessionFile = (storagePath: string) => downloadSessionToTemp(db, storagePath);
  const clients = await buildClients(accounts, proxies ?? [], log, downloadSessionFile);

  if (clients.length === 0) {
    log('error', 'Ни один аккаунт не подключился');
    await db.from('tg_outreach_campaigns').update({ status: 'error' }).eq('id', campaignId);
    return;
  }

  await db.from('tg_outreach_campaigns').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', campaignId);

  try {
    while (!shouldStop()) {
      if (isInSleepPeriod(tg.sleep_periods, tg.timezone_offset)) {
        log('info', 'Спящий период — пауза 60 сек');
        await sleep(60_000);
        continue;
      }

      let tlSchemaErrorCount = 0;

      for (const { client, account } of clients) {
        if (shouldStop()) break;

        const now = new Date();
        if (account.cooldown_until && new Date(account.cooldown_until) > now) {
          log('info', `${account.session_name}: cooldown до ${account.cooldown_until}`);
          continue;
        }

        try {
          const dialogs = await client.getDialogs({ limit: 20 });

          for (const dialog of dialogs) {
            if (shouldStop()) break;
            if (dialog.unreadCount === 0) continue;
            if (!dialog.entity || !(dialog.entity instanceof Api.User)) continue;

            try {
              await handleChat(client, account, dialog, campaign as OutreachCampaign, db, log);
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);

              if (errMsg.includes('PeerFloodError') || errMsg.includes('FloodWaitError') || errMsg.includes('FrozenMethodInvalidError')) {
                const cooldownUntil = new Date(Date.now() + tg.account_cooldown_hours * 3600 * 1000).toISOString();
                await db.from('tg_outreach_accounts').update({ cooldown_until: cooldownUntil }).eq('id', account.id);
                (account as OutreachAccount).cooldown_until = cooldownUntil;
                log('warning', `${account.session_name}: FloodError → cooldown ${tg.account_cooldown_hours}ч`);
                break;
              }

              log('error', `Ошибка обработки диалога: ${errMsg}`);
            }
          }

          await handleFollowUp(client, account, campaign as unknown as OutreachCampaign, db, log);

          const updatedSession = await getUpdatedSessionString(client);
          if (updatedSession && updatedSession !== account.session_data) {
            await db.from('tg_outreach_accounts').update({ session_data: updatedSession }).eq('id', account.id);
          }

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('Constructor ID')) {
            tlSchemaErrorCount++;
            if (tlSchemaErrorCount === 1) {
              log('warning', `GramJS TL schema устарела — Telegram вернул неизвестный объект. Нужно обновить пакет 'telegram'. Ошибка: ${errMsg.slice(0, 150)}`);
            }
          } else {
            log('error', `${account.session_name}: ${errMsg}`);
          }
        }

        const accountDelay = randomRange(tg.account_loop_delay_range) * 1000;
        log('info', `Пауза ${Math.round(accountDelay / 1000)} сек перед следующим аккаунтом`);
        await sleep(accountDelay);
      }

      if (tlSchemaErrorCount > 0 && tlSchemaErrorCount >= clients.length) {
        const tlBackoff = 300_000;
        log('warning', `Все ${tlSchemaErrorCount} аккаунтов получили TL schema ошибку — пауза ${tlBackoff / 1000} сек. Обновите пакет 'telegram' (npm update telegram)`);
        await sleep(tlBackoff);
      }

      const cycleDelay = 30_000;
      log('info', `Цикл завершён. Пауза ${cycleDelay / 1000} сек`);
      await sleep(cycleDelay);

      const { data: fresh } = await db
        .from('tg_outreach_campaigns')
        .select('status')
        .eq('id', campaignId)
        .single();
      if (fresh?.status === 'stopped' || fresh?.status === 'paused') {
        log('info', `Кампания ${fresh.status} — выход`);
        break;
      }
    }
  } finally {
    await disconnectAll(clients);
    await db.from('tg_outreach_campaigns').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', campaignId);
    log('info', 'Кампания остановлена');
  }
}
