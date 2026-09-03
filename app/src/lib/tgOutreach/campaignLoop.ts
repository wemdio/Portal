import fs from 'fs';
import path from 'path';
import os from 'os';
import { Api, helpers, utils } from 'telegram';
import type { Dialog } from 'telegram/tl/custom/dialog';
import { Dialog as GramDialog } from 'telegram/tl/custom/dialog';
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import bigInt from 'big-integer';
import type {
  OutreachCampaign,
  OutreachAccount,
  TelegramSettings,
  OpenAISettings,
  DialogMessage,
  OutreachProxy,
} from './types';
import { DEFAULT_FOLLOW_UP } from './types';
import { checkAccount, classifyCheckError } from './accountCheck';
import { isRepeatOfOurs, shouldStaySilent } from './replyGuards';
import { buildClients, describeProxyForLog, disconnectAll, getUpdatedSessionString, probeProxyTcp, reconnectClient, type ActiveClient } from './gramClient';
import type { LoopControl } from './watchdog';
import { orderByStaleness } from './accountRotation';
import { openaiGenerate, detectTrigger } from './openaiChat';
import { loadBlockedUserIds } from './blockedUsers';
import {
  handleProxyError,
  recordAccountSuccess,
  recordProxySuccess,
} from './proxyHealth';
import { sendFirstTouchBatch } from './firstTouch/send';
import { parkAccountAfterLimit } from './accountCooldown';
import { pickForwardIds } from './forwardSelection';
import { runLeadForwardPoller } from './leadForward';
import { buildLeadMessage, splitTelegramMessage } from './leadMessage';
import { loadLeadOrigin } from './leadOrigin';
import { withTimeout } from './withTimeout';
import { truncateMessage } from '@/lib/logger';
import { extractOrConvertToMp3, transcribeAudio } from '@/lib/transcription';

/**
 * Сроки на вызовы Telegram в боевом круге.
 *
 * gramJS не таймаутит вызовы сам, а мобильный прокси меняет IP посреди уже
 * установленного соединения: сокет для библиотеки остаётся живым, запрос уходит
 * в никуда и не возвращается никогда. Такой `await` не будит даже разрыв
 * соединений снаружи — gramJS переподключается внутри себя и ждёт дальше.
 *
 * `withTimeout` для этого и написан, и в прогреве, проверке аккаунтов, проверке
 * прокси и чтении профиля он стоит с 06.08.2026. В боевом цикле его не было ни
 * разу — все девятнадцать вызовов висели без ограничения.
 *
 * Цена выяснилась 28.08.2026. Повисший вызов останавливал круг навсегда: цикл
 * стоял внутри `await`, до проверки «просили остановиться» не доходил, снаружи
 * не будился. Сторожу оставалось только уронить процесс — и вместе с зависшей
 * кампанией умирали четыре здоровые, восемь раз за сутки.
 *
 * Теперь повисший вызов — обычная ошибка: аккаунт пропускается, круг едет
 * дальше, кампания продолжает отчитываться.
 *
 * Сроки намеренно щедрые. Резать живую отправку на медленном мобильном прокси
 * хуже, чем подождать лишнюю минуту: цель — исключить бесконечность, а не
 * ускорить работу. Все крутятся переменными окружения, без пересборки образа.
 */
const TG_RESOLVE_TIMEOUT_MS = Number(process.env.TG_OUTREACH_RESOLVE_TIMEOUT_MS) || 60_000;
const TG_HISTORY_TIMEOUT_MS = Number(process.env.TG_OUTREACH_HISTORY_TIMEOUT_MS) || 90_000;
const TG_READ_TIMEOUT_MS = Number(process.env.TG_OUTREACH_READ_TIMEOUT_MS) || 60_000;
const TG_SEND_TIMEOUT_MS = Number(process.env.TG_OUTREACH_SEND_TIMEOUT_MS) || 120_000;
const TG_FORWARD_TIMEOUT_MS = Number(process.env.TG_OUTREACH_FORWARD_TIMEOUT_MS) || 180_000;
/**
 * Загрузка диалогов уже прикрыта собственным детектором зависания на 180с со
 * своим переподключением (см. ниже по коду). Общий срок ставим чуть больше,
 * чтобы он служил последней страховкой, а не срабатывал раньше специального
 * механизма и не ломал его логику повторной попытки.
 */
const TG_DIALOGS_TIMEOUT_MS = Number(process.env.TG_OUTREACH_DIALOGS_TIMEOUT_MS) || 240_000;

const BUCKET_SESSIONS = 'tg-outreach-sessions';
const SESSION_CACHE_MAX = 100;
const sessionPathCache = new Map<string, string>();

function sessionCacheEvict(): void {
  if (sessionPathCache.size <= SESSION_CACHE_MAX) return;
  const oldest = sessionPathCache.keys().next().value;
  if (oldest != null) sessionPathCache.delete(oldest);
}

export async function downloadSessionToTemp(db: SupabaseClient, storagePath: string): Promise<string> {
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(r => setTimeout(r, ms));
  if (signal.aborted) return Promise.resolve();
  // Пауза обязана рваться сигналом, а не дожидаться конца куска: между
  // аккаунтами кампания спит до десяти минут, и без этого остановка процесса
  // упиралась бы в шаг опроса. Слушателя снимаем всегда — за сутки работы их
  // иначе накапливаются тысячи на одном сигнале.
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function interruptibleSleep(
  ms: number,
  shouldStop: () => boolean,
  chunkMs = 2000,
  signal?: AbortSignal,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) {
    await sleep(Math.min(chunkMs, end - Date.now()), signal);
  }
}

function randomRange([min, max]: [number, number]): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


/**
 * Сколько диалогов аккаунта забирать из getDialogs за итерацию.
 * Было 100 — снизили до 50: меньше данных через прокси = меньше шанс
 * таймаута на getDialogs (3 аккаунта стабильно зависали на 180с).
 * 50 достаточно, т.к. обрабатываются только непрочитанные User-диалоги,
 * а группы/каналы скипаются. Если лиды проваливаются ниже 50-й позиции —
 * поднять через env TG_OUTREACH_DIALOGS_LIMIT.
 */
const DIALOGS_FETCH_LIMIT = Number(process.env.TG_OUTREACH_DIALOGS_LIMIT ?? '50');

/**
 * Hard per-account ceiling on the first gramJS call of each iteration
 * (getDialogs). If MTProto recvLoop hangs on a stale session or a dropped
 * connection, this prevents one stuck account from holding the whole loop
 * hostage and triggering the worker watchdog at 15 minutes. The watchdog
 * still acts as the ultimate backstop for the rest of the iteration.
 */
// Default 180s: accounts with thousands of dialogs (e.g. Политген) routinely
// hit the original 60s ceiling on getDialogs() even when the proxy is healthy.
// Raising the bar trades a small amount of wall-clock time for full dialog
// coverage. Override via TG_OUTREACH_PER_ACCOUNT_TIMEOUT_MS if needed.
const PER_ACCOUNT_FIRST_CALL_TIMEOUT_MS =
  Number(process.env.TG_OUTREACH_PER_ACCOUNT_TIMEOUT_MS) || 180_000;

/** Marker string included in the Error message so the catch branch can
 *  distinguish our explicit timeout from generic TIMEOUT errors. */
const PER_ACCOUNT_TIMEOUT_MARKER = 'per-account first-call TIMEOUT';

/** Marker for the terminal case: getDialogs hung, we rebuilt the client on a
 *  fresh socket and retried in the same round, and the retry ALSO failed. At
 *  that point it's no longer a stale-socket glitch — we emit a full error with
 *  maximum diagnostic context and skip the account for this round. */
const PER_ACCOUNT_RECONNECT_FAILED_MARKER = 'per-account reconnect+retry FAILED';

function isOffsetOutOfRangeError(err: unknown): boolean {
  const errMsg = err instanceof Error ? err.message : String(err);
  return errMsg.includes('offset') && errMsg.includes('out of range');
}

/**
 * gramJS is patched (patches/telegram+2.26.22.patch) to skip TL constructors it
 * doesn't recognise instead of crashing, and to `console.warn`:
 *   "[gramjs-patch] Unknown TL constructor <id> (0x…), skipping…"
 * That id is the exact thing Telegram added that our gramJS layer can't decode
 * — the real cause behind the "offset out of range" failures on big accounts —
 * but the warning only goes to the worker's stdout. We tee console.warn into a
 * small shared ring buffer (kept on globalThis so it survives across bundles and
 * is shared if several campaigns run in one process) so the campaign loop can
 * fold the id into the DB log right where a dialog decode fails. The tap is
 * installed once and is best-effort — it must never throw into console.warn.
 */
interface GramjsUnknownTlEntry { msg: string; at: number }
const GRAMJS_UNKNOWN_TL_MAX = 50;
function gramjsUnknownTlBuf(): GramjsUnknownTlEntry[] {
  const g = globalThis as { __gramjsUnknownTL?: GramjsUnknownTlEntry[] };
  if (!g.__gramjsUnknownTL) g.__gramjsUnknownTL = [];
  return g.__gramjsUnknownTL;
}
function installGramjsWarnTap(): void {
  const g = globalThis as { __gramjsWarnTapped?: boolean };
  if (g.__gramjsWarnTapped) return;
  g.__gramjsWarnTapped = true;
  const orig = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    try {
      const first = args[0];
      if (typeof first === 'string' && first.includes('[gramjs-patch]')) {
        const buf = gramjsUnknownTlBuf();
        buf.push({ msg: first, at: Date.now() });
        if (buf.length > GRAMJS_UNKNOWN_TL_MAX) buf.shift();
      }
    } catch {
      // Never let diagnostics break logging.
    }
    orig(...(args as Parameters<typeof console.warn>));
  };
}
installGramjsWarnTap();

function dialogMessageKey(peer: Api.TypePeer | undefined, messageId: number | undefined): string {
  return `${peer instanceof Api.PeerChannel ? peer.channelId : undefined},${messageId}`;
}

async function loadDialogsPageWithoutGramPagination(
  client: TelegramClient,
  limit: number,
  archived: boolean,
): Promise<helpers.TotalList<Dialog>> {
  const response = await withTimeout(
    client.invoke(new Api.messages.GetDialogs({
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      limit,
      hash: bigInt.zero,
      folderId: archived ? 1 : 0,
    })),
    TG_DIALOGS_TIMEOUT_MS,
    'загрузка диалогов без пагинации',
  );

  const result = new helpers.TotalList<Dialog>();
  if (response instanceof Api.messages.DialogsNotModified) return result;
  result.total = 'count' in response ? response.count : response.dialogs.length;

  const entities = new Map<string, unknown>();
  const messages = new Map<string, Api.Message>();

  for (const entity of [...response.users, ...response.chats]) {
    if (entity instanceof Api.UserEmpty || entity instanceof Api.ChatEmpty) continue;
    entities.set(utils.getPeerId(entity), entity);
  }

  for (const rawMessage of response.messages) {
    if (!(rawMessage instanceof Api.Message)) continue;
    try {
      const finishInit = (rawMessage as { _finishInit?: (c: TelegramClient, e: Map<string, unknown>, chat?: unknown) => void })._finishInit;
      if (finishInit) finishInit.call(rawMessage, client, entities, undefined);
    } catch {
      // Keep the fallback best-effort: one malformed top message should not drop the whole account.
    }
    messages.set(dialogMessageKey(rawMessage.peerId, rawMessage.id), rawMessage);
  }

  for (const rawDialog of response.dialogs) {
    if (rawDialog instanceof Api.DialogFolder) continue;
    const message = messages.get(dialogMessageKey(rawDialog.peer, rawDialog.topMessage));
    if (!message) continue;
    const peerId = utils.getPeerId(rawDialog.peer);
    if (!entities.has(peerId)) continue;
    try {
      result.push(new GramDialog(client, rawDialog, entities as never, message) as Dialog);
    } catch {
      // Same as GramJS iterator: skip dialogs that cannot be materialized.
    }
  }

  return result;
}

async function loadOutreachDialogs(
  client: TelegramClient,
  limit: number,
): Promise<{ dialogs: helpers.TotalList<Dialog>; usedRawPageFallback: boolean }> {
  try {
    return {
      dialogs: await withTimeout(
        client.getDialogs({ limit, archived: false }),
        TG_DIALOGS_TIMEOUT_MS,
        'загрузка диалогов',
      ),
      usedRawPageFallback: false,
    };
  } catch (err) {
    if (!isOffsetOutOfRangeError(err)) throw err;
    return {
      dialogs: await loadDialogsPageWithoutGramPagination(client, limit, false),
      usedRawPageFallback: true,
    };
  }
}

async function probeAccountProxyForLog(
  account: OutreachAccount,
  proxyMap: Map<string, OutreachProxy>,
): Promise<string> {
  if (!account.proxy_id) return 'Прокси: не назначен, тест прокси не выполнялся';

  const proxy = proxyMap.get(account.proxy_id);
  if (!proxy) {
    return `Прокси: proxy_id=${account.proxy_id} не найден среди активных прокси кампании, тест прокси не выполнялся`;
  }

  const startedAt = Date.now();
  try {
    const probe = await probeProxyTcp(proxy);
    const durationMs = Date.now() - startedAt;
    return (
      `Прокси-тест выполнен: ${describeProxyForLog(proxy)}; ` +
      `tcp_alive=${probe.alive ? 'yes' : 'no'}, latency_ms=${probe.latencyMs}, ` +
      `probe_duration_ms=${durationMs}` +
      (probe.error ? `, error="${probe.error}"` : '')
    );
  } catch (err) {
    return (
      `Прокси-тест не смог завершиться: ${describeProxyForLog(proxy)}; ` +
      `error="${err instanceof Error ? err.message : String(err)}"`
    );
  }
}

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

/**
 * Чем кончилась автопересылка переписки менеджеру.
 *
 * Пишется в тот же апдейт диалога, что и статус «Лид»: это одно событие, и
 * отдельный запрос ради трёх полей только добавил бы момент, когда статус уже
 * стоит, а отметка о передаче ещё нет.
 */
interface AutoForwardOutcome {
  /** Куда пересылали. Снимок настройки на момент отправки. */
  chat: string | null;
  /** Когда ушло. NULL — не ушло. */
  at: string | null;
  /** Причина, если не ушло. */
  error: string | null;
}

function autoForwardPayload(outcome?: AutoForwardOutcome): Record<string, unknown> {
  if (!outcome) return {};
  return {
    auto_forwarded_at: outcome.at,
    auto_forward_chat: outcome.chat,
    auto_forward_error: outcome.error,
  };
}

async function upsertDialog(
  db: SupabaseClient,
  campaignId: string,
  accountId: string,
  tgUserId: number,
  tgUsername: string | null,
  messages: DialogMessage[],
  status?: string,
  opts?: { canSend?: boolean; initialCanSend?: boolean; tgIsBot?: boolean; autoForward?: AutoForwardOutcome },
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
      ...autoForwardPayload(opts?.autoForward),
    };
    // initialCanSend применяется ТОЛЬКО при insert — иначе перезапишет ручной
    // toggle оператора в UI при следующем витке цикла.
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
      can_send: opts?.canSend ?? opts?.initialCanSend ?? !(opts?.tgIsBot ?? false),
      last_message_at: lastMessageAt,
      ...autoForwardPayload(opts?.autoForward),
    });
  }
}

/**
 * Этот собеседник — из тех, кому мы писали сами по базе кампании?
 *
 * `tg_outreach_processed` пополняется ровно в момент первого касания (и вручную
 * со вкладки «Обработанные»), поэтому отвечает на вопрос «мы начинали этот
 * разговор?» точнее, чем история переписки: в купленном аккаунте наши
 * исходящие есть и в чатах прогрева, к базе отношения не имеющих.
 */
async function isCampaignContact(
  db: SupabaseClient,
  campaignId: string,
  tgUserId: number,
): Promise<boolean> {
  const { data } = await db
    .from('tg_outreach_processed')
    .select('tg_user_id')
    .eq('campaign_id', campaignId)
    .eq('tg_user_id', tgUserId)
    .maybeSingle();
  return Boolean(data);
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

/**
 * If `errMsg` describes a permanently unreachable peer, flip can_send=false
 * for that dialog so future cycles short-circuit before burning a GPT call
 * and another SendMessage attempt. Returns the matched code (or null when
 * the error doesn't match any known terminal condition).
 *
 * Codes covered:
 *  - PEER_ID_INVALID       — peer reference is stale (account deleted, etc.)
 *  - INPUT_USER_DEACTIVATED — Telegram banned the user
 *  - USER_BANNED_IN_CHANNEL — applies only to channels but bubbles up here too
 *  - USER_IS_BLOCKED       — they blocked us
 *
 * Operators can still see the dialog in the UI and re-enable manually if a
 * peer becomes reachable again (rare, but worth keeping the data).
 */
async function disableDialogIfUnreachable(
  errMsg: string,
  ctx: {
    db: SupabaseClient;
    campaignId: string;
    accountId: string;
    tgUserId: number | null;
    dialogLabel: string;
    log: LogFn;
  },
): Promise<string | null> {
  const reasonCode =
    errMsg.includes('PEER_ID_INVALID') ? 'PEER_ID_INVALID' :
    errMsg.includes('INPUT_USER_DEACTIVATED') ? 'INPUT_USER_DEACTIVATED' :
    errMsg.includes('USER_BANNED_IN_CHANNEL') ? 'USER_BANNED_IN_CHANNEL' :
    errMsg.includes('USER_IS_BLOCKED') ? 'USER_IS_BLOCKED' :
    null;
  if (!reasonCode) return null;

  if (ctx.tgUserId == null) {
    ctx.log('warning', `Диалог ${ctx.dialogLabel}: ${reasonCode} — пользователь недоступен, но автоматически отключить не могу (нет числового tg_user_id).`);
    return reasonCode;
  }

  // Маппинг Telegram-кода на короткую категорию для audit-поля
  // can_send_changed_reason. UI решает, как это рендерить (например,
  // «Telegram: пользователь удалил аккаунт» вместо `tg_user_deactivated`).
  const audit_reason =
    reasonCode === 'INPUT_USER_DEACTIVATED' ? 'tg_user_deactivated' :
    reasonCode === 'PEER_ID_INVALID' ? 'tg_peer_invalid' :
    reasonCode === 'USER_BANNED_IN_CHANNEL' ? 'tg_user_banned_in_channel' :
    reasonCode === 'USER_IS_BLOCKED' ? 'tg_user_blocked_bot' :
    'tg_unreachable';

  const { error: csErr } = await ctx.db
    .from('tg_outreach_dialogs')
    .update({
      can_send: false,
      can_send_changed_at: new Date().toISOString(),
      // changed_by = NULL: переключение сделал воркер, не человек.
      can_send_changed_by: null,
      can_send_changed_reason: audit_reason,
    })
    .eq('campaign_id', ctx.campaignId)
    .eq('account_id', ctx.accountId)
    .eq('tg_user_id', ctx.tgUserId);
  if (csErr) {
    ctx.log('error', `Диалог ${ctx.dialogLabel}: получили ${reasonCode}, но не смог отключить отправку в базе данных — ${csErr.message}. Будем дальше тратить GPT-запросы на этом диалоге.`);
  } else {
    ctx.log('warning', `Диалог ${ctx.dialogLabel}: Telegram вернул ${reasonCode} — пользователь недоступен (удалил аккаунт, заблокировал бота или невалидный peer). Дальнейшие отправки в этот диалог отключены автоматически (can_send=false).`);
  }
  return reasonCode;
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

/**
 * Исход пересылки возвращаем, а не только пишем в журнал.
 *
 * Сбой автопересылки — это лид, который не доехал до менеджера. Пока он оседал
 * одной строкой среди сотен строк круга, диалог снаружи выглядел как успешный:
 * статус «Лид» ставится в той же ветке независимо от того, ушла переписка или
 * нет. Теперь исход доезжает до карточки диалога.
 */
async function forwardToTargetChat(
  client: TelegramClient,
  fromPeer: Api.TypeEntityLike,
  messageIds: number[],
  targetUsername: string,
  log: LogFn,
  cardText?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!targetUsername) return { ok: false, error: 'чат для пересылки не указан в настройках кампании' };
  const target = targetUsername.startsWith('@') ? targetUsername.slice(1) : targetUsername;

  // Карточка идёт первой, ровно как при ручной передаче: нативная пересылка
  // отдаёт оригиналы реплик, но не отвечает на «кто это и по какому офферу»,
  // а у части контактов из неё даже не открывается профиль собеседника.
  // Сбой карточки не отменяет пересылку — переписка менеджеру важнее.
  if (cardText) {
    try {
      for (const part of splitTelegramMessage(cardText)) {
        await withTimeout(
          client.sendMessage(target, { message: part }),
          TG_SEND_TIMEOUT_MS,
          'отправка карточки лида',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('warning', `Карточка лида не ушла в ${targetUsername} — ${msg}. Пересылаю переписку без неё.`);
    }
  }

  try {
    await withTimeout(
      client.forwardMessages(target, { fromPeer, messages: messageIds }),
      TG_FORWARD_TIMEOUT_MS,
      'пересылка переписки менеджеру',
    );
    log('info', `Переслано в ${targetUsername}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Ошибка пересылки в ${targetUsername}: ${msg}`);
    return { ok: false, error: msg };
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
    log('info', `${displayName}: в глобальном чёрном списке (по ID пользователя) — пропускаю`);
    return { replied: false, triggerType: null };
  }

  const blocked = new Set((tg.blocked_usernames ?? []).map((u) => u.trim().toLowerCase().replace(/^@/, '')));
  if (tgUsername && blocked.has(tgUsername.toLowerCase().replace(/^@/, ''))) {
    log('info', `${displayName}: в чёрном списке по @username — пропускаю`);
    return { replied: false, triggerType: null };
  }

  if (tg.ignore_bot_usernames && tgIsBot) {
    log('info', `${displayName}: это бот — пропускаю (включена настройка "игнорировать ботов")`);
    return { replied: false, triggerType: null };
  }
  if (tg.ignore_no_username && !tgUsername) {
    log('info', `${displayName}: у пользователя нет @username — пропускаю (включена настройка "игнорировать без username")`);
    return { replied: false, triggerType: null };
  }

  const preReadDelay = randomRange(tg.pre_read_delay_range) * 1000;
  if (shouldStop) await interruptibleSleep(preReadDelay, shouldStop); else await sleep(preReadDelay);

  try {
    await withTimeout(
      client.invoke(new Api.messages.ReadHistory({ peer: entity, maxId: 0 })),
      TG_READ_TIMEOUT_MS,
      'отметка «прочитано»',
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Some accounts get rate-limited / partially frozen for read operations (MTProto error 420).
    // We still want to reply; just skip marking as read.
    if (errMsg.includes('FROZEN_METHOD_INVALID') || errMsg.includes('FrozenMethodInvalid')) {
      log('warning', `${displayName}: Telegram временно заблокировал отметку "прочитано" для этого аккаунта (FROZEN_METHOD_INVALID) — продолжаю работу без отметки`);
    } else {
      throw err;
    }
  }

  let history;
  try {
    history = await withTimeout(
      client.getMessages(entity, { limit: tg.history_limit }),
      TG_HISTORY_TIMEOUT_MS,
      'чтение истории диалога',
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // GramJS sometimes reports offset out-of-range for history pagination; a smaller retry is usually enough.
    if (errMsg.includes("offset") && errMsg.includes('out of range')) {
      history = await withTimeout(
        client.getMessages(entity, { limit: Math.min(20, Math.max(5, tg.history_limit)) }),
        TG_HISTORY_TIMEOUT_MS,
        'чтение истории диалога (короткая попытка)',
      );
    } else {
      throw err;
    }
  }
  const chatMessages = await extractMessagesFromHistory(client, [...history].reverse(), log, displayName);

  if (chatMessages.length === 0) {
    return { replied: false, triggerType: null };
  }

  await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, undefined, {
    tgIsBot,
    initialCanSend: Boolean(tg.auto_allow_new_dialogs) && !tgIsBot,
  });

  if (!(await canSendToDialog(db, campaign.id, account.id, tgUserId))) {
    log('info', `${displayName}: отправка в этот диалог отключена вручную в UI — пропускаю`);
    return { replied: false, triggerType: null };
  }

  // Сильнее, чем «отвечать только если ранее писали»: та проверка смотрит на
  // наличие нашего исходящего в переписке, а в купленном аккаунте оно есть и в
  // чатах прогрева — аккаунты писали друг другу. Из-за этого бот отвечал
  // боевым скриптом партнёрам по прогреву и слал фальшивые лиды в чат
  // менеджера. Здесь берём только тех, кому писали по базе кампании.
  if (tg.reply_only_to_base_contacts) {
    if (!(await isCampaignContact(db, campaign.id, tgUserId))) {
      log('info', `${displayName}: не из баз кампании — пропускаю (включена настройка «писать только контактам из баз»)`);
      return { replied: false, triggerType: null };
    }
  }

  if (tg.reply_only_if_previously_wrote) {
    const hasOurMessage = chatMessages.some(m => m.role === 'assistant');
    if (!hasOurMessage) {
      log('info', `${displayName}: ранее не писали этому пользователю — пропускаю (включена настройка "отвечать только тем, кому уже писали")`);
      return { replied: false, triggerType: null };
    }
  }

  // Вежливая точка ответа не требует. Проверяем ДО генерации: это ещё и
  // сэкономленный вызов модели, но главное — на «Спасибо.» мы дописывали
  // реплику в законченный разговор, а лишние исходящие в мёртвом диалоге для
  // Telegram выглядят так же плохо, как дословные повторы.
  //
  // Согласие («Да», «Ок») сюда не попадает, если мы перед этим спросили: лид
  // распознаётся по НАШЕМУ ответу, и промолчать значило бы его потерять.
  if (shouldStaySilent(chatMessages)) {
    log('info', `${displayName}: последнее сообщение — вежливая точка, отвечать не на что`);
    return { replied: false, triggerType: null };
  }

  let replyText: string | null = null;
  let usedFallback = false;
  const openaiStart = Date.now();
  try {
    replyText = await openaiGenerate(oai, chatMessages);
    const openaiSec = ((Date.now() - openaiStart) / 1000).toFixed(1);
    if (replyText) {
      log('info', `${displayName}: GPT сгенерировал ответ за ${openaiSec}с (${replyText.length} символов)`);
    } else {
      log('warning', `${displayName}: GPT не вернул ответ (запрос длился ${openaiSec}с) — отправлять нечего`);
    }
  } catch (err) {
    const openaiSec = ((Date.now() - openaiStart) / 1000).toFixed(1);
    log('error', `${displayName}: ошибка GPT за ${openaiSec}с — ${err instanceof Error ? err.message : String(err)}`);
    if (oai.use_fallback_on_fail && oai.fallback_text) {
      replyText = oai.fallback_text;
      usedFallback = true;
      log('info', `${displayName}: использую заготовленный fallback-ответ (${replyText.length} символов)`);
    }
  }

  if (!replyText) {
    return { replied: false, triggerType: null };
  }
  if (isLowValueReply(replyText)) {
    log('warning', `${displayName}: ${usedFallback ? 'fallback' : 'GPT'} вернул бессмысленный ответ "${replyText}" — НЕ отправляю`);
    return { replied: false, triggerType: null };
  }
  // Молча промолчать лучше, чем повторить себя же: в тупике разговора модели
  // нечего сказать, и она слово в слово шлёт свою прощальную реплику. Человек
  // видит сломанного бота, а Telegram — одинаковые сообщения, то есть признак
  // спам-рассылки. Пересоздавать ответ не пытаемся: истории с прошлого раза не
  // прибавилось, второй заход дал бы тот же текст.
  if (isRepeatOfOurs(replyText, chatMessages)) {
    log('warning', `${displayName}: ответ дословно повторяет то, что мы уже писали ("${replyText}") — НЕ отправляю`);
    return { replied: false, triggerType: null };
  }

  const readReplyDelay = randomRange(tg.read_reply_delay_range) * 1000;
  if (shouldStop) await interruptibleSleep(readReplyDelay, shouldStop); else await sleep(readReplyDelay);

  const sent = await withTimeout(
    client.sendMessage(entity, { message: replyText }),
    TG_SEND_TIMEOUT_MS,
    'отправка ответа',
  );
  log('info', `${displayName}: ответ отправлен (${replyText.length} символов)`);

  chatMessages.push({
    role: 'assistant',
    content: replyText,
    timestamp: new Date().toISOString(),
  });

  const triggerType = detectTrigger(replyText, oai);

  if (triggerType) {
    const triggerLabel = triggerType === 'positive' ? 'положительный (заинтересован)' : 'отрицательный (не заинтересован)';
    log('info', `${displayName}: сработал триггер "${triggerLabel}"`);

    const targetChat = triggerType === 'positive'
      ? oai.target_chats_positive
      : oai.target_chats_negative;

    let outcome: { ok: true } | { ok: false; error: string };
    if (targetChat) {
      const messageIdsToForward = pickForwardIds(history, tg.forward_limit, sent.id);
      // Карточку шлём только положительному триггеру: отрицательный уходит в
      // другой чат как архив отказа, представлять там «Лида» — неправда.
      let card: string | null = null;
      if (triggerType === 'positive') {
        try {
          const origin = await loadLeadOrigin(db, campaign.id, tgUsername);
          card = buildLeadMessage({
            kind: 'lead',
            campaignName: campaign.name,
            username: tgUsername,
            tgUserId,
            baseName: origin.baseName,
            sourceChat: origin.sourceChat,
            messages: chatMessages,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log('warning', `${displayName}: не смог собрать карточку лида — ${msg}. Пересылаю переписку без неё.`);
        }
      }
      outcome = await forwardToTargetChat(client, entity, messageIdsToForward, targetChat, log, card);
    } else {
      log('info', `${displayName}: триггер "${triggerLabel}" сработал, но чат для пересылки не указан в настройках кампании — пересылка пропущена`);
      outcome = { ok: false, error: 'чат для пересылки не указан в настройках кампании' };
    }

    // Отметку ставим только положительному триггеру. Отрицательный тоже
    // пересылает, но в другой чат и по другому поводу: «ушёл менеджеру» про
    // человека, который отказался, — неправда.
    const autoForward: AutoForwardOutcome | undefined = triggerType === 'positive'
      ? {
          chat: targetChat || null,
          at: outcome.ok ? new Date().toISOString() : null,
          error: outcome.ok ? null : outcome.error,
        }
      : undefined;

    await markProcessed(db, campaign.id, tgUserId, tgUsername);
    await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, triggerType === 'positive' ? 'lead' : 'not_lead', { tgIsBot, canSend: false, autoForward });
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
  if (!tg.follow_up?.enabled) {
    return;
  }
  if (totalDelayMs <= 0 || !followUpPrompt) {
    log('info', `Аккаунт ${account.session_name}: напоминания (follow-up) пропущены — не задана задержка или промпт в настройках кампании`);
    return;
  }

  const cutoff = new Date(Date.now() - totalDelayMs).toISOString();

  const { data: dialogs, error: fErr } = await db
    .from('tg_outreach_dialogs')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .eq('status', 'none')
    .eq('can_send', true)
    .lt('last_message_at', cutoff)
    .limit(10);

  if (fErr) {
    log('warning', `Аккаунт ${account.session_name}: напоминания (follow-up) — не смог получить список диалогов из базы данных: ${fErr.message}`);
    return;
  }
  if (!dialogs?.length) {
    log('info', `Аккаунт ${account.session_name}: напоминания (follow-up) — нет диалогов, где наше последнее сообщение старше ${delayHours}ч ${delayMinutes}мин`);
    return;
  }

  // Aggregate skip reasons across the batch so we emit one summary at the
  // end instead of dozens of per-skip log lines.
  const stats = {
    scanned: dialogs.length,
    sent: 0,
    skip_bot: 0,
    skip_blocked: 0,
    skip_empty: 0,
    skip_last_not_assistant: 0,
    skip_already_sent: 0,
    skip_openai_empty: 0,
    skip_low_value: 0,
    errors: 0,
  };

  for (const dialog of dialogs) {
    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;
    const isBot = Boolean(dialog.tg_is_bot);
    if (isBot && tg.ignore_bot_usernames) { stats.skip_bot++; continue; }
    if (tgUsername && blocked.has(tgUsername.toLowerCase().replace(/^@/, ''))) { stats.skip_blocked++; continue; }

    const messages = dialog.messages as DialogMessage[];
    if (messages.length === 0) { stats.skip_empty++; continue; }
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'assistant') { stats.skip_last_not_assistant++; continue; }

    const alreadySentFollowUp = messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Система: пользователь не ответил'));
    if (alreadySentFollowUp) { stats.skip_already_sent++; continue; }

    try {
      const followUpMessages: DialogMessage[] = [
        ...messages,
        { role: 'user', content: `[Система: пользователь не ответил ${delayHours}ч ${delayMinutes}мин. ${followUpPrompt}]` },
      ];

      const reply = await openaiGenerate(oai, followUpMessages);
      if (!reply) { stats.skip_openai_empty++; continue; }
      if (isLowValueReply(reply)) {
        stats.skip_low_value++;
        log('warning', `Напоминание для ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`} пропущено: GPT вернул бессмысленный ответ "${reply}"`);
        continue;
      }

      const followUpDelay = randomRange(tg.read_reply_delay_range) * 1000;
      if (shouldStop) await interruptibleSleep(followUpDelay, shouldStop); else await sleep(followUpDelay);
      const entity = await withTimeout(
        client.getEntity(tgUserId),
        TG_RESOLVE_TIMEOUT_MS,
        'поиск собеседника по id',
      );
      await withTimeout(
        client.sendMessage(entity, { message: reply }),
        TG_SEND_TIMEOUT_MS,
        'отправка сообщения',
      );

      messages.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, messages, undefined, { tgIsBot: isBot });
      stats.sent++;
      log('info', `Напоминание отправлено ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`} (${reply.length} символов)`);
    } catch (err) {
      stats.errors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      // Same unreachable-peer treatment as in handleChat — saves a GPT call
      // next round if this user is permanently gone.
      const unreachable = await disableDialogIfUnreachable(errMsg, {
        db,
        campaignId: campaign.id,
        accountId: account.id,
        tgUserId,
        dialogLabel: tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`,
        log,
      });
      if (!unreachable) {
        log('warning', `Напоминание для ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`} не отправлено — ошибка: ${errMsg}`);
      }
    }
  }

  // Always emit a summary, even when 0 sent — gives an "I ran" signal in the
  // log instead of a silent block of time.
  log(
    'info',
    `Аккаунт ${account.session_name}: напоминания (follow-up) — проверил ${stats.scanned} диалогов, отправил ${stats.sent} напоминаний.` +
      (stats.skip_already_sent ||
        stats.skip_last_not_assistant ||
        stats.skip_empty ||
        stats.skip_bot ||
        stats.skip_blocked ||
        stats.skip_openai_empty ||
        stats.skip_low_value
        ? ' Не отправил по причинам:'
        : '') +
      (stats.skip_already_sent ? ` уже напоминали ранее — ${stats.skip_already_sent};` : '') +
      (stats.skip_last_not_assistant ? ` последнее сообщение не от нас — ${stats.skip_last_not_assistant};` : '') +
      (stats.skip_empty ? ` пустая история диалога — ${stats.skip_empty};` : '') +
      (stats.skip_bot ? ` это боты — ${stats.skip_bot};` : '') +
      (stats.skip_blocked ? ` в чёрном списке — ${stats.skip_blocked};` : '') +
      (stats.skip_openai_empty ? ` GPT не вернул ответ — ${stats.skip_openai_empty};` : '') +
      (stats.skip_low_value ? ` GPT вернул мусор — ${stats.skip_low_value};` : '') +
      (stats.errors ? ` Ошибок при отправке: ${stats.errors}.` : ''),
  );
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

  const { data: dialogs, error: cErr } = await db
    .from('tg_outreach_dialogs')
    .select('id, tg_user_id, tg_username, tg_is_bot, status, can_send, messages, last_message_at')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .eq('status', 'none')
    .eq('can_send', true)
    .gte('last_message_at', cutoffIso)
    .order('last_message_at', { ascending: true })
    .limit(200);

  if (cErr) {
    log('warning', `Аккаунт ${account.session_name}: проверка пропущенных ответов (catch-up) — не смог получить список диалогов: ${cErr.message}`);
    return;
  }
  if (!dialogs?.length) {
    log('info', `Аккаунт ${account.session_name}: проверка пропущенных ответов (catch-up) — нет диалогов за последние 3 дня, где пользователь написал последним`);
    return;
  }

  let processed = 0;
  let replied = 0;
  let skipBot = 0;
  let skipBlocked = 0;
  let skipEmpty = 0;
  let skipLastNotUser = 0;
  let skipOpenaiEmpty = 0;
  let skipLowValue = 0;
  let skipRepeat = 0;
  let skipCloser = 0;
  let errorsCount = 0;

  for (const dialog of dialogs) {
    if (shouldStop?.()) break;
    processed++;

    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;
    const isBot = Boolean(dialog.tg_is_bot);
    if (isBot && tg.ignore_bot_usernames) { skipBot++; continue; }
    if (tgUsername && blocked.has(tgUsername.toLowerCase().replace(/^@/, ''))) { skipBlocked++; continue; }

    const messages = Array.isArray(dialog.messages) ? (dialog.messages as DialogMessage[]) : [];
    if (messages.length === 0) { skipEmpty++; continue; }
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') { skipLastNotUser++; continue; }

    if (shouldStaySilent(messages)) {
      skipCloser++;
      continue;
    }

    try {
      const reply = await openaiGenerate(oai, messages);
      if (!reply) { skipOpenaiEmpty++; continue; }
      if (isLowValueReply(reply)) {
        skipLowValue++;
        log('warning', `Catch-up: ответ для ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`} не отправлен — GPT вернул бессмысленный текст "${reply}"`);
        continue;
      }
      // См. комментарий у той же проверки в основном цикле: дословный
      // самоповтор — признак спам-рассылки для Telegram.
      if (isRepeatOfOurs(reply, messages)) {
        skipRepeat++;
        log('warning', `Catch-up: ответ для ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`} дословно повторяет уже отправленное — НЕ отправляю`);
        continue;
      }

      const replyDelay = randomRange(tg.read_reply_delay_range) * 1000;
      if (shouldStop) await interruptibleSleep(replyDelay, shouldStop); else await sleep(replyDelay);

      let entity;
      try {
        entity = await withTimeout(
          client.getEntity(tgUserId),
          TG_RESOLVE_TIMEOUT_MS,
          'поиск собеседника по id',
        );
      } catch {
        if (tgUsername) {
          entity = await withTimeout(
            client.getEntity(tgUsername),
            TG_RESOLVE_TIMEOUT_MS,
            'поиск собеседника по юзернейму',
          );
        }
        else throw new Error(`Не удалось найти пользователя ID:${tgUserId}`);
      }
      await withTimeout(
        client.sendMessage(entity, { message: reply }),
        TG_SEND_TIMEOUT_MS,
        'отправка догоняющего сообщения',
      );

      messages.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, messages, undefined, { tgIsBot: isBot });
      replied++;
      log('info', `Catch-up: отправлен запоздалый ответ ${tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`} (${reply.length} символов)`);
    } catch (err) {
      errorsCount++;
      const errMsg = err instanceof Error ? err.message : String(err);
      const unreachable = await disableDialogIfUnreachable(errMsg, {
        db,
        campaignId: campaign.id,
        accountId: account.id,
        tgUserId,
        dialogLabel: tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`,
        log,
      });
      if (!unreachable) {
        log('warning', `Catch-up: ответ для ${tgUsername ?? tgUserId} не отправлен — ошибка: ${errMsg}`);
      }
    }
  }

  // Always emit a summary so the operator can confirm catch-up actually ran.
  log(
    'info',
    `Аккаунт ${account.session_name}: проверка пропущенных ответов (catch-up за 3 дня) — проверил ${processed} диалогов, отправил ${replied} ответов.` +
      (skipBot || skipBlocked || skipEmpty || skipLastNotUser || skipOpenaiEmpty || skipLowValue || skipRepeat || skipCloser
        ? ' Не отправил по причинам:'
        : '') +
      (skipBot ? ` это боты — ${skipBot};` : '') +
      (skipBlocked ? ` в чёрном списке — ${skipBlocked};` : '') +
      (skipEmpty ? ` пустая история — ${skipEmpty};` : '') +
      (skipLastNotUser ? ` мы уже ответили последними — ${skipLastNotUser};` : '') +
      (skipOpenaiEmpty ? ` GPT не вернул ответ — ${skipOpenaiEmpty};` : '') +
      (skipLowValue ? ` GPT вернул мусор — ${skipLowValue};` : '') +
      (skipRepeat ? ` дословный повтор нашего же ответа — ${skipRepeat};` : '') +
      (skipCloser ? ` вежливая точка, отвечать не на что — ${skipCloser};` : '') +
      (errorsCount ? ` Ошибок при отправке: ${errorsCount}.` : ''),
  );
}

async function backfillEmptyDialogs(
  client: TelegramClient,
  account: OutreachAccount,
  campaign: OutreachCampaign,
  db: SupabaseClient,
  log: LogFn,
) {
  const tg = campaign.telegram_settings as TelegramSettings;

  const { data: dialogs, error: bErr } = await db
    .from('tg_outreach_dialogs')
    .select('id, tg_user_id, tg_username, tg_is_bot, messages')
    .eq('campaign_id', campaign.id)
    .eq('account_id', account.id)
    .limit(50);

  if (bErr) {
    log('warning', `Аккаунт ${account.session_name}: дозаполнение истории (backfill) — не смог получить список диалогов: ${bErr.message}`);
    return;
  }

  const empty = (dialogs ?? []).filter(
    d => !d.messages || (Array.isArray(d.messages) && (d.messages as unknown[]).length === 0),
  );
  if (empty.length === 0) {
    // Quiet at info level — backfill runs every cycle and the "nothing to do"
    // case would otherwise spam the log. Just skip silently.
    return;
  }

  log('info', `Аккаунт ${account.session_name}: дозаполнение истории (backfill) — нашёл ${empty.length} диалогов без сохранённой переписки, иду в Telegram за историей`);
  let filled = 0;
  let stillEmpty = 0;
  let errors = 0;

  for (const dialog of empty) {
    const tgUserId = dialog.tg_user_id as number;
    const tgUsername = dialog.tg_username as string | null;
    try {
      let entity;
      try {
        entity = await withTimeout(
          client.getEntity(tgUserId),
          TG_RESOLVE_TIMEOUT_MS,
          'поиск собеседника по id',
        );
      } catch {
        if (tgUsername) {
          entity = await withTimeout(
            client.getEntity(tgUsername),
            TG_RESOLVE_TIMEOUT_MS,
            'поиск собеседника по юзернейму',
          );
        }
        else throw new Error(`Не удалось найти пользователя ID:${tgUserId}`);
      }
      const history = await withTimeout(
        client.getMessages(entity, { limit: tg.history_limit }),
        TG_HISTORY_TIMEOUT_MS,
        'чтение истории диалога',
      );

      const backfillLabel = tgUsername ? `@${tgUsername}` : `ID:${tgUserId}`;
      const chatMessages = await extractMessagesFromHistory(client, [...history].reverse(), log, backfillLabel);

      if (chatMessages.length > 0) {
        await upsertDialog(db, campaign.id, account.id, tgUserId, tgUsername, chatMessages, undefined, { tgIsBot: Boolean(dialog.tg_is_bot) });
        log('info', `Backfill: загрузил ${chatMessages.length} сообщений для ${backfillLabel}`);
        filled++;
      } else {
        stillEmpty++;
      }
    } catch (err) {
      errors++;
      log('warning', `Backfill: не смог загрузить историю для ${tgUsername ?? tgUserId} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    'info',
    `Аккаунт ${account.session_name}: дозаполнение истории завершено — заполнил ${filled} диалогов, ещё пустых осталось ${stillEmpty}` +
      (errors ? `, ошибок при загрузке ${errors}` : '') +
      '.',
  );
}

export type TraceContext = { requestId: string };

/**
 * Что кампания сохраняет между исполнителями.
 *
 * Круг по всем аккаунтам идёт часами: пауза между аккаунтами доходит до десяти
 * минут, а сам аккаунт занят минутами. Без чекпойнта перехват строки означал бы
 * начать круг с начала — то есть заново пройти уже отработанные аккаунты и
 * снова выждать их паузы. С ним перехват стоит одной паузы.
 *
 * Счётчики здесь — те самые, что раньше жили ТОЛЬКО в памяти процесса и
 * обнулялись при каждом рестарте. Их смысл в накоплении: аккаунт уводится на
 * паузу за ДВА пустых круга подряд, а на шестичасовую — за ПЯТЬ сбоев загрузки
 * диалогов. Пока они терялись при передаче, «подряд» на практике не наступало
 * никогда, если воркер перезапускался чаще, чем кампания успевала накопить.
 */
export interface CampaignCheckpoint {
  /** Номер круга по всем аккаунтам с начала прогона. Для журнала и диагностики. */
  round: number;
  /** Последний ПОЛНОСТЬЮ отработанный аккаунт — с него не начинаем. */
  lastAccountId: string | null;
  /** accountId -> сколько кругов подряд аккаунт не резолвнул ни одного ника. */
  resolveBlockedRounds: Record<string, number>;
  /** accountId -> сколько раз подряд не смог загрузить диалоги. */
  pagingFailureCounts: Record<string, number>;
  /** accountId -> сколько раз подряд не прочитался .session-файл. */
  offsetErrorCounts: Record<string, number>;
}

/**
 * Связь с раннером аренды (app/src/lib/jobs/lifecycle.ts).
 *
 * Необязательна: цикл остаётся вызываемым и без неё (тесты, ручной прогон), но
 * тогда у него нет ни ограждения записей жетоном, ни чекпойнта.
 */
export interface CampaignRunContext {
  /** Взводится при остановке процесса и при потере аренды. */
  signal?: AbortSignal;
  /** Жетон владения: им ограждается КАЖДАЯ запись в строку кампании. */
  runToken?: string;
  checkpoint?: CampaignCheckpoint | null;
  saveCheckpoint?: (data: CampaignCheckpoint) => Promise<boolean>;
}

export async function runCampaignLoop(
  campaignId: string,
  db: SupabaseClient,
  shouldStop: () => boolean,
  traceContext?: TraceContext,
  onProgress?: () => void,
  control?: LoopControl,
  runtime?: CampaignRunContext,
) {
  // Отметка «цикл продвинулся» из всех горячих точек. Раньше её читал
  // сторожевой таймер воркера, теперь — колонка прогресса `progress_at` строки
  // кампании: пока она двигается, аренда продлевается, а если встала дольше
  // порога, библиотека прерывает работу и отдаёт кампанию соседу. Точки те же
  // самые, изменился только адресат.
  const tick = () => { try { onProgress?.(); } catch { /* */ } };
  const signal = runtime?.signal;
  const runToken = runtime?.runToken;

  /**
   * Любая запись в строку кампании — только под жетоном.
   *
   * Между двумя нашими записями строку мог перехватить сосед (истекла аренда,
   * оператор нажал «Стоп» и снял владение). Незаграждённая запись тогда
   * затирала бы решение нового владельца или воскрешала бы кампанию, которую
   * только что остановили. Жетона нет — значит, цикл запущен без раннера, и
   * ограждать нечем.
   */
  const campaignUpdate = (patch: Record<string, unknown>) => {
    const q = db.from('tg_outreach_campaigns').update(patch).eq('id', campaignId);
    return runToken ? q.eq('run_token', runToken) : q;
  };
  /**
   * Терминальная запись снимает и владение: аренда, жетон и исполнитель.
   *
   * Библиотека делает то же самое в своей терминальной записи (clearOwnership в
   * lib/jobs/lifecycle.ts), но при manageTerminalStatus=false итог пишет тело —
   * значит, и осадок владения убирать телу. Иначе закрытая кампания навсегда
   * осталась бы с непустым lease_until, и дежурный запрос «кто держит аренду»
   * показывал бы её работающей.
   */
  const campaignTerminal = (patch: Record<string, unknown>) =>
    campaignUpdate({ ...patch, lease_until: null, run_token: null, worker_id: null });
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
    log('error', `Кампания ${campaignId} не найдена в базе данных${cErr ? ` — ${cErr.message}` : ''}. Возможно, её удалили.`);
    return;
  }

  const tg = campaign.telegram_settings as TelegramSettings;
  const _oai = campaign.openai_settings as OpenAISettings;

  if (!process.env.OPENROUTER_TG_OUTREACH_API_KEY) {
    log('error', 'Не задан ключ OpenRouter (OPENROUTER_TG_OUTREACH_API_KEY в .env) — без него GPT не сможет отвечать. Кампания переведена в статус "ошибка".');
    // Hard config error — leave in error so we don't loop on it forever
    const { error: stErr } = await campaignTerminal({ status: 'error' });
    if (stErr) log('error', `Не смог записать статус "ошибка" в базу данных — ${stErr.message}`);
    return;
  }

  const { data: accounts } = await db
    .from('tg_outreach_accounts')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  if (!accounts?.length) {
    /*
     * Пауза — и она теперь окончательная, до кнопки оператора.
     *
     * Раньше эту кампанию каждые пять минут поднимал авто-резюм: он переводил
     * ВСЕ paused обратно в running и подкладывал команду «старт». Вместе с
     * авто-резюмом ушло и это: механизм воскрешал и те кампании, которые
     * оператор остановил руками, а на второй реплике был просто неверен.
     * Строку с `paused` захват аренды не берёт, поэтому кампания честно ждёт
     * человека — и в интерфейсе у неё есть кнопка «Запустить».
     */
    log('error', 'Нет активных аккаунтов в кампании — поставил на паузу. Включите хотя бы один аккаунт и запустите кампанию снова.');
    const { error: stErr } = await campaignTerminal({ status: 'paused' });
    if (stErr) log('error', `Не смог записать статус "на паузе" в базу данных — ${stErr.message}`);
    return;
  }

  const { data: proxies } = await db
    .from('tg_outreach_proxies')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true);

  // Собственные аккаунты кампании. После прогрева (см. warmup/) у них остаются
  // диалоги друг с другом, и без этого фильтра боевой цикл принял бы свой же
  // аккаунт за лида: сгенерировал бы продающий ответ, сработал бы триггер и
  // переписка ушла бы в рабочий чат как заявка.
  const ownTgUserIds = new Set(
    (accounts as OutreachAccount[])
      .map((a) => a.tg_user_id)
      .filter((v): v is number => typeof v === 'number'),
  );

  /**
   * Порядок обхода — «кого дольше всех не брали, тот первый».
   *
   * До 28.08.2026 круг всегда шёл по порядку выборки, и при падениях воркера
   * (в тот день их было три) хвост списка не работал вовсе: пауза между
   * аккаунтами доходит до десяти минут, процесс успевал обработать два-три и
   * умирал, а следующий начинал с того же начала. У ATOL-1 из двенадцати
   * аккаунтов писали двое, свежая база сутки стояла с нулём отправок.
   *
   * Сортируем здесь, а не в SQL: так поведение покрыто тестами, а выборка выше
   * остаётся простой и её результат по-прежнему годится для остальных нужд
   * (сверка своих tg_user_id, счётчики).
   */
  const cycleOrder = orderByStaleness(accounts as OutreachAccount[]);

  log('info', `Запускаю кампанию "${campaign.name}": ${accounts.length} аккаунтов, ${proxies?.length ?? 0} прокси`);

  // Последняя проверка перед подключением: дальше начинаются живые сессии
  // Telegram, и открывать их, когда работа уже не наша, нельзя.
  if (shouldStop()) return;

  const proxyMap = new Map((proxies ?? []).map((proxy: OutreachProxy) => [proxy.id, proxy]));
  const downloadSessionFile = (storagePath: string) => downloadSessionToTemp(db, storagePath);
  /*
   * Ручка «закрыть все клиенты» ставится ДО подключения, а не после.
   *
   * Подключить дюжину аккаунтов — это минуты, и раньше всё это время ручки не
   * существовало: остановка, пришедшая в это окно, отчитывалась бы «клиенты
   * закрыты» (закрывать было нечего), аренда отпускалась бы, а процесс
   * продолжал бы открывать сессии одну за другой — и сосед подключил бы те же.
   * Массив заводим здесь и отдаём buildClients как приёмник: он заполняется по
   * ходу, поэтому ручка закрывает и то, что успело подключиться. Сигнал внутрь
   * — чтобы после отмены не открывать оставшихся вовсе.
   *
   * Замыкание читает `clients` в момент вызова, поэтому переживает и повторную
   * попытку ниже, и переподключение внутри круга.
   */
  let clients: ActiveClient[] = [];
  if (control) control.forceDisconnect = () => disconnectAll(clients);
  clients = await buildClients(cycleOrder, proxies ?? [], log, downloadSessionFile, db, { sink: clients, signal });
  log('info', `Подключились ${clients.length} из ${accounts.length} аккаунтов${clients.length < accounts.length ? ` (остальные с ошибками подключения, смотри строки выше)` : ''}`);

  if (shouldStop()) return;

  if (clients.length === 0) {
    log('warning', 'Ни один аккаунт не подключился — пробую ещё раз через 60 секунд');
    await interruptibleSleep(60_000, shouldStop, 2000, signal);
    if (shouldStop()) return;
    // Приёмник повторной попытки ставим в `clients` ДО вызова — по той же
    // причине, что и выше: ручка обязана видеть то, что подключается сейчас.
    clients = [];
    const retryClients = await buildClients(accounts, proxies ?? [], log, downloadSessionFile, db, { sink: clients, signal });
    log('info', `Повторная попытка: подключились ${retryClients.length} из ${accounts.length} аккаунтов`);
    if (retryClients.length === 0) {
      log('error', 'Повторная попытка тоже провалилась — кампания на паузе. Проверьте прокси и сессии аккаунтов, затем запустите снова.');
      const { error: stErr } = await campaignTerminal({ status: 'paused' });
      if (stErr) log('error', `Не смог записать статус "на паузе" в базу данных — ${stErr.message}`);
      return;
    }
    clients = retryClients;
  }

  {
    // Под жетоном, как и всё остальное. Строку кампании раннер уже захватил в
    // статусе `running` — эта запись только освежает отметку времени, но без
    // ограждения она воскрешала бы кампанию, которую оператор остановил, пока
    // мы подключали аккаунты.
    const { error: stErr } = await campaignUpdate({ status: 'running', updated_at: new Date().toISOString() });
    if (stErr) log('error', `Не смог записать статус "запущена" в базу данных — ${stErr.message}`);
  }

  /**
   * Ручные передачи лидов и партнёров — отдельным опросом, а не по ходу круга.
   *
   * Все аккаунты подключены с этого момента и до конца запуска, а круг с
   * паузами 5–10 минут между аккаунтами и «тихим часом» ночью доходит до
   * нужного аккаунта часами: 01.09.2026 лид, поставленный в 19:26, ушёл в
   * 08:57. Опрос берёт клиент из `clients` в момент отправки — круг
   * пересоздаёт клиенты на мёртвых сокетах, и нужен свежий.
   *
   * `forwardsStopped` поднимаем в `finally` перед разрывом сокетов: иначе
   * опрос успел бы взять задачу на закрывающемся клиенте.
   */
  let forwardsStopped = false;
  const forwardPoller = runLeadForwardPoller({
    db,
    campaignId,
    getClient: (accountId) => {
      const entry = clients.find((c) => c.account.id === accountId);
      return entry ? { client: entry.client, accountName: entry.account.session_name } : null;
    },
    log,
    shouldStop: () => forwardsStopped || shouldStop(),
  }).catch((err) => {
    log('warning', `Опрос очереди передач остановился с ошибкой — ${err instanceof Error ? err.message : String(err)}. Передачи уйдут после перезапуска кампании.`);
  });

  /*
   * Счётчики поднимаем из чекпойнта, а не с нуля.
   *
   * Все три считают «сколько раз ПОДРЯД», и от этого зависят решения об
   * аккаунте: два пустых круга — сутки паузы, пять сбоев загрузки диалогов —
   * шесть часов. Пока счётчики жили только в памяти, каждый деплой обнулял их,
   * и «подряд» не набиралось: аккаунт с мёртвым резолвом крутился неделю и
   * рассылал ноль (ATOL-1, 02.09.2026), а лечение так и не наступало.
   */
  const cp = runtime?.checkpoint ?? null;
  const toMap = (rec: Record<string, number> | undefined) => new Map(Object.entries(rec ?? {}));
  const fromMap = (map: Map<string, number>) => Object.fromEntries(map);
  let round = cp?.round ?? 0;
  /**
   * С кого НЕ начинать первый круг после перехвата.
   *
   * Обычно порядок и так решает `last_cycle_at` (orderByStaleness): только что
   * отработавший аккаунт оказывается последним. Но отметка пишется отдельным
   * запросом, и он может не пройти — код это прямо допускает («в худшем случае
   * аккаунт возьмут дважды подряд»). Под арендой цена такой осечки выше:
   * перехват заново прогонял бы тот же аккаунт с его паузами. Чекпойнт — второй
   * ключ к тому же замку, и стоит он один раз, на первом круге.
   */
  let resumeAfterAccountId = cp?.lastAccountId ?? null;

  const offsetErrorCounts = toMap(cp?.offsetErrorCounts);
  // Separate counter for the gramJS internal pagination bug — `getDialogs`
  // throws RangeError ("offset out of range") on accounts with thousands of
  // dialogs. Production data shows the inner retry with smaller limit never
  // succeeds (1:1 ratio of retry attempts to outer-catch failures over 7d),
  // so we no longer retry. Instead we track consecutive failures per account
  // and put chronic offenders on a 6h cooldown so the operator can act.
  const pagingFailureCounts = toMap(cp?.pagingFailureCounts);

  /**
   * Сколько кругов подряд аккаунт не резолвнул ни одного ника из порции.
   *
   * Заморозка Telegram глушит аккаунту резолв юзернеймов и при этом не
   * называется никак: в ошибке приходит обычное «юзернейм не найден», @SpamBot
   * молчит (он отвечает только про спам-блок), в профиле флага нет. Отличить
   * такой аккаунт от невезения с мёртвыми никами можно только по истории — на
   * одной порции это неразличимо, поэтому счётчик живёт здесь, в круге.
   *
   * 02.09.2026 в ATOL-1 таких аккаунтов было пятнадцать из одной партии: за
   * неделю ноль отправленных первых касаний при 205 отложенных, тогда как
   * остальные восемнадцать рассылали с той же очереди.
   */
  const resolveBlockedRounds = toMap(cp?.resolveBlockedRounds);

  /**
   * Контакты, уже разобранные кем-то в текущем проходе по аккаунтам.
   *
   * Порция первого касания добирается до нормы, а неудачный контакт остаётся
   * `pending`. Без общей отметки следующий аккаунт того же прохода взял бы
   * ровно те же ники — и повторил бы ту же работу, только с другого номера.
   * Набор обнуляется на каждом новом проходе: через сутки контакт стоит
   * попробовать снова, но не через десять минут.
   */
  let claimedContacts = new Set<string>();
  /** После скольких пустых кругов подряд уводим аккаунт на паузу. */
  const RESOLVE_BLOCKED_LIMIT = 2;
  // Stays true while we're inside a sleep_periods window so we can emit a
  // matching "сон закончился" line when it ends (otherwise users see only
  // the start of the silence and can't tell when work resumed).
  let inSleepPeriod = false;

  try {
    while (!shouldStop()) {
      tick();
      try { fs.writeFileSync('/tmp/tg-outreach-heartbeat', Date.now().toString()); } catch { /* */ }

      if (isInSleepPeriod(tg.sleep_periods, tg.timezone_offset)) {
        if (!inSleepPeriod) {
          log('info', 'Тихий час начался — пауза по расписанию. Буду проверять каждые 60 секунд, не пора ли возобновлять.');
          inSleepPeriod = true;
        }
        await interruptibleSleep(60_000, shouldStop, 2000, signal);
        continue;
      } else if (inSleepPeriod) {
        log('info', 'Тихий час закончился — возобновляю рассылку.');
        inSleepPeriod = false;
      }

      let blockedUserIds: Set<number>;
      try {
        blockedUserIds = await loadBlockedUserIds(db, campaign.user_id);
        log('info', `Загрузил глобальный чёрный список: ${blockedUserIds.size} пользователей будут пропущены`);
      } catch (err) {
        log('warning', `Не смог загрузить глобальный чёрный список — буду работать без него: ${err instanceof Error ? err.message : String(err)}`);
        blockedUserIds = new Set();
      }

      let tlSchemaErrorCount = 0;
      claimedContacts = new Set<string>();
      round += 1;

      /*
       * Первый круг после перехвата начинаем со следующего аккаунта.
       *
       * Порядок при этом не ломается: список тот же, просто прокручен так,
       * чтобы уже отработавший аккаунт оказался в конце. Обойдём мы всех — но
       * не заплатим второй раз паузой того, кто только что отработал.
       */
      let roundClients = clients;
      if (resumeAfterAccountId) {
        const at = clients.findIndex((c) => c.account.id === resumeAfterAccountId);
        if (at >= 0 && at + 1 < clients.length) {
          roundClients = [...clients.slice(at + 1), ...clients.slice(0, at + 1)];
          log('info', `Продолжаю круг ${round} со следующего аккаунта после ${clients[at]!.account.session_name} — его уже отработал прошлый исполнитель.`);
        }
        resumeAfterAccountId = null;
      }
      log('info', `Начинаю обход ${roundClients.length} аккаунтов (круг ${round})`);

      for (const entry of roundClients) {
        const { account } = entry;
        // `let`, not destructured const: if getDialogs wedges we rebuild the
        // client mid-iteration and must point every downstream call (handleChat,
        // follow-up, session save) at the fresh client, not the dead one.
        let client = entry.client;
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

        // Per-account cycle stats — emitted as a single summary line at the
        // end so per-dialog reasons stay aggregated and don't drown the UI.
        const cycleStats = {
          dialogs_total: 0,
          unread: 0,
          not_user: 0,
          own_account: 0,
          processed: 0,
          replied: 0,
          flood: 0,
          errors: 0,
        };
        const accountStartMs = Date.now();
        // Snapshot the gramJS unknown-constructor buffer so that, if this
        // account fails to decode its dialogs below, we can attribute exactly
        // which TL constructor(s) gramJS choked on during THIS account's calls.
        const tlWarnMark = gramjsUnknownTlBuf().length;

        try {
          // Load dialogs, racing each attempt against a hard per-account
          // timeout. We don't abort the gramJS call (Promise.race leaves it
          // dangling), but the worker moves on — what matters for the watchdog.
          //
          // `archived: false` (inside loadOutreachDialogs) skips dialogs moved
          // to Archive — we never message archived contacts anyway, and a
          // smaller result set reduces the chance gramJS's internal pagination
          // overshoots the dialog count (the "offset out of range" bug, also
          // handled there via a raw single-page GetDialogs fallback).
          const raceGetDialogs = () => {
            // Always read entry.client: after a mid-iteration reconnect the
            // retry must hit the fresh client, not the wedged one.
            const loadDialogsPromise = loadOutreachDialogs(entry.client, DIALOGS_FETCH_LIMIT);
            // If the timeout wins, this promise is left dangling on the (about
            // to be replaced) client; gramJS rejects it on disconnect — swallow
            // that late rejection so it can't surface as an unhandledRejection
            // and crash the worker.
            loadDialogsPromise.catch(() => {});
            return Promise.race([
              loadDialogsPromise,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        `${PER_ACCOUNT_TIMEOUT_MARKER} (${PER_ACCOUNT_FIRST_CALL_TIMEOUT_MS / 1000}s) on getDialogs`,
                      ),
                    ),
                  PER_ACCOUNT_FIRST_CALL_TIMEOUT_MS,
                ),
              ),
            ]);
          };

          let dialogs: helpers.TotalList<Dialog>;
          let usedRawPageFallback: boolean;
          try {
            ({ dialogs, usedRawPageFallback } = await raceGetDialogs());
          } catch (firstErr) {
            const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
            // Only the wedged-socket timeout gets the reconnect-and-retry-now
            // treatment. Every other error (AUTH_KEY_*, USER_DEACTIVATED,
            // Constructor ID, offset out of range, …) keeps its existing
            // dedicated handling in the outer catch below — a fresh socket
            // wouldn't fix those.
            if (!firstMsg.includes(PER_ACCOUNT_TIMEOUT_MARKER)) throw firstErr;

            // The long-lived gramJS socket went half-open through the proxy
            // (recvLoop waits forever; the proxy itself is healthy). Don't wait
            // for the next round — rebuild on a fresh socket and retry getDialogs
            // immediately, in this same round.
            const proxyProbeLog = await probeAccountProxyForLog(account, proxyMap);
            const proxy = account.proxy_id ? proxyMap.get(account.proxy_id) ?? null : null;
            const acctRef = `acc_id=${account.id}${account.phone ? ` тел=${account.phone}` : ''}${account.proxy_id ? ` proxy_id=${account.proxy_id}` : ''}`;
            const firstHangSec = ((Date.now() - accountStartMs) / 1000).toFixed(1);

            // Прокси-инцидент №1: getDialogs завис на «мёртвом сокете».
            // Регистрируем ошибку прокси и при необходимости свапаем — даже
            // если reconnect ниже потом всё-таки помог. Один и тот же прокси
            // не должен бесконечно сжигать наш 180с-таймаут на каждом круге.
            await handleProxyError({ db, account, reason: 'getDialogs_hung', log });

            const reconnectStartMs = Date.now();
            try {
              entry.client = await reconnectClient(account, proxy, entry.client, downloadSessionFile);
              client = entry.client;
            } catch (reErr) {
              const reMsg = reErr instanceof Error ? reErr.message : String(reErr);
              const reSec = ((Date.now() - reconnectStartMs) / 1000).toFixed(1);
              // Прокси-инцидент №2: reconnect через тот же прокси тоже упал.
              await handleProxyError({ db, account, reason: 'reconnect_failed', log });
              throw new Error(
                `${PER_ACCOUNT_RECONNECT_FAILED_MARKER}: загрузка диалогов зависла на первой попытке (${firstHangSec}с, мёртвый сокет), ` +
                  `и переподключение на свежую сессию НЕ удалось за ${reSec}с — ${reMsg}. ${proxyProbeLog}. ${acctRef}`,
              );
            }

            const reconnectSec = ((Date.now() - reconnectStartMs) / 1000).toFixed(1);
            log(
              'warning',
              `Аккаунт ${account.session_name}: загрузка диалогов зависла (${firstHangSec}с, мёртвый сокет) — ` +
                `переподключил на свежее соединение за ${reconnectSec}с, повторяю загрузку сразу в этом же круге. ${proxyProbeLog}.`,
            );

            const retryStartMs = Date.now();
            try {
              ({ dialogs, usedRawPageFallback } = await raceGetDialogs());
            } catch (secondErr) {
              const secMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
              const retrySec = ((Date.now() - retryStartMs) / 1000).toFixed(1);
              // Non-timeout failures after reconnect (AUTH_KEY_*, offset, …)
              // route to their proper outer-catch branch instead of the generic
              // "reconnect failed" line.
              if (!secMsg.includes(PER_ACCOUNT_TIMEOUT_MARKER)) throw secondErr;
              // Still wedged on a brand-new socket — genuinely abnormal. Loud,
              // fully-attributed error, then skip the account this round.
              // Прокси-инцидент №3: даже после reconnect зависание — прокси
              // явно режет MTProto. Свапаем, чтобы следующий круг попробовал
              // на свежем IP.
              await handleProxyError({ db, account, reason: 'reconnect_failed', log });
              throw new Error(
                `${PER_ACCOUNT_RECONNECT_FAILED_MARKER}: загрузка диалогов зависла на первой попытке (${firstHangSec}с), ` +
                  `переподключение прошло за ${reconnectSec}с, но повторная загрузка на свежем сокете ТОЖЕ зависла (${retrySec}с). ` +
                  `Похоже на проблему не с сокетом (битая сессия / теневой бан аккаунта / прокси режет MTProto). ${proxyProbeLog}. ${acctRef}`,
              );
            }
            log(
              'info',
              `Аккаунт ${account.session_name}: повторная загрузка после переподключения удалась за ${((Date.now() - retryStartMs) / 1000).toFixed(1)}с.`,
            );
          }
          // Successful fetch — reset the chronic paging failure counter.
          if (pagingFailureCounts.has(account.id)) pagingFailureCounts.delete(account.id);
          // Также сбрасываем per-proxy и per-account счётчики ошибок:
          // прокси прошёл круг — значит он жив, аккаунт прошёл круг — значит
          // сессия валидна. Cooldown не снимаем (если он стоит — значит мы
          // уже за окном). degraded флаг тоже не снимаем — это всегда ручная
          // операция оператора (см. proxyHealth.ts).
          if (account.proxy_id) {
            void recordProxySuccess(db, account.proxy_id).catch((e) => {
              log('info', `Не смог записать proxy success в БД: ${e instanceof Error ? e.message : String(e)}`);
            });
          }
          const accountSuccessWrite = recordAccountSuccess(db, account.id).catch((e) => {
            log('info', `Не смог записать account success в БД: ${e instanceof Error ? e.message : String(e)}`);
          });

          /**
           * Проверка, заказанная оператором на работающей кампании.
           *
           * Кнопка «Проверить» в интерфейсе к Telegram не подключается: сессию
           * держим мы, и второе подключение к ней — это AUTH_KEY_DUPLICATED и
           * выключенный аккаунт. Поэтому нажатие только ставит отметку
           * `check_requested_at`, а выполняем проверку здесь — соединением,
           * которое уже открыто и только что доказало свою работоспособность.
           *
           * Главное, что она приносит сверх «жив»: список чужих сеансов. Именно
           * по нему августовское расследование отличает «нас разлогинили» от
           * «номер забанили», и добыть его иначе, не останавливая рассылку,
           * нельзя.
           *
           * Сбой проверки круг не рушит: аккаунт уже отработал, а проверка —
           * это рассказ о нём, а не сама работа.
           */
          if (account.check_requested_at) {
            const who = account.check_requested_by_name || 'оператор';
            try {
              const checkResult = await checkAccount(client, {
                // Спам-блок в профиле не виден — его подтверждает только
                // @SpamBot. Спрашиваем лишь у тех, кто уже помечен ограниченным
                // (обычно после PEER_FLOOD на рассылке).
                askSpamBotWhenRestricted: account.check_status === 'restricted',
              });
              // Ждём общей отметки об успехе круга: она пишет в те же поля, и
              // приземлившись позже, затёрла бы итог проверки своим общим
              // текстом и потеряла бы чужие сеансы.
              await accountSuccessWrite;
              const { error: saveErr } = await db
                .from('tg_outreach_accounts')
                .update({
                  check_status: checkResult.status,
                  check_detail: checkResult.detail.slice(0, 500),
                  checked_at: new Date().toISOString(),
                  other_sessions: checkResult.other_sessions ?? [],
                  check_requested_at: null,
                  check_requested_by_name: null,
                  ...(checkResult.tg_user_id != null ? { tg_user_id: checkResult.tg_user_id } : {}),
                  ...(checkResult.tg_username != null ? { tg_username: checkResult.tg_username } : {}),
                  ...(checkResult.phone ? { phone: checkResult.phone } : {}),
                })
                .eq('id', account.id);
              if (saveErr) {
                log('warning', `Аккаунт ${account.session_name}: проверка прошла, но результат не записался — ${saveErr.message}`);
              } else {
                const others = checkResult.other_sessions?.length ?? 0;
                log(
                  'info',
                  `Аккаунт ${account.session_name}: проверка по заказу (${who}) выполнена на ходу — ${checkResult.detail}`
                  + (others ? `, чужих сеансов: ${others}` : ''),
                );
              }
            } catch (checkErr) {
              const msg = checkErr instanceof Error ? checkErr.message : String(checkErr);
              // Заказ не гасим: проверка не состоялась, и снимать её значило бы
              // сделать вид, что оператору ответили.
              log('warning', `Аккаунт ${account.session_name}: проверка по заказу (${who}) не удалась — ${msg}. Заказ остался в очереди, повторим в следующем круге.`);
            }
          }
          if (usedRawPageFallback) {
            log(
              'warning',
              `Аккаунт ${account.session_name}: штатная пагинация GramJS упала с offset out of range — загрузил первый page диалогов через прямой GetDialogs без внутренней пагинации`,
            );
          }
          cycleStats.dialogs_total = dialogs.length;
          cycleStats.unread = dialogs.filter(d => d.unreadCount > 0).length;
          log(
            'info',
            `Аккаунт ${account.session_name}: загрузил ${dialogs.length} диалогов, из них ${cycleStats.unread} с непрочитанными`,
          );

          for (const dialog of dialogs) {
            if (shouldStop()) break;
            /*
             * Отметка прогресса на КАЖДОМ диалоге, а не только на аккаунте.
             *
             * Разбор одного непрочитанного — это пауза «чтения», вызов модели и
             * отправка ответа; на аккаунте с полусотней непрочитанных всё это
             * складывается в десятки минут, внутри которых раньше не было ни
             * одной отметки. Порог простоя (25 минут) считал бы такую работу
             * зависанием и передавал бы кампанию соседу посреди переписки —
             * причём цена ошибки теперь выше, чем у прежнего сторожа: это
             * полный перезахват с переподключением всех сессий.
             */
            tick();
            if (dialog.unreadCount === 0) continue;
            if (!dialog.entity || !(dialog.entity instanceof Api.User)) {
              cycleStats.not_user++;
              continue;
            }
            if (ownTgUserIds.has(Number(dialog.entity.id))) {
              cycleStats.own_account++;
              continue;
            }

            try {
              const r = await handleChat(client, account, dialog, campaign as OutreachCampaign, db, log, shouldStop, { blockedUserIds });
              cycleStats.processed++;
              if (r.replied) cycleStats.replied++;
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              // Reconstruct a stable display label for the error log so the
              // operator can search by ID/@username without scrolling.
              const dialogId = dialog.entity instanceof Api.User ? Number(dialog.entity.id) : null;
              const dialogLabel = dialog.entity instanceof Api.User && dialog.entity.username
                ? `@${dialog.entity.username}`
                : dialogId != null ? `ID:${dialogId}` : 'unknown';

              if (
                errMsg.includes('PeerFloodError') ||
                errMsg.includes('FloodWaitError') ||
                errMsg.includes('FrozenMethodInvalidError') ||
                errMsg.includes('FROZEN_METHOD_INVALID')
              ) {
                // Срок паузы спрашиваем у @SpamBot этим же соединением: пауза
                // из настроек ставилась вслепую и каждые сутки выпускала
                // аккаунт ровно в то же ограничение.
                const parked = await parkAccountAfterLimit({
                  db,
                  client,
                  account,
                  hours: tg.account_cooldown_hours,
                  reason: 'FloodError/Frozen',
                  rawError: errMsg,
                  log,
                });
                if (parked.parked) {
                  const cooldownDisplay = new Date(parked.untilIso).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                  log('warning', `Аккаунт ${account.session_name}: Telegram ограничил отправку (FloodError/Frozen на диалоге ${dialogLabel}). ${parked.diagnosis} Аккаунт на паузе до ${cooldownDisplay}.`);
                }
                cycleStats.flood++;
                break;
              }

              // Permanently unreachable peer: user deleted account, blocked
              // us, or the peer reference is stale. Each cycle we'd otherwise
              // burn another GPT call and another SendMessage. The helper
              // flips can_send=false so canSendToDialog() short-circuits
              // future rounds.
              const unreachable = await disableDialogIfUnreachable(errMsg, {
                db,
                campaignId: campaign.id,
                accountId: account.id,
                tgUserId: dialogId,
                dialogLabel,
                log,
              });
              if (unreachable) {
                cycleStats.errors++;
                continue;
              }

              cycleStats.errors++;
              log('error', `Аккаунт ${account.session_name}, диалог ${dialogLabel}: не смог обработать — ${errMsg}`);
            }
          }

          // Каждый из трёх проходов ниже сам по себе идёт минутами (у каждого
          // свои паузы между сообщениями), поэтому отмечаемся после каждого:
          // молчание длиной в порог простоя не должно набегать из честной
          // работы.
          await handleFollowUp(client, account, campaign as unknown as OutreachCampaign, db, log, shouldStop);
          tick();
          await handleMissedRepliesLastDays(client, account, campaign as unknown as OutreachCampaign, db, log, shouldStop);
          tick();

          try {
            await backfillEmptyDialogs(client, account, campaign as unknown as OutreachCampaign, db, log);
            tick();
          } catch (err) {
            log('warning', `Аккаунт ${account.session_name}: ошибка при загрузке истории пустых диалогов (backfill) — ${err instanceof Error ? err.message : String(err)}`);
          }

          const updatedSession = await getUpdatedSessionString(client);
          if (updatedSession && updatedSession !== account.session_data) {
            const { error: sErr } = await db.from('tg_outreach_accounts').update({ session_data: updatedSession }).eq('id', account.id);
            if (sErr) {
              log('warning', `Аккаунт ${account.session_name}: не смог сохранить обновлённую сессию в базе данных — ${sErr.message}. На следующем запуске придётся залогиниваться заново.`);
            }
          }

          // Single-line per-account summary at the end of the cycle.
          const elapsedMs = Date.now() - accountStartMs;
          log(
            'info',
            `Аккаунт ${account.session_name}: круг завершён за ${(elapsedMs / 1000).toFixed(1)}с. ` +
              `Обработано ${cycleStats.processed} непрочитанных из ${cycleStats.unread}, отправлено ${cycleStats.replied} ответов. ` +
              `Пропуски: групп/каналов ${cycleStats.not_user}, ошибок ${cycleStats.errors}` +
              (cycleStats.own_account ? `, своих аккаунтов кампании ${cycleStats.own_account}` : '') +
              (cycleStats.flood ? `, паузы из-за Flood ${cycleStats.flood}` : '') +
              '.',
          );

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);

          // Диагноз аккаунта — в его карточку, а не только в ленту лога.
          //
          // Колонки check_status/check_detail и агрегатор в интерфейсе уже были,
          // но заполняла их ТОЛЬКО ручная кнопка «проверить» по одному аккаунту.
          // 19.08.2026 на проде 17 аккаунтов не работали (14 с отозванной
          // сессией, 3 с конфликтом), и все они показывались оператору живыми:
          // 96 аккаунтов из 178 не проверялись ни разу, у остальных проверка
          // была двухдневной давности. Боевой цикл упирается в мёртвую сессию
          // каждый круг — ему и писать диагноз.
          //
          // Пишем только терминальные состояния: сетевые и флуд-ошибки
          // проходят сами и карточку засорять не должны.
          const diagnosis = classifyCheckError(errMsg);
          /**
           * `restricted` пишем наравне с терминальными: спам-блок и флуд-вейт
           * проходят сами, но пока они держатся, аккаунт не рассылает — и
           * оператор должен видеть в карточке, что это временно и до какого
           * момента, а не гадать по пустому кулдауну.
           */
          if (diagnosis.status === 'session_revoked'
            || diagnosis.status === 'session_duplicate'
            || diagnosis.status === 'banned'
            || diagnosis.status === 'restricted') {
            const { error: diagErr } = await db
              .from('tg_outreach_accounts')
              .update({
                check_status: diagnosis.status,
                check_detail: diagnosis.detail,
                checked_at: new Date().toISOString(),
              })
              .eq('id', account.id);
            if (diagErr) {
              log('warning', `Аккаунт ${account.session_name}: не смог записать диагноз «${diagnosis.detail}» в карточку — ${diagErr.message}`);
            }
          }

          if (errMsg.includes('Constructor ID')) {
            tlSchemaErrorCount++;
            // Log every occurrence (not only the first) so the operator sees
            // how widespread the TL-schema mismatch is. The aggregate backoff
            // below still kicks in only when every account is affected.
            log('warning', `Аккаунт ${account.session_name}: устаревшая библиотека Telegram (несовпадение протокола, попытка #${tlSchemaErrorCount}). Нужно обновить пакет 'telegram' командой 'npm update telegram' и пересобрать воркер. Детали: ${errMsg.slice(0, 150)}`);
          } else if (errMsg.includes('AUTH_KEY_UNREGISTERED') || errMsg.includes('USER_DEACTIVATED')) {
            const isUnreg = errMsg.includes('AUTH_KEY_UNREGISTERED');
            const reasonCode = isUnreg ? 'AUTH_KEY_UNREGISTERED' : 'USER_DEACTIVATED';
            // «Забанил» — слово с двумя очень разными смыслами, и здесь имеется
            // в виду именно окончательный: USER_DEACTIVATED номер не вернёт.
            // Проговариваем это прямо, иначе строка неотличима от временного
            // спам-блока, после которого аккаунт оживает сам.
            const friendly = isUnreg
              ? `Telegram больше не признаёт эту сессию (после смены пароля или ручного выхода) — это не бан, аккаунт цел`
              : `ПОСТОЯННЫЙ бан: Telegram забанил этот номер окончательно`;
            const { error: deactErr } = await db
              .from('tg_outreach_accounts')
              .update({ is_active: false, cooldown_until: null })
              .eq('id', account.id);
            if (deactErr) {
              log('error', `Аккаунт ${account.session_name}: ${friendly} (${reasonCode}), но НЕ смог выключить аккаунт в базе данных — ${deactErr.message}. Аккаунт продолжит пытаться подключиться и сыпать ошибки.`);
            } else {
              log('warning', `Аккаунт ${account.session_name}: ${friendly} (${reasonCode}) — аккаунт выключен автоматически. ${isUnreg ? 'Перевыпустите session_data и загрузите заново.' : 'Для возобновления потребуется новый номер.'}`);
            }
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
              const { error: dErr } = await db
                .from('tg_outreach_accounts')
                .update({ is_active: false, cooldown_until: null })
                .eq('id', account.id);
              if (dErr) {
                log('error', `Аккаунт ${account.session_name}: повреждён .session-файл (попытка ${count}), но НЕ смог выключить аккаунт в базе данных — ${dErr.message}`);
              } else {
                log('warning', `Аккаунт ${account.session_name}: повреждён .session-файл (ошибка чтения, попытка ${count} подряд). Аккаунт выключен — пересоздайте .session-файл и загрузите заново.`);
              }
            } else {
              const cooldownUntil = new Date(Date.now() + 3600_000).toISOString();
              const { error: cdErr } = await db.from('tg_outreach_accounts').update({ cooldown_until: cooldownUntil }).eq('id', account.id);
              if (cdErr) {
                log('error', `Аккаунт ${account.session_name}: не смог сохранить часовую паузу в базе данных — ${cdErr.message}`);
              }
              (account as OutreachAccount).cooldown_until = cooldownUntil;
              log('warning', `Аккаунт ${account.session_name}: ошибка чтения .session-файла (попытка ${count}). Пауза 1 час. Если повторится — аккаунт будет выключен.`);
            }
          } else if (errMsg.includes(PER_ACCOUNT_RECONNECT_FAILED_MARKER)) {
            // Terminal path: getDialogs wedged, we rebuilt the client on a fresh
            // socket and retried in the same round, and the retry still failed
            // (see the fully-attributed message built at the throw site). This is
            // no longer a transient stale-socket glitch, so we surface it as a
            // real error with maximum context and skip the account this round.
            // The watchdog at 15 min still backstops the rest of the iteration.
            cycleStats.errors++;
            log(
              'error',
              `Аккаунт ${account.session_name}: ${errMsg} Пропускаю аккаунт в этом круге, попробую снова на следующем.`,
            );
          } else if (
            // "offset out of range" while loading dialogs. The session-
            // corruption branch above deliberately EXCLUDES decoder stacks
            // (BinaryReader/tgReadObject/MTProtoState), so what lands here is a
            // TL-DESERIALIZATION failure, not a pagination overshoot: even our
            // raw single-page GetDialogs fallback (no pagination) hits it. The
            // real cause is a TL constructor newer than gramJS 2.26.22 — see the
            // captured ids below — so dump maximum context to diagnose it.
            errMsg.includes('offset') && errMsg.includes('out of range')
          ) {
            // Real error text + a short stack so we can confirm the decode site
            // (tgReadObject/BinaryReader) instead of guessing "pagination".
            const errStack = err instanceof Error && err.stack
              ? err.stack.split('\n').slice(0, 6).map(s => s.trim()).join(' ⟶ ')
              : '(стек недоступен)';
            // Constructor ids gramJS skipped during THIS account's dialog load
            // (teed from the gramjs-patch console.warn). This is the smoking gun:
            // it names exactly what Telegram added that we can't decode yet.
            const newTlWarns = gramjsUnknownTlBuf().slice(tlWarnMark);
            const tlIdsNote = newTlWarns.length
              ? ` Незнакомые TL-конструкторы за эту попытку (${newTlWarns.length}): ` +
                newTlWarns.map(w => w.msg.replace('[gramjs-patch] ', '').replace(/, skipping.*$/, '')).join(' | ') + '.'
              : ' Незнакомых TL-конструкторов за эту попытку не зафиксировано (см. stdout воркера на предмет [gramjs-patch]).';
            const diag = `Реальная ошибка: "${errMsg}".${tlIdsNote} Стек: ${errStack}`;

            const count = (pagingFailureCounts.get(account.id) ?? 0) + 1;
            pagingFailureCounts.set(account.id, count);
            // After many consecutive failures the account is effectively
            // disabled — sit it out for 6h so operators can diagnose.
            const PAGING_FAILURE_COOLDOWN_THRESHOLD = 5;
            if (count >= PAGING_FAILURE_COOLDOWN_THRESHOLD) {
              const cooldownMs = 6 * 3600 * 1000;
              const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
              const cooldownDisplay = new Date(cooldownUntil).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
              const { error: cdErr } = await db.from('tg_outreach_accounts').update({ cooldown_until: cooldownUntil }).eq('id', account.id);
              if (cdErr) {
                log('error', `Аккаунт ${account.session_name}: не смог сохранить 6-часовую паузу в базе данных — ${cdErr.message}`);
              } else {
                (account as OutreachAccount).cooldown_until = cooldownUntil;
              }
              log(
                'error',
                `Аккаунт ${account.session_name}: ${count} подряд сбоев загрузки диалогов (gramJS не смог декодировать ответ GetDialogs — НЕ пагинация). Пауза 6ч до ${cooldownDisplay}. ${diag}`,
              );
              pagingFailureCounts.delete(account.id);
            } else {
              log(
                'warning',
                `Аккаунт ${account.session_name}: сбой загрузки диалогов — gramJS не смог декодировать ответ GetDialogs (попытка ${count}/${PAGING_FAILURE_COOLDOWN_THRESHOLD}), пропускаю круг. ${diag}`,
              );
            }
          } else if (errMsg.includes('TIMEOUT') || errMsg.includes('Constructor ID')) {
            // Transient MTProto/network issue — log but do not punish account
            log('warning', `Аккаунт ${account.session_name}: разовый сбой сети или Telegram — пропускаю этот круг. Детали: ${errMsg.slice(0, 150)}`);
          } else {
            log('error', `Аккаунт ${account.session_name}: непредвиденная ошибка — ${errMsg}`);
          }
        }

        // Ручные передачи лидов здесь больше не разбираем — их шлёт отдельный
        // опрос очереди (см. runLeadForwardPoller выше), не дожидаясь круга.

        // Первое касание — после разбора входящих и только этим же аккаунтом:
        // отвечать на ответ обязан тот, кто написал первым.
        try {
          const ft = await sendFirstTouchBatch({
            db,
            client,
            campaignId,
            account,
            perDay: tg.first_touch_per_account_per_day,
            maxChars: tg.first_touch_max_chars,
            cooldownHours: tg.account_cooldown_hours,
            log,
            shouldStop,
            onProgress: tick,
            gapMs: randomRange(tg.read_reply_delay_range) * 1000,
            claimed: claimedContacts,
          });
          if (ft.sent || ft.skipped || ft.postponed) {
            log(
              'info',
              `Аккаунт ${account.session_name}: первое касание — отправлено ${ft.sent}, пропущено ${ft.skipped}, отложено ${ft.postponed}`,
            );
          }

          // Ушедшее сообщение доказывает, что резолв у аккаунта работает —
          // счётчик пустых кругов обнуляем.
          if (ft.sent > 0) resolveBlockedRounds.delete(account.id);
          else if (ft.resolveBlocked) {
            const blanks = (resolveBlockedRounds.get(account.id) ?? 0) + 1;
            resolveBlockedRounds.set(account.id, blanks);
            if (blanks >= RESOLVE_BLOCKED_LIMIT) {
              const detail =
                `ВРЕМЕННОЕ ограничение — аккаунт не резолвит юзернеймы: ${blanks} круга подряд ` +
                'ни один ник из порции не нашёлся, при том что другие аккаунты кампании с той же ' +
                'очереди рассылают. Так выглядит заморозка Telegram: @SpamBot про неё не отвечает, ' +
                'кода ошибки нет. Проверьте аккаунт в официальном приложении — при заморозке там ' +
                'висит баннер с кнопкой обжалования.';
              const parked = await parkAccountAfterLimit({
                db,
                account,
                hours: tg.account_cooldown_hours,
                reason: 'резолв юзернеймов не работает',
                log,
                // Бота не спрашиваем: он уже отвечал «ограничений нет» на
                // каждом из этих кругов — про заморозку он не знает.
                client: null,
                inferred: { status: 'restricted', detail },
              });
              resolveBlockedRounds.delete(account.id);
              if (parked.parked) {
                log(
                  'warning',
                  `Аккаунт ${account.session_name}: ${detail} Аккаунт на паузе до ` +
                    `${new Date(parked.untilIso).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}, ` +
                    'контакты остаются в очереди нетронутыми.',
                );
              }
            }
          }
        } catch (err) {
          // Первое касание не должно ронять круг: аутрич по существующим
          // диалогам важнее и уже отработал выше.
          log(
            'warning',
            `Аккаунт ${account.session_name}: первое касание не отработало — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        tick();

        /**
         * Отмечаем, что до аккаунта дошли. Это и есть позиция в круге: после
         * перезапуска воркер начнёт со следующего, а не с начала списка.
         *
         * Пишем ПОСЛЕ работы, а не до: аккаунт, на котором процесс умер, должен
         * считаться необработанным и достаться следующему запуску первым.
         * Ошибку записи глотаем в лог — из-за неудачной пометки рушить круг
         * нельзя, в худшем случае аккаунт возьмут дважды подряд.
         */
        const { error: cycleErr } = await db
          .from('tg_outreach_accounts')
          .update({ last_cycle_at: new Date().toISOString() })
          .eq('id', account.id);
        if (cycleErr) {
          log('warning', `Аккаунт ${account.session_name}: не смог отметить прохождение круга — ${cycleErr.message}. Порядок обхода может сбиться.`);
        }

        /*
         * Чекпойнт — здесь же, в единственном месте, где известно всё сразу:
         * аккаунт отработан целиком, счётчики за него уже обновлены.
         *
         * `false` означает не «не записалось», а «строка больше не наша»:
         * библиотека к этому моменту уже взвела ctx.signal, и продолжать круг
         * — значит писать в Telegram за чужой счёт. Выходим сразу, не дожидаясь
         * паузы.
         */
        if (runtime?.saveCheckpoint) {
          const kept = await runtime.saveCheckpoint({
            round,
            lastAccountId: account.id,
            resolveBlockedRounds: fromMap(resolveBlockedRounds),
            pagingFailureCounts: fromMap(pagingFailureCounts),
            offsetErrorCounts: fromMap(offsetErrorCounts),
          });
          if (!kept) {
            log('warning', 'Кампанию перехватил другой исполнитель — выхожу из круга.');
            break;
          }
        }

        const accountDelay = randomRange(tg.account_loop_delay_range) * 1000;
        log('info', `Пауза ${Math.round(accountDelay / 1000)} секунд перед переходом к следующему аккаунту (анти-флуд)`);
        await interruptibleSleep(accountDelay, shouldStop, 2000, signal);
        tick();
      }

      if (tlSchemaErrorCount > 0 && tlSchemaErrorCount >= clients.length) {
        const tlBackoff = 300_000;
        log('warning', `Все ${tlSchemaErrorCount} аккаунтов получили ошибку устаревшего протокола Telegram. Делаю большую паузу ${tlBackoff / 1000} секунд. Чтобы починить — обновите пакет 'telegram' командой 'npm update telegram' и пересоберите воркер.`);
        await interruptibleSleep(tlBackoff, shouldStop, 2000, signal);
      }

      // cycle_delay_range появилось в TelegramSettings (миграция
      // 20260603_0001). Для кампаний, созданных до миграции, поле может
      // отсутствовать — fallback на 5-10 мин из дефолтов.
      const cycleDelayRange: [number, number] = Array.isArray(tg.cycle_delay_range)
        && tg.cycle_delay_range.length === 2
        ? tg.cycle_delay_range
        : [300, 600];
      const cycleDelay = randomRange(cycleDelayRange) * 1000;
      log('info', `Круг по всем аккаунтам завершён. Пауза ${Math.round(cycleDelay / 1000)} секунд перед следующим кругом (рандом ${cycleDelayRange[0]}-${cycleDelayRange[1]}с).`);
      await interruptibleSleep(cycleDelay, shouldStop, 2000, signal);

      const { data: fresh, error: freshErr } = await db
        .from('tg_outreach_campaigns')
        .select('status')
        .eq('id', campaignId)
        .single();
      if (freshErr) {
        log('warning', `Не смог перечитать статус кампании из базы данных — ${freshErr.message}. Продолжаю работу с текущим статусом.`);
      } else if (fresh?.status === 'stopped' || fresh?.status === 'paused') {
        const friendlyStatus = fresh.status === 'stopped' ? 'остановлена' : 'на паузе';
        log('info', `Статус кампании сменился на "${friendlyStatus}" — выхожу из цикла.`);
        break;
      }
    }
  } finally {
    forwardsStopped = true;
    await disconnectAll(clients);
    // Опрос выходит сам по флагу выше, не позже чем через секунду; зависшая
    // отправка ограничена своим таймаутом. Дождаться его надо: иначе он
    // допишет статус задачи уже после строки «Кампания остановлена».
    await forwardPoller;
    /*
     * Итог пишем только тогда, когда вышли САМИ (кончилась работа, статус
     * сменили снаружи, кампанию доиграли).
     *
     * Остановка процесса или потеря аренды — не итог кампании: строка либо
     * уже не наша, либо отдаётся соседу, и решение о ней принимает он.
     * Написать здесь «остановлена» значило бы погасить кампанию деплоем —
     * ровно тем, от чего переезд на аренду и избавляет.
     *
     * `neq('status','paused')` на месте: цикл мог сам поставить паузу выше
     * (нет аккаунтов, никто не подключился), и затирать её нельзя.
     */
    if (!shouldStop()) {
      const { error: stErr } = await campaignTerminal({ status: 'stopped', updated_at: new Date().toISOString() })
        .neq('status', 'paused');
      if (stErr) {
        log('error', `Не смог пометить кампанию как "остановлена" в базе данных при завершении — ${stErr.message}`);
      }
    } else {
      log('info', 'Останавливаюсь — статус кампании не трогаю: её продолжит следующий владелец аренды.');
    }
    log('info', 'Кампания остановлена.');
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
  const clients = await buildClients(accounts as OutreachAccount[], proxies ?? [], log, downloadSessionFile, db);

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
        entity = await withTimeout(
          client.getEntity(tgUserId),
          TG_RESOLVE_TIMEOUT_MS,
          'поиск собеседника по id',
        );
      } catch {
        if (tgUsername) {
          entity = await withTimeout(
            client.getEntity(tgUsername),
            TG_RESOLVE_TIMEOUT_MS,
            'поиск собеседника по юзернейму',
          );
        }
        else throw new Error(`Не удалось найти пользователя ID:${tgUserId}`);
      }
      const history = await withTimeout(
        client.getMessages(entity, { limit: tg.history_limit }),
        TG_HISTORY_TIMEOUT_MS,
        'чтение истории диалога',
      );

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
