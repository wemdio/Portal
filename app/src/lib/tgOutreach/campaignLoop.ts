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
import { loadBlockedUserIds } from './blockedUsers';
import { truncateMessage } from '@/lib/logger';
import { extractOrConvertToMp3, transcribeAudio } from '@/lib/transcription';

const BUCKET_SESSIONS = 'tg-outreach-sessions';
const SESSION_CACHE_MAX = 100;
const sessionPathCache = new Map<string, string>();

function sessionCacheEvict(): void {
  if (sessionPathCache.size <= SESSION_CACHE_MAX) return;
  const oldest = sessionPathCache.keys().next().value;
  if (oldest != null) sessionPathCache.delete(oldest);
}

async function downloadSessionToTemp(db: SupabaseClient, storagePath: string): Promise<string> {
  const cached = sessionPathCache.get(storagePath);
  if (cached && fs.existsSync(cached)) return cached;
  const { data, error } = await db.storage.from(BUCKET_SESSIONS).download(storagePath);
  if (error || !data) throw new Error(error?.message ?? 'Не удалось скачать .session');
  const localPath = path.join(os.tmpdir(), `tg-session-${storagePath.replace(/\//g, '-')}`);
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  sessionPathCache.set(storagePath, localPath);
  sessionCacheEvict();
  return localPath;
}

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function interruptibleSleep(ms: number, shouldStop: () => boolean, chunkMs = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) {
    await sleep(Math.min(chunkMs, end - Date.now()));
  }
}

function randomRange([min, max]: [number, number]): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Сколько диалогов аккаунта забирать из getDialogs за итерацию.
 * Было 20 — если аккаунт состоит в активных группах, болтовня в них
 * выталкивает группы в топ списка, и личка от новых лидов проваливается
 * ниже 20-й позиции → handleChat её не видит. 100 даёт большой запас
 * (фактически обрабатываются только непрочитанные User-диалоги, так что
 * лишние метаданные почти бесплатны — один MTProto-запрос).
 */
const DIALOGS_FETCH_LIMIT = Number(process.env.TG_OUTREACH_DIALOGS_LIMIT ?? '100');

/**
 * Таймстамп последнего сообщения, у которого есть дата. null — если ни у
 * одного нет. Нужен чтобы last_message_at отражал РЕАЛЬНУЮ активность
 * диалога, а не момент последнего upsert'а.
 */
function lastMessageTimestamp(messages: DialogMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const ts = messages[i]?.timestamp;
    if (ts) return ts;
  }
  return null;
}

function isLowValueReply(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return true;

  const blockedExact = new Set([
    'ничего',
    'nothing',
    'none',
    'n/a',
    '-',
    '—',
    '.',
    '..',
    '...',
    '?',
    '??',
    '???',
  ]);

  return blockedExact.has(normalized);
}

const VOICE_MAX_DURATION_SEC = 300;
const VOICE_DOWNLOAD_TIMEOUT_MS = 30_000;

function isVoiceOrAudioMessage(msg: Api.Message): boolean {
  const media = msg.media;
  if (!(media instanceof Api.MessageMediaDocument)) return false;
  if (media.voice) return true;
  const doc = media.document;
  if (!(doc instanceof Api.Document)) return false;
  return doc.attributes.some(
    (a) => a instanceof Api.DocumentAttributeAudio && a.voice,
  );
}

function getAudioDuration(msg: Api.Message): number {
  const media = msg.media;
  if (!(media instanceof Api.MessageMediaDocument)) return 0;
  const doc = media.document;
  if (!(doc instanceof Api.Document)) return 0;
  for (const a of doc.attributes) {
    if (a instanceof Api.DocumentAttributeAudio) return a.duration;
  }
  return 0;
}

async function transcribeVoice(
  client: TelegramClient,
  msg: Api.Message,
  log: LogFn,
  label: string,
): Promise<string | null> {
  const duration = getAudioDuration(msg);
  if (duration > VOICE_MAX_DURATION_SEC) {
    log('info', `${label}: голосовое слишком длинное (${duration}с > ${VOICE_MAX_DURATION_SEC}с) — пропуск`);
    return null;
  }

  try {
    const buf = await Promise.race([
      client.downloadMedia(msg, {}) as Promise<Buffer | string | undefined>,
      new Promise<undefined>((_, reject) =>
        setTimeout(() => reject(new Error('voice download timeout')), VOICE_DOWNLOAD_TIMEOUT_MS),
      ),
    ]);

    if (!buf || typeof buf === 'string') return null;
    const oggBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (oggBuf.length === 0) return null;

    const mp3 = await extractOrConvertToMp3({ bytes: oggBuf, inputExt: '.ogg' });
    const text = await transcribeAudio({ audioMp3: mp3 });
    if (text) {
      log('info', `${label}: расшифровано голосовое (${duration}с → ${text.length} симв.)`);
    }
    return text || null;
  } catch (err) {
    log('warning', `${label}: ошибка расшифровки голосового — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function describeMediaType(msg: Api.Message): string | null {
  const media = msg.media;
  if (!media || media instanceof Api.MessageMediaEmpty) return null;

  if (media instanceof Api.MessageMediaPhoto) return 'Фото';
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) return 'Геолокация';
  if (media instanceof Api.MessageMediaContact) return 'Контакт';
  if (media instanceof Api.MessageMediaPoll) return 'Опрос';
  if (media instanceof Api.MessageMediaDice) return 'Кубик/эмодзи';
  if (media instanceof Api.MessageMediaStory) return 'История';

  if (media instanceof Api.MessageMediaDocument) {
    if (media.voice) return 'Голосовое сообщение';
    if (media.round) return 'Видеосообщение (кружок)';
    if (media.video) return 'Видео';

    const doc = media.document;
    if (doc instanceof Api.Document) {
      for (const a of doc.attributes) {
        if (a instanceof Api.DocumentAttributeSticker) return 'Стикер';
        if (a instanceof Api.DocumentAttributeAudio) {
          return a.voice ? 'Голосовое сообщение' : 'Аудиофайл';
        }
        if (a instanceof Api.DocumentAttributeVideo) {
          return a.roundMessage ? 'Видеосообщение (кружок)' : 'Видео';
        }
      }
      const mime = doc.mimeType ?? '';
      if (mime.startsWith('image/')) return 'GIF/изображение';
    }
    return 'Файл';
  }

  return null;
}

async function extractMessagesFromHistory(
  client: TelegramClient,
  history: Api.Message[],
  log: LogFn,
  label: string,
): Promise<DialogMessage[]> {
  const chatMessages: DialogMessage[] = [];
  for (const msg of history) {
    const isOut = msg.out ?? false;
    const role = isOut ? 'assistant' : 'user';
    const timestamp = msg.date ? new Date(msg.date * 1000).toISOString() : undefined;
    const mediaTag = describeMediaType(msg);

    if (msg.message) {
      const content = mediaTag ? `[${mediaTag}] ${msg.message}` : msg.message;
      chatMessages.push({ role, content, timestamp });
      continue;
    }

    if (!isOut && isVoiceOrAudioMessage(msg)) {
      const text = await transcribeVoice(client, msg, log, label);
      if (text) {
        chatMessages.push({ role: 'user', content: `[Голосовое сообщение]: ${text}`, timestamp });
        continue;
      }
    }

    if (mediaTag) {
      chatMessages.push({ role, content: `[${mediaTag}]`, timestamp });
    }
  }
  return chatMessages;
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
  opts?: { canSend?: boolean; tgIsBot?: boolean },
) {
  const { data: existing } = await db
    .from('tg_outreach_dialogs')
    .select('id, messages, status, can_send, tg_is_bot')
    .eq('campaign_id', campaignId)
    .eq('account_id', accountId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();

  const now = new Date().toISOString();
  // last_message_at — таймстамп РЕАЛЬНОГО последнего сообщения, а не wall-clock
  // now(). Иначе любой повторный upsert старого диалога (handleChat трогает
  // его ещё до проверки can_send, backfill, refetch) поднимал дату на «сейчас»
  // — старые лиды всплывали в списке как сегодняшние. fallback на now() только
  // если у сообщений нет таймстампов (пустой диалог / старые данные).
  const lastMessageAt = lastMessageTimestamp(messages) ?? now;

  if (existing) {
    const updatePayload: Record<string, unknown> = {
      messages,
      tg_username: tgUsername,
      last_message_at: lastMessageAt,
      tg_is_bot: opts?.tgIsBot ?? existing.tg_is_bot ?? false,
      ...(status ? { status } : {}),
    };
    if (typeof opts?.canSend === 'boolean') {
      updatePayload.can_send = opts.canSend;
    }
    await db.from('tg_outreach_dialogs').update({
      ...updatePayload,
    }).eq('id', existing.id);
  } else {
    await db.from('tg_outreach_dialogs').insert({
      campaign_id: campaignId,
      account_id: accountId,
      tg_user_id: tgUserId,
      tg_username: tgUsername,
      messages,
      status: status ?? 'none',
      tg_is_bot: opts?.tgIsBot ?? false,
      can_send: opts?.canSend ?? !(opts?.tgIsBot ?? false),
      last_message_at: lastMessageAt,
    });
  }
}

async function canSendToDialog(
  db: SupabaseClient,
  campaignId: string,
  accountId: string,
  tgUserId: number,
): Promise<boolean> {
  const { data } = await db
    .from('tg_outreach_dialogs')
    .select('can_send')
    .eq('campaign_id', campaignId)
    .eq('account_id', accountId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();
  return data?.can_send !== false;
}

async function ensureDialogMeta(
  db: SupabaseClient,
  campaignId: string,
  accountId: string,
  tgUserId: number,
  tgUsername: string | null,
  tgIsBot: boolean,
  autoAllowNewDialogs: boolean,
) {
  const { data: existing } = await db
    .from('tg_outreach_dialogs')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('account_id', accountId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();

  if (existing?.id) {
    await db.from('tg_outreach_dialogs').update({
      tg_username: tgUsername,
      tg_is_bot: tgIsBot,
    }).eq('id', existing.id);
    return;
  }

  await db.from('tg_outreach_dialogs').insert({
    campaign_id: campaignId,
    account_id: accountId,
    tg_user_id: tgUserId,
    tg_username: tgUsername,
    tg_is_bot: tgIsBot,
    can_send: autoAllowNewDialogs && !tgIsBot,
    messages: [],
    status: 'none',
    last_message_at: new Date().toISOString(),
  });
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

export interface HandleChatOptions {
  /**
   * Set of `tg_user_id`s globally blocked by the campaign owner. When the chat's user is
   * in this set, we early-return without creating a dialog row and without touching OpenAI,
   * so spammers (especially ones without a username) can't keep poking through.
   */
  blockedUserIds?: Set<number>;
}

export async function handleChat(
  client: TelegramClient,
  account: OutreachAccount,
  dialog: Dialog,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
  shouldStop?: () => boolean,
  options?: HandleChatOptions,
): Promise<HandleChatResult> {
  const oai = campaign.openai_settings as OpenAISettings;
  const tg = campaign.telegram_settings as TelegramSettings;
  const entity = dialog.entity;

  if (!entity || !(entity instanceof Api.User)) {
    return { replied: false, triggerType: null };
  }

  const tgUserId = Number(entity.id);
  const tgUsername = entity.username ?? null;
  const tgIsBot = Boolean(entity.bot);
  const displayName = tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`;

  if (options?.blockedUserIds?.has(tgUserId)) {
    log('info', `${displayName}: в глобальном чёрном списке (ID)`);
    return { replied: false, triggerType: null };
  }

  const blocked = new Set((tg.blocked_usernames ?? []).map((u) => u.trim().toLowerCase().replace(/^@/, '')));
  if (tgUsername && blocked.has(tgUsername.toLowerCase().replace(/^@/, ''))) {
    log('info', `${displayName}: в чёрном списке username`);
    return { replied: false, triggerType: null };
  }

  if (tg.ignore_bot_usernames && tgIsBot) {
    return { replied: false, triggerType: null };
  }
  if (tg.ignore_no_username && !tgUsername) {
    return { replied: false, triggerType: null };
  }

  await ensureDialogMeta(
    db,
    campaign.id,
    account.id,
    tgUserId,
    tgUsername,
    tgIsBot,
    Boolean(tg.auto_allow_new_dialogs),
  );

  const preReadDelay = randomRange(tg.pre_read_delay_range) * 1000;
  if (shouldStop) await interruptibleSleep(preReadDelay, shouldStop); else await sleep(preReadDelay);

  try {
    await client.invoke(new Api.messages.ReadHistory({ peer: entity, maxId: 0 }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Some accounts get rate-limited / partially frozen for read operations (MTProto error 420).
    // We still want to reply; just skip marking as read.
    if (errMsg.includes('FROZEN_METHOD_INVALID') || errMsg.includes('FrozenMethodInvalid')) {
      log('warning', `${displayName}: не удалось отметить прочитанным (TG freeze) — продолжаю без ReadHistory`);
    } else {
      throw err;
    }
  }

  let history;
  try {
    history = await client.getMessages(entity, { limit: tg.history_limit });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // GramJS sometimes reports offset out-of-range for history pagination; a smaller retry is usually enough.
    if (errMsg.includes("offset") && errMsg.includes('out of range')) {
      history = await client.getMessages(entity, { limit: Math.min(20, Math.max(5, tg.history_limit)) });
    } else {
      throw err;
    }
  }
  const chatMessages = await extractMessagesFromHistory(client, [...history].reverse(), log, displayName);

  if (chatMessages.length === 0) {
    return { replied: false, triggerType: null };
  }

  await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, undefined, { tgIsBot });

  if (!(await canSendToDialog(db, campaign.id, account.id, tgUserId))) {
    log('info', `${displayName}: отправка отключена вручную`);
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
  if (isLowValueReply(replyText)) {
    log('warning', `${displayName}: сгенерирован пустой/бессмысленный ответ "${replyText}" — пропускаю отправку`);
    return { replied: false, triggerType: null };
  }

  const readReplyDelay = randomRange(tg.read_reply_delay_range) * 1000;
  if (shouldStop) await interruptibleSleep(readReplyDelay, shouldStop); else await sleep(readReplyDelay);

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
    await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, triggerType === 'positive' ? 'lead' : 'not_lead', { tgIsBot, canSend: false });
  } else {
    await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, undefined, { tgIsBot });
  }

  return { replied: true, triggerType };
}

async function handleFollowUp(
  client: TelegramClient,
  account: OutreachAccount,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
  shouldStop?: () => boolean,
) {
  const tg = campaign.telegram_settings as TelegramSettings;
  const oai = campaign.openai_settings as OpenAISettings;

  const followUpPrompt = tg.follow_up?.prompt || DEFAULT_FOLLOW_UP.prompt;
  const delayHours = tg.follow_up?.delay_hours ?? 0;
  const delayMinutes = tg.follow_up?.delay_minutes ?? 0;
  const blocked = new Set((tg.blocked_usernames ?? []).map((u) => u.trim().toLowerCase().replace(/^@/, '')));
  const totalDelayMs = (delayHours * 3600 + delayMinutes * 60) * 1000;
  if (!tg.follow_up?.enabled || totalDelayMs <= 0 || !followUpPrompt) return;

  const cutoff = new Date(Date.now() - totalDelayMs).toISOString();

  const { data: dialogs } = await db
    .from('tg_outreach_dialogs')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .eq('status', 'none')
    .eq('can_send', true)
    .lt('last_message_at', cutoff)
    .limit(10);

  if (!dialogs?.length) return;

  for (const dialog of dialogs) {
    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;
    const isBot = Boolean(dialog.tg_is_bot);
    if (isBot && tg.ignore_bot_usernames) continue;
    if (tgUsername && blocked.has(tgUsername.toLowerCase().replace(/^@/, ''))) continue;

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
      if (isLowValueReply(reply)) {
        log('warning', `Follow-up пропущен для ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`}: бессмысленный ответ "${reply}"`);
        continue;
      }

      const followUpDelay = randomRange(tg.read_reply_delay_range) * 1000;
      if (shouldStop) await interruptibleSleep(followUpDelay, shouldStop); else await sleep(followUpDelay);
      const entity = await client.getEntity(tgUserId);
      await client.sendMessage(entity, { message: reply });

      messages.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, messages, undefined, { tgIsBot: isBot });
      log('info', `Follow-up: ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`}`);
    } catch (err) {
      log('warning', `Follow-up ошибка ${tgUserId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function handleMissedRepliesLastDays(
  client: TelegramClient,
  account: OutreachAccount,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
  shouldStop?: () => boolean,
) {
  const tg = campaign.telegram_settings as TelegramSettings;
  const oai = campaign.openai_settings as OpenAISettings;
  const blocked = new Set((tg.blocked_usernames ?? []).map((u) => u.trim().toLowerCase().replace(/^@/, '')));
  const lookbackMs = 3 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();

  const { data: dialogs } = await db
    .from('tg_outreach_dialogs')
    .select('id, tg_user_id, tg_username, tg_is_bot, status, can_send, messages, last_message_at')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .eq('status', 'none')
    .eq('can_send', true)
    .gte('last_message_at', cutoffIso)
    .order('last_message_at', { ascending: true })
    .limit(200);

  if (!dialogs?.length) return;

  let processed = 0;
  let replied = 0;
  for (const dialog of dialogs) {
    if (shouldStop?.()) break;
    processed++;

    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;
    const isBot = Boolean(dialog.tg_is_bot);
    if (isBot && tg.ignore_bot_usernames) continue;
    if (tgUsername && blocked.has(tgUsername.toLowerCase().replace(/^@/, ''))) continue;

    const messages = Array.isArray(dialog.messages) ? (dialog.messages as DialogMessage[]) : [];
    if (messages.length === 0) continue;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') continue;

    try {
      const reply = await openaiGenerate(oai, messages);
      if (!reply) continue;
      if (isLowValueReply(reply)) {
        log('warning', `Catch-up пропущен для ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`}: бессмысленный ответ "${reply}"`);
        continue;
      }

      const replyDelay = randomRange(tg.read_reply_delay_range) * 1000;
      if (shouldStop) await interruptibleSleep(replyDelay, shouldStop); else await sleep(replyDelay);

      let entity;
      try {
        entity = await client.getEntity(tgUserId);
      } catch {
        if (tgUsername) entity = await client.getEntity(tgUsername);
        else throw new Error(`Не удалось найти пользователя ID:${tgUserId}`);
      }
      await client.sendMessage(entity, { message: reply });

      messages.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, messages, undefined, { tgIsBot: isBot });
      replied++;
      log('info', `Catch-up reply: ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`}`);
    } catch (err) {
      log('warning', `Catch-up ошибка ${tgUsername ?? tgUserId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (processed > 0) {
    log('info', `Catch-up за 3 дня: обработано ${processed}, отправлено ${replied}`);
  }
}

async function backfillEmptyDialogs(
  client: TelegramClient,
  account: OutreachAccount,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
) {
  const tg = campaign.telegram_settings as TelegramSettings;

  const { data: dialogs } = await db
    .from('tg_outreach_dialogs')
    .select('id, tg_user_id, tg_username, tg_is_bot, messages')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .limit(50);

  const empty = (dialogs ?? []).filter(
    d => !d.messages || (Array.isArray(d.messages) && (d.messages as unknown[]).length === 0),
  );
  if (empty.length === 0) return;

  log('info', `Backfill: ${empty.length} диалогов с пустыми сообщениями`);

  for (const dialog of empty) {
    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;
    try {
      let entity;
      try {
        entity = await client.getEntity(tgUserId);
      } catch {
        if (tgUsername) entity = await client.getEntity(tgUsername);
        else throw new Error(`Не удалось найти пользователя ID:${tgUserId}`);
      }
      const history = await client.getMessages(entity, { limit: tg.history_limit });

      const backfillLabel = tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`;
      const chatMessages = await extractMessagesFromHistory(client, [...history].reverse(), log, backfillLabel);

      if (chatMessages.length > 0) {
        await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, undefined, { tgIsBot: Boolean(dialog.tg_is_bot) });
        log('info', `Backfill: ${backfillLabel} — ${chatMessages.length} сообщ.`);
      }
    } catch (err) {
      log('warning', `Backfill ошибка ${tgUsername ?? tgUserId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type TraceContext = { requestId: string };

export async function runCampaignLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  traceContext?: TraceContext,
  onProgress?: () => void,
) {
  // Called from every loop hot-spot so the worker-level watchdog can detect
  // a stuck campaign (e.g. gramJS recvLoop blocked, infinite proxy reconnect)
  // and force-exit the process. Without this, the heartbeat setInterval keeps
  // the container "healthy" while the campaign is actually frozen (May 10
  // incident: stuck 35 hours after a single "Пауза 211 сек" log line).
  const tick = () => { try { onProgress?.(); } catch { /* */ } };
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
    // Hard config error — leave in error so we don't loop on it forever
    await db.from('tg_outreach_campaigns').update({ status: 'error' }).eq('id', campaignId);
    return;
  }

  const { data: accounts } = await db
    .from('tg_outreach_accounts')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  if (!accounts?.length) {
    log('error', 'Нет активных аккаунтов — кампания в paused, авто-возобновится когда появятся аккаунты');
    // Use paused (not error) so resumeRunningCampaigns retries us automatically
    // once accounts become active again, instead of leaving the campaign stuck.
    await db.from('tg_outreach_campaigns').update({ status: 'paused' }).eq('id', campaignId);
    return;
  }

  const { data: proxies } = await db
    .from('tg_outreach_proxies')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  log('info', `Запуск кампании "${campaign.name}": ${accounts.length} аккаунтов, ${proxies?.length ?? 0} прокси`);

  const downloadSessionFile = (storagePath: string) => downloadSessionToTemp(db, storagePath);
  let clients = await buildClients(accounts, proxies ?? [], log, downloadSessionFile);

  if (clients.length === 0) {
    log('warning', 'Ни один аккаунт не подключился — жду 60 сек и пробую заново');
    await interruptibleSleep(60_000, shouldStop);
    if (shouldStop()) return;
    const retryClients = await buildClients(accounts, proxies ?? [], log, downloadSessionFile);
    if (retryClients.length === 0) {
      log('error', 'Повторная попытка подключения не удалась — кампания в paused');
      await db.from('tg_outreach_campaigns').update({ status: 'paused' }).eq('id', campaignId);
      return;
    }
    clients = retryClients;
  }

  await db.from('tg_outreach_campaigns').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', campaignId);

  const offsetErrorCounts = new Map<string, number>();

  try {
    while (!shouldStop()) {
      tick();
      try { fs.writeFileSync('/tmp/tg-outreach-heartbeat', Date.now().toString()); } catch { /* */ }

      if (isInSleepPeriod(tg.sleep_periods, tg.timezone_offset)) {
        log('info', 'Спящий период — пауза 60 сек');
        await interruptibleSleep(60_000, shouldStop);
        continue;
      }

      let blockedUserIds: Set<number>;
      try {
        blockedUserIds = await loadBlockedUserIds(db, campaign.user_id);
      } catch (err) {
        log('warning', `Не удалось загрузить глобальный чёрный список: ${err instanceof Error ? err.message : String(err)}`);
        blockedUserIds = new Set();
      }

      let tlSchemaErrorCount = 0;

      for (const { client, account } of clients) {
        if (shouldStop()) break;
        tick();
        // Bump heartbeat per account so the Docker healthcheck doesn't
        // falsely flip to unhealthy during long anti-flood pauses between
        // accounts (outer while-loop heartbeat is written only once per full
        // pass through ALL accounts, which can take 1-2 hours).
        try { fs.writeFileSync('/tmp/tg-outreach-heartbeat', Date.now().toString()); } catch { /* */ }

        const now = new Date();
        if (account.cooldown_until && new Date(account.cooldown_until) > now) {
          log('info', `${account.session_name}: cooldown до ${account.cooldown_until}`);
          continue;
        }

        try {
          let dialogs: Awaited<ReturnType<typeof client.getDialogs>>;
          try {
            dialogs = await client.getDialogs({ limit: DIALOGS_FETCH_LIMIT });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('offset') && errMsg.includes('out of range')) {
              // GramJS off-by-a-few bug in internal pagination; retry with smaller limit.
              dialogs = await client.getDialogs({ limit: Math.min(20, DIALOGS_FETCH_LIMIT) });
            } else {
              throw err;
            }
          }

          for (const dialog of dialogs) {
            if (shouldStop()) break;
            if (dialog.unreadCount === 0) continue;
            if (!dialog.entity || !(dialog.entity instanceof Api.User)) continue;

            try {
              await handleChat(client, account, dialog, campaign as OutreachCampaign, db, log, shouldStop, { blockedUserIds });
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);

              if (
                errMsg.includes('PeerFloodError') ||
                errMsg.includes('FloodWaitError') ||
                errMsg.includes('FrozenMethodInvalidError') ||
                errMsg.includes('FROZEN_METHOD_INVALID')
              ) {
                const cooldownUntil = new Date(Date.now() + tg.account_cooldown_hours * 3600 * 1000).toISOString();
                await db.from('tg_outreach_accounts').update({ cooldown_until: cooldownUntil }).eq('id', account.id);
                (account as OutreachAccount).cooldown_until = cooldownUntil;
                log('warning', `${account.session_name}: FloodError → cooldown ${tg.account_cooldown_hours}ч`);
                break;
              }

              log('error', `Ошибка обработки диалога: ${errMsg}`);
            }
          }

          await handleFollowUp(client, account, campaign as unknown as OutreachCampaign, db, log, shouldStop);
          await handleMissedRepliesLastDays(client, account, campaign as unknown as OutreachCampaign, db, log, shouldStop);

          try {
            await backfillEmptyDialogs(client, account, campaign as unknown as OutreachCampaign, db, log);
          } catch (err) {
            log('warning', `Backfill ошибка: ${err instanceof Error ? err.message : String(err)}`);
          }

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
          } else if (errMsg.includes('AUTH_KEY_UNREGISTERED') || errMsg.includes('USER_DEACTIVATED')) {
            await db
              .from('tg_outreach_accounts')
              .update({ is_active: false, cooldown_until: null })
              .eq('id', account.id);
            log('warning', `${account.session_name}: аккаунт деактивирован (${errMsg.includes('AUTH_KEY_UNREGISTERED') ? 'AUTH_KEY_UNREGISTERED' : 'USER_DEACTIVATED'})`);
          } else if (
            // Only treat "offset out of range" as session damage when it
            // originated in our SQLite session reader, NOT in gramJS MTProto
            // decoder (which throws the same RangeError on transient bad
            // network packets and would falsely deactivate healthy accounts).
            errMsg.includes('offset') && errMsg.includes('out of range')
            && (errMsg.includes('readSqliteSession') || errMsg.includes('.session'))
            && !errMsg.includes('decryptMessageData')
            && !errMsg.includes('MTProtoState')
            && !errMsg.includes('BinaryReader')
            && !errMsg.includes('tgReadObject')
          ) {
            const count = (offsetErrorCounts.get(account.id) ?? 0) + 1;
            offsetErrorCounts.set(account.id, count);
            if (count >= 2) {
              await db
                .from('tg_outreach_accounts')
                .update({ is_active: false, cooldown_until: null })
                .eq('id', account.id);
              log('warning', `${account.session_name}: повреждённая сессия (offset out of range × ${count}) → аккаунт деактивирован. Пересоздайте .session.`);
            } else {
              const cooldownUntil = new Date(Date.now() + 3600_000).toISOString();
              await db.from('tg_outreach_accounts').update({ cooldown_until: cooldownUntil }).eq('id', account.id);
              (account as OutreachAccount).cooldown_until = cooldownUntil;
              log('warning', `${account.session_name}: повреждённая сессия (offset out of range × ${count}) → cooldown 1ч. Деактивация после 2-й попытки.`);
            }
          } else if (errMsg.includes('out of range') || errMsg.includes('TIMEOUT') || errMsg.includes('Constructor ID')) {
            // Transient MTProto/network issue — log but do not punish account
            log('warning', `${account.session_name}: транзиентная ошибка MTProto, пропускаем итерацию: ${errMsg.slice(0, 150)}`);
          } else {
            log('error', `${account.session_name}: ${errMsg}`);
          }
        }

        const accountDelay = randomRange(tg.account_loop_delay_range) * 1000;
        log('info', `Пауза ${Math.round(accountDelay / 1000)} сек перед следующим аккаунтом`);
        await interruptibleSleep(accountDelay, shouldStop);
        tick();
      }

      if (tlSchemaErrorCount > 0 && tlSchemaErrorCount >= clients.length) {
        const tlBackoff = 300_000;
        log('warning', `Все ${tlSchemaErrorCount} аккаунтов получили TL schema ошибку — пауза ${tlBackoff / 1000} сек. Обновите пакет 'telegram' (npm update telegram)`);
        await interruptibleSleep(tlBackoff, shouldStop);
      }

      const cycleDelay = 30_000;
      log('info', `Цикл завершён. Пауза ${cycleDelay / 1000} сек`);
      await interruptibleSleep(cycleDelay, shouldStop);

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
    // On worker shutdown we must preserve campaign status (running/paused), otherwise
    // auto-resume on the next worker start will skip it.
    // Explicit stop is handled by worker handler which sets status=stopped before signaling stop.
    if (!shouldStop()) {
      await db.from('tg_outreach_campaigns')
        .update({ status: 'stopped', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .neq('status', 'paused');
    } else {
      log('info', 'Остановка воркера — статус кампании сохранён для автоподъёма');
    }
    log('info', 'Кампания остановлена');
  }
}

export type RefetchProgress = {
  total: number;
  done: number;
  fetched: number;
  errors: number;
  last_username: string | null;
  last_messages: number;
};

export async function refetchEmptyDialogs(
  campaignId: string,
  db: SupabaseClient,
  traceContext?: TraceContext,
  onProgress?: (p: RefetchProgress) => void | Promise<void>,
) {
  const logToDb = async (level: 'info' | 'warning' | 'error', msg: string) => {
    console.log(`[tg-outreach-refetch][${campaignId.slice(0, 8)}][${level}] ${msg}`);
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

  const { data: allDialogs } = await db
    .from('tg_outreach_dialogs')
    .select('id, tg_user_id, tg_username, account_id, tg_is_bot, messages')
    .eq('campaign_id', campaignId)
    .limit(500);

  const emptyDialogs = (allDialogs ?? []).filter(
    d => !d.messages || (Array.isArray(d.messages) && (d.messages as unknown[]).length === 0),
  );

  if (emptyDialogs.length === 0) {
    log('info', 'Нет диалогов с пустыми сообщениями — refetch не нужен');
    return;
  }

  log('info', `Refetch: найдено ${emptyDialogs.length} диалогов с пустыми сообщениями`);

  const accountIds = [...new Set(emptyDialogs.map(d => d.account_id as string))];

  const { data: accounts } = await db
    .from('tg_outreach_accounts')
    .select('*')
    .in('id', accountIds)
    .eq('is_active', true);

  if (!accounts?.length) {
    log('error', 'Refetch: нет активных аккаунтов для подключения');
    return;
  }

  const { data: proxies } = await db
    .from('tg_outreach_proxies')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  const downloadSessionFile = (storagePath: string) => downloadSessionToTemp(db, storagePath);
  const clients = await buildClients(accounts as OutreachAccount[], proxies ?? [], log, downloadSessionFile);

  if (clients.length === 0) {
    log('error', 'Refetch: ни один аккаунт не подключился');
    return;
  }

  const clientByAccountId = new Map(clients.map(c => [c.account.id, c.client]));
  let fetched = 0;
  let errors = 0;
  let done = 0;
  const total = emptyDialogs.length;

  const reportProgress = async (username: string | null, msgCount: number) => {
    done++;
    if (onProgress) {
      await onProgress({ total, done, fetched, errors, last_username: username, last_messages: msgCount });
    }
  };

  for (const dialog of emptyDialogs) {
    const client = clientByAccountId.get(dialog.account_id as string);
    if (!client) { await reportProgress(dialog.tg_username as string | null, 0); continue; }

    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;

    try {
      let entity;
      try {
        entity = await client.getEntity(tgUserId);
      } catch {
        if (tgUsername) entity = await client.getEntity(tgUsername);
        else throw new Error(`Не удалось найти пользователя ID:${tgUserId}`);
      }
      const history = await client.getMessages(entity, { limit: tg.history_limit });

      const refetchLabel = tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`;
      const chatMessages = await extractMessagesFromHistory(client, [...history].reverse(), log, refetchLabel);

      if (chatMessages.length > 0) {
        await upsertDialog(
          db, campaignId, dialog.account_id as string,
          tgUserId, tgUsername, chatMessages, undefined,
          { tgIsBot: Boolean(dialog.tg_is_bot) },
        );
        fetched++;
        log('info', `Refetch: ${refetchLabel} — ${chatMessages.length} сообщ.`);
      }
      await reportProgress(tgUsername, chatMessages.length);
    } catch (err) {
      errors++;
      log('warning', `Refetch ошибка ${tgUsername ?? tgUserId}: ${err instanceof Error ? err.message : String(err)}`);
      await reportProgress(tgUsername, 0);
    }
  }

  await disconnectAll(clients);
  log('info', `Refetch завершён: ${fetched} обновлено, ${errors} ошибок из ${total} диалогов`);
}
