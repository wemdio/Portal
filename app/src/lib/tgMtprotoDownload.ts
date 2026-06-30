import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import { decodeFileId } from 'tg-file-id';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { logInfo } from '@/lib/loggerServer';

const API_ID = Number(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const BOT_TOKEN = process.env.TG_TRANSCRIBE_BOT_TOKEN || '';

let client: TelegramClient | null = null;
let connecting: Promise<TelegramClient> | null = null;

// Separate MTProto client authed as the TG_TARGET user account. The bot
// account hits BOT_METHOD_INVALID on messages.GetHistory / GetReplies which
// are needed for forum-topic enumeration, so we route those calls through
// a user account that's already added to the target chats (see /tools/
// tg-transcribe screen — "Никита" account is the one configured here).
let userClient: TelegramClient | null = null;
let userConnecting: Promise<TelegramClient> | null = null;
const MT_RETRY_ATTEMPTS = 3;
const MT_RETRY_DELAY_MS = 1500;
const CHUNK_STALL_TIMEOUT_MS = 600_000; // 10 min with no data = stalled

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextChunkWithTimeout<T>(
  iter: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  return Promise.race([
    iter.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`MTProto download stalled: no data for ${timeoutMs / 1000}s`)),
        timeoutMs,
      ),
    ),
  ]);
}

function isRetryableMtprotoError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`.toLowerCase();
  return (
    msg.includes('not connected') ||
    msg.includes('connection closed') ||
    msg.includes('timeout') ||
    msg.includes('hanging states') ||
    msg.includes('socket hang up')
  );
}

async function getClient(): Promise<TelegramClient> {
  if (client?.connected) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const c = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 3,
    });
    await c.start({ botAuthToken: BOT_TOKEN });
    await logInfo('mtproto.connected', 'GramJS MTProto client connected as bot');
    client = c;
    connecting = null;
    return c;
  })();

  return connecting;
}

export function isMtprotoAvailable(): boolean {
  return !!(API_ID && API_HASH && BOT_TOKEN);
}

/**
 * MTProto creds for the target USER account (Никита, per current prod).
 * Required for any MTProto call that bots can't make — most notably
 * messages.GetHistory and messages.GetReplies for chats that aren't
 * actually owned by the bot.
 */
export function isUserMtprotoAvailable(): boolean {
  return !!(
    process.env.TG_TARGET_API_ID &&
    process.env.TG_TARGET_API_HASH &&
    process.env.TG_TARGET_SESSION
  );
}

async function getUserClient(): Promise<TelegramClient> {
  if (userClient?.connected) return userClient;
  if (userConnecting) return userConnecting;

  userConnecting = (async () => {
    const apiId = Number(process.env.TG_TARGET_API_ID || '0');
    const apiHash = process.env.TG_TARGET_API_HASH || '';
    const sessionStr = process.env.TG_TARGET_SESSION || '';
    if (!apiId || !apiHash || !sessionStr) {
      throw new Error('TG_TARGET_API_ID / TG_TARGET_API_HASH / TG_TARGET_SESSION not configured');
    }
    const c = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
      connectionRetries: 3,
    });
    await c.connect();
    if (!(await c.checkAuthorization())) {
      throw new Error('TG_TARGET_SESSION expired — user account is no longer authorized');
    }
    await logInfo('mtproto.userClient.connected', 'GramJS MTProto user client connected (TG_TARGET account)');
    userClient = c;
    userConnecting = null;
    return c;
  })();

  return userConnecting;
}

/**
 * Download a file from Telegram by its Bot API file_id via MTProto.
 * Decodes the file_id to extract document attributes (id, access_hash, dc_id, file_reference)
 * and downloads directly — no channel entity resolution needed.
 */
export async function downloadFileByFileId(
  fileId: string,
  fileSize?: number,
): Promise<Buffer> {
  const decoded = decodeFileId(fileId);

  const fileRef = decoded.fileReference
    ? Buffer.from(decoded.fileReference, 'hex')
    : Buffer.alloc(0);

  const inputLocation = new Api.InputDocumentFileLocation({
    id: bigInt(decoded.id),
    accessHash: bigInt(decoded.access_hash),
    fileReference: fileRef,
    thumbSize: '',
  });

  await logInfo('mtproto.download.start', `Downloading file via MTProto (dc=${decoded.dcId})`, {
    dcId: decoded.dcId, fileSize,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const c = await getClient();
      const startTime = Date.now();
      const buf = await c.downloadFile(inputLocation, {
        dcId: decoded.dcId,
        fileSize: fileSize ? bigInt(fileSize) : undefined,
      });

      if (!buf) {
        throw new Error('MTProto downloadFile returned empty result');
      }

      const result = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as string);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeMb = (result.byteLength / (1024 * 1024)).toFixed(1);
      await logInfo('mtproto.download.done', `Downloaded ${sizeMb} MB in ${elapsed}s`, {
        bytes: result.byteLength, elapsed,
      });

      return result;
    } catch (err) {
      lastError = err;
      if (!isRetryableMtprotoError(err) || attempt >= MT_RETRY_ATTEMPTS) {
        throw err;
      }
      await logInfo('mtproto.download.retry', `Retrying MTProto buffer download (${attempt}/${MT_RETRY_ATTEMPTS})`, {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      await disconnectMtproto();
      await sleep(MT_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MTProto download failed');
}

/**
 * Download a file from Telegram by its Bot API file_id via MTProto,
 * streaming directly to a file on disk to avoid holding large files in RAM.
 */
export async function downloadFileByFileIdToPath(
  fileId: string,
  destPath: string,
  fileSize?: number,
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  const decoded = decodeFileId(fileId);

  const fileRef = decoded.fileReference
    ? Buffer.from(decoded.fileReference, 'hex')
    : Buffer.alloc(0);

  const inputLocation = new Api.InputDocumentFileLocation({
    id: bigInt(decoded.id),
    accessHash: bigInt(decoded.access_hash),
    fileReference: fileRef,
    thumbSize: '',
  });

  await logInfo('mtproto.download.start', `Downloading file to disk via MTProto (dc=${decoded.dcId})`, {
    dcId: decoded.dcId, fileSize, destPath,
  });

  let lastError: unknown;
  let resumeOffset = 0;
  for (let attempt = 1; attempt <= MT_RETRY_ATTEMPTS; attempt += 1) {
    const c = await getClient();
    const startTime = Date.now();
    const writeStream = createWriteStream(destPath, { flags: resumeOffset > 0 ? 'a' : 'w' });
    try {
      const iterDownload = c.iterDownload({
        file: inputLocation,
        dcId: decoded.dcId,
        offset: bigInt(resumeOffset),
        requestSize: 512 * 1024,
      });

      let totalBytes = resumeOffset;
      let lastProgressAt = 0;
      const iter = iterDownload[Symbol.asyncIterator]();
      while (true) {
        const result = await nextChunkWithTimeout(iter, CHUNK_STALL_TIMEOUT_MS);
        if (result.done) break;
        const buf = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value as string);
        const canContinue = writeStream.write(buf);
        totalBytes += buf.byteLength;
        if (onProgress) {
          const now = Date.now();
          if (now - lastProgressAt >= 2000) {
            lastProgressAt = now;
            onProgress(totalBytes, fileSize);
          }
        }
        if (!canContinue) {
          await new Promise<void>((resolve) => writeStream.once('drain', resolve));
        }
      }
      onProgress?.(totalBytes, fileSize);

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeMb = (totalBytes / (1024 * 1024)).toFixed(1);
      await logInfo('mtproto.download.done', `Downloaded ${sizeMb} MB to disk in ${elapsed}s`, {
        bytes: totalBytes, elapsed, destPath,
      });
      return;
    } catch (err) {
      writeStream.destroy();
      lastError = err;
      // Continue from already written bytes instead of restarting from zero.
      if (isRetryableMtprotoError(err) && attempt < MT_RETRY_ATTEMPTS) {
        try {
          const current = await stat(destPath);
          resumeOffset = Number(current.size);
        } catch {
          resumeOffset = 0;
        }
      }
      if (!isRetryableMtprotoError(err) || attempt >= MT_RETRY_ATTEMPTS) {
        throw err;
      }
      await logInfo('mtproto.download.retry', `Retrying MTProto disk download (${attempt}/${MT_RETRY_ATTEMPTS})`, {
        attempt,
        resumeOffset,
        error: err instanceof Error ? err.message : String(err),
      });
      await disconnectMtproto();
      await sleep(MT_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MTProto download to disk failed');
}

export interface MtprotoForumTopic {
  id: number;
  title: string;
}

/**
 * Discover forum topics by scanning recent messages via messages.GetHistory
 * (allowed for bots, unlike channels.GetForumTopics).
 * For each unique reply_to_top_id found, fetches the topic-creation service
 * message to get the topic title.
 */
export async function getForumTopicsMtproto(chatId: number): Promise<MtprotoForumTopic[]> {
  // messages.GetHistory is bot-restricted (BOT_METHOD_INVALID) for most
  // forum chats. Use the TG_TARGET user account when available; fall back
  // to the bot client only for legacy backwards compatibility.
  const c = isUserMtprotoAvailable() ? await getUserClient() : await getClient();

  const peer = await resolvePeer(c, chatId);

  const topicIds = new Set<number>();
  let offsetId = 0;
  const maxIterations = 5;

  for (let i = 0; i < maxIterations; i++) {
    const history = await c.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: 100,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    );

    const messages = 'messages' in history ? history.messages : [];
    if (messages.length === 0) break;

    for (const msg of messages) {
      if ('replyTo' in msg && msg.replyTo && 'replyToTopId' in msg.replyTo && msg.replyTo.replyToTopId) {
        topicIds.add(msg.replyTo.replyToTopId);
      }
      if ('id' in msg && 'action' in msg && msg.action?.className === 'MessageActionTopicCreate') {
        topicIds.add(msg.id);
      }
    }

    const lastMsg = messages[messages.length - 1];
    if ('id' in lastMsg) {
      offsetId = lastMsg.id;
    } else {
      break;
    }
  }

  topicIds.add(1);

  const topics: MtprotoForumTopic[] = [];

  for (const topicId of topicIds) {
    try {
      const result = await c.invoke(
        new Api.messages.GetHistory({
          peer,
          offsetId: topicId + 1,
          offsetDate: 0,
          addOffset: 0,
          limit: 1,
          maxId: topicId + 1,
          minId: topicId - 1,
          hash: bigInt(0),
        }),
      );

      const msgs = 'messages' in result ? result.messages : [];
      for (const msg of msgs) {
        if (
          'action' in msg &&
          msg.action?.className === 'MessageActionTopicCreate' &&
          'title' in msg.action
        ) {
          topics.push({ id: topicId, title: (msg.action as { title: string }).title });
        }
      }
    } catch {
      // topic 1 = "General" in most forum groups
      if (topicId === 1) {
        topics.push({ id: 1, title: 'General' });
      }
    }
  }

  topics.sort((a, b) => a.id - b.id);
  return topics;
}

/**
 * Opaque-ish reference to an MTProto Document — everything `client.downloadFile`
 * needs to re-fetch the actual bytes without forwarding through the bot first.
 * Sourced from `msg.media.document` on a message we already received via
 * messages.GetReplies/GetHistory, so we never have to call Bot API getFile or
 * forwardMessage to produce a file_id.
 */
export interface MtprotoDocumentRef {
  dcId: number;
  id: string;             // bigInt as string to survive JSON serialization
  accessHash: string;     // same
  fileReferenceHex: string;
  size: number | undefined;
}

export interface MtprotoTopicMessage {
  /** Message id (equal to Bot API message_id). */
  id: number;
  /** UNIX timestamp from Telegram. */
  date: number;
  /** True when the message carries a video / video_note / video document. */
  isVideo: boolean;
  /** Original filename if present (only for document-style attachments). */
  fileName?: string;
  /** Size in bytes if present. */
  fileSize?: number;
  /** Duration in seconds (video / video_note). */
  duration?: number;
  /** Direct-download reference — set only for video messages. */
  document?: MtprotoDocumentRef;
  /** Sender user id (or chat id when sent on behalf of a channel). */
  senderId?: number;
  /** Best-effort sender display name resolved from the same response. */
  senderName?: string;
  /** Caption / text payload of the message. */
  caption?: string;
}

export interface MtprotoTopicScanOptions {
  /** Pagination cursor — fetch messages older than this id. 0 = newest first. */
  offsetId?: number;
  /** Max messages per page; Telegram caps around 100. */
  limit?: number;
}

interface MaybeVideoSummary {
  isVideo: boolean;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  document?: MtprotoDocumentRef;
}

/**
 * Extract video metadata + download ref from an MTProto Message.media. The ref
 * lets the caller call downloadMtprotoDocToPath directly — no bot forward, no
 * Bot API file_id round-trip. That's what gets the scan worker out of the chat:
 * pre-fix every video required a forward+delete pair from the bot, which
 * users saw briefly (and notification recipients always saw).
 */
function extractVideoSummary(msg: unknown): MaybeVideoSummary {
  const empty: MaybeVideoSummary = { isVideo: false };
  if (!msg || typeof msg !== 'object') return empty;
  const media = (msg as { media?: unknown }).media;
  if (!media || typeof media !== 'object') return empty;
  const m = media as { className?: string; document?: unknown };
  if (m.className !== 'MessageMediaDocument' || !m.document) return empty;

  const doc = m.document as {
    className?: string;
    mimeType?: string;
    size?: bigint | number;
    attributes?: Array<{ className?: string; duration?: number; fileName?: string }>;
    id?: bigint | number | string;
    accessHash?: bigint | number | string;
    fileReference?: Buffer | Uint8Array | { type?: string; data?: number[] };
    dcId?: number;
  };
  if (doc.className !== 'Document') return empty;

  const attrs = Array.isArray(doc.attributes) ? doc.attributes : [];
  const videoAttr = attrs.find((a) => a?.className === 'DocumentAttributeVideo');
  const fileNameAttr = attrs.find((a) => a?.className === 'DocumentAttributeFilename');
  const mimeType = doc.mimeType ?? '';
  const isVideo = mimeType.startsWith('video/') || Boolean(videoAttr);
  if (!isVideo) return empty;

  let document: MtprotoDocumentRef | undefined;
  if (doc.id != null && doc.accessHash != null && doc.dcId != null) {
    // gramJS returns fileReference as either a Node Buffer or {type:'Buffer',data}
    // depending on how it was serialized along the way. Normalize to a hex
    // string so the descriptor survives a JSON round-trip if anyone caches it.
    let fileReferenceHex = '';
    const ref = doc.fileReference;
    if (Buffer.isBuffer(ref)) {
      fileReferenceHex = ref.toString('hex');
    } else if (ref instanceof Uint8Array) {
      fileReferenceHex = Buffer.from(ref).toString('hex');
    } else if (ref && typeof ref === 'object' && Array.isArray((ref as { data?: number[] }).data)) {
      fileReferenceHex = Buffer.from((ref as { data: number[] }).data).toString('hex');
    }
    document = {
      dcId: Number(doc.dcId),
      id: String(doc.id),
      accessHash: String(doc.accessHash),
      fileReferenceHex,
      size: doc.size != null ? Number(doc.size) : undefined,
    };
  }

  return {
    isVideo: true,
    fileName: fileNameAttr?.fileName,
    fileSize: doc.size != null ? Number(doc.size) : undefined,
    duration: videoAttr?.duration != null ? Number(videoAttr.duration) : undefined,
    document,
  };
}

/**
 * Build a quick {peerId → displayName} lookup from the users/chats arrays
 * Telegram returns alongside messages.* responses. Lets us tag each message
 * with a sender name without making per-message getEntity calls.
 */
function buildSenderLookup(
  users: unknown[],
  chats: unknown[],
): Map<string, { name: string; id: number }> {
  const map = new Map<string, { name: string; id: number }>();
  for (const u of users) {
    if (!u || typeof u !== 'object') continue;
    const user = u as { id?: bigint | number | string; firstName?: string; lastName?: string; username?: string };
    if (user.id == null) continue;
    const first = (user.firstName ?? '').trim();
    const last = (user.lastName ?? '').trim();
    const username = (user.username ?? '').trim();
    const name = [first, last].filter(Boolean).join(' ') || username || `User ${user.id}`;
    map.set(`user:${user.id}`, { name, id: Number(user.id) });
  }
  for (const ch of chats) {
    if (!ch || typeof ch !== 'object') continue;
    const chat = ch as { id?: bigint | number | string; title?: string; username?: string };
    if (chat.id == null) continue;
    const name = (chat.title ?? '').trim() || (chat.username ?? '').trim() || `Chat ${chat.id}`;
    map.set(`chat:${chat.id}`, { name, id: Number(chat.id) });
    map.set(`channel:${chat.id}`, { name, id: Number(chat.id) });
  }
  return map;
}

function resolveSenderFromFromId(
  fromId: unknown,
  lookup: Map<string, { name: string; id: number }>,
): { id?: number; name?: string } {
  if (!fromId || typeof fromId !== 'object') return {};
  const p = fromId as { className?: string; userId?: bigint | number | string; chatId?: bigint | number | string; channelId?: bigint | number | string };
  if (p.className === 'PeerUser' && p.userId != null) {
    return lookup.get(`user:${p.userId}`) ?? { id: Number(p.userId) };
  }
  if (p.className === 'PeerChat' && p.chatId != null) {
    return lookup.get(`chat:${p.chatId}`) ?? { id: Number(p.chatId) };
  }
  if (p.className === 'PeerChannel' && p.channelId != null) {
    return lookup.get(`channel:${p.channelId}`) ?? { id: Number(p.channelId) };
  }
  return {};
}

/**
 * Download a media document directly from MTProto using a previously-extracted
 * MtprotoDocumentRef. Streams to disk like downloadFileByFileIdToPath; the
 * difference is the input — no Bot API file_id round trip required, no bot
 * forward needed to obtain that file_id in the first place. Uses the user
 * client when configured (downloads visible to TG_TARGET account), falls back
 * to the bot client only if TG_TARGET creds are absent.
 */
export async function downloadMtprotoDocToPath(
  ref: MtprotoDocumentRef,
  destPath: string,
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  const fileRef = ref.fileReferenceHex
    ? Buffer.from(ref.fileReferenceHex, 'hex')
    : Buffer.alloc(0);

  const inputLocation = new Api.InputDocumentFileLocation({
    id: bigInt(ref.id),
    accessHash: bigInt(ref.accessHash),
    fileReference: fileRef,
    thumbSize: '',
  });

  await logInfo('mtproto.docDownload.start', `Downloading mtproto doc to disk (dc=${ref.dcId})`, {
    dcId: ref.dcId, fileSize: ref.size, destPath,
  });

  let lastError: unknown;
  let resumeOffset = 0;
  for (let attempt = 1; attempt <= MT_RETRY_ATTEMPTS; attempt += 1) {
    const c = isUserMtprotoAvailable() ? await getUserClient() : await getClient();
    const startTime = Date.now();
    const writeStream = createWriteStream(destPath, { flags: resumeOffset > 0 ? 'a' : 'w' });
    try {
      const iterDownload = c.iterDownload({
        file: inputLocation,
        dcId: ref.dcId,
        offset: bigInt(resumeOffset),
        requestSize: 512 * 1024,
      });

      let totalBytes = resumeOffset;
      let lastProgressAt = 0;
      const iter = iterDownload[Symbol.asyncIterator]();
      while (true) {
        const result = await nextChunkWithTimeout(iter, CHUNK_STALL_TIMEOUT_MS);
        if (result.done) break;
        const buf = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value as string);
        const canContinue = writeStream.write(buf);
        totalBytes += buf.byteLength;
        if (onProgress) {
          const now = Date.now();
          if (now - lastProgressAt >= 2000) {
            lastProgressAt = now;
            onProgress(totalBytes, ref.size);
          }
        }
        if (!canContinue) {
          await new Promise<void>((resolve) => writeStream.once('drain', resolve));
        }
      }
      onProgress?.(totalBytes, ref.size);

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeMb = (totalBytes / (1024 * 1024)).toFixed(1);
      await logInfo('mtproto.docDownload.done', `Downloaded ${sizeMb} MB to disk in ${elapsed}s`, {
        bytes: totalBytes, elapsed, destPath,
      });
      return;
    } catch (err) {
      writeStream.destroy();
      lastError = err;
      if (isRetryableMtprotoError(err) && attempt < MT_RETRY_ATTEMPTS) {
        try {
          const current = await stat(destPath);
          resumeOffset = Number(current.size);
        } catch {
          resumeOffset = 0;
        }
      }
      if (!isRetryableMtprotoError(err) || attempt >= MT_RETRY_ATTEMPTS) {
        throw err;
      }
      await logInfo('mtproto.docDownload.retry', `Retrying mtproto doc download (${attempt}/${MT_RETRY_ATTEMPTS})`, {
        attempt,
        resumeOffset,
        error: err instanceof Error ? err.message : String(err),
      });
      await disconnectMtproto();
      await sleep(MT_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MTProto doc download failed');
}

/**
 * Fetch a page of messages from a forum-group topic via MTProto.
 *
 * Replaces the previous "forward every message_id backwards via Bot API and
 * filter on the fly" approach that flooded the source chat with N
 * forward+delete pairs (one per message_id walked, regardless of media).
 * MTProto messages.getReplies / getHistory have no chat-visible side effects.
 *
 * topicId semantics:
 *   - null / 0 → whole chat (no topic filter). Uses getHistory.
 *   - > 0      → real topic. Tries getReplies(top_msg_id=topicId) first; on
 *                error (TOPIC_NOT_EXIST etc. — happens when the "topic" is
 *                actually General renamed) falls back to getHistory and
 *                filters messages by reply_to.reply_to_top_id.
 *
 * Returns up to `limit` messages newest-first; pass the smallest returned id
 * back as `offsetId` for the next page.
 */
export async function getForumTopicMessagesMtproto(
  chatId: number,
  topicId: number | null,
  options: MtprotoTopicScanOptions = {},
): Promise<MtprotoTopicMessage[]> {
  // Force user-account auth — bots get BOT_METHOD_INVALID on both
  // messages.GetReplies and messages.GetHistory for forum chats they don't
  // own. The TG_TARGET account is the one configured to actually sit in the
  // chats we transcribe (see UI screen — "Никита" account).
  if (!isUserMtprotoAvailable()) {
    throw new Error(
      'Topic enumeration requires TG_TARGET_API_ID/HASH/SESSION — the bot account cannot enumerate forum topics via MTProto.',
    );
  }
  const c = await getUserClient();
  const peer = await resolvePeer(c, chatId);
  const limit = options.limit ?? 100;
  const offsetId = options.offsetId ?? 0;
  // Tristate input:
  //   null → whole chat, no topic filter (used for non-forum chats).
  //   0    → the General topic of a forum. Callers store 0 in the DB after
  //          we migrated the General-renamed entry off of topic_id=1, but
  //          Telegram itself addresses General by the channel-create message
  //          (msg_id = 1). Normalize 0 → 1 so GetReplies(1) actually runs;
  //          otherwise the function falls through to whole-chat GetHistory
  //          and pulls in messages from neighbouring topics (29.06 incident:
  //          scan of «Звонки с клиентами» returned a video from «Собеседования»).
  //   >0   → specific named topic, unchanged.
  const normalizedTopicId = topicId == null ? 0 : (topicId === 0 ? 1 : topicId);

  type HistoryResult = { messages: unknown[]; users?: unknown[]; chats?: unknown[] };
  let history: HistoryResult | null = null;
  let usedFallback = false;

  if (normalizedTopicId > 0) {
    try {
      history = (await c.invoke(
        new Api.messages.GetReplies({
          peer,
          msgId: normalizedTopicId,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit,
          maxId: 0,
          minId: 0,
          hash: bigInt(0),
        }),
      )) as HistoryResult;
    } catch (err) {
      await logInfo(
        'mtproto.getReplies.fail',
        `messages.GetReplies failed for chat ${chatId} topic ${normalizedTopicId} — falling back to getHistory`,
        { chatId, topicId: normalizedTopicId, error: err instanceof Error ? err.message : String(err) },
      );
      usedFallback = true;
    }
  }

  if (!history) {
    history = (await c.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    )) as HistoryResult;
  }

  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const senderLookup = buildSenderLookup(
    Array.isArray(history?.users) ? history.users : [],
    Array.isArray(history?.chats) ? history.chats : [],
  );
  const results: MtprotoTopicMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || !('id' in msg)) continue;

    if (normalizedTopicId > 0 && usedFallback) {
      // getHistory fallback — filter by replyToTopId so we only keep messages
      // that actually belong to the requested topic.
      const replyTo = (msg as { replyTo?: { replyToTopId?: number | bigint } }).replyTo;
      const replyToTopId = replyTo?.replyToTopId != null ? Number(replyTo.replyToTopId) : null;
      if (replyToTopId !== normalizedTopicId) {
        // Special-case: General-renamed topic with anchor id=1 may have
        // messages with no replyToTopId at all. Accept those when filter==1.
        if (!(normalizedTopicId === 1 && replyToTopId == null)) continue;
      }
    }

    const summary = extractVideoSummary(msg);
    const sender = resolveSenderFromFromId((msg as { fromId?: unknown }).fromId, senderLookup);
    const rawMessageField = (msg as { message?: unknown }).message;
    const caption = typeof rawMessageField === 'string' ? rawMessageField : undefined;
    results.push({
      id: Number((msg as { id: number }).id),
      date: Number((msg as { date?: number }).date ?? 0),
      isVideo: summary.isVideo,
      fileName: summary.fileName,
      fileSize: summary.fileSize,
      duration: summary.duration,
      document: summary.document,
      senderId: sender.id,
      senderName: sender.name,
      caption: caption && caption.length > 0 ? caption : undefined,
    });
  }

  return results;
}

async function resolvePeer(c: TelegramClient, chatId: number): Promise<Api.TypeInputPeer> {
  try {
    return await c.getInputEntity(chatId);
  } catch {
    const rawId = Math.abs(chatId);
    const channelId = rawId > 1_000_000_000_000 ? rawId - 1_000_000_000_000 : rawId;
    const entity = await c.getEntity(chatId);
    if ('accessHash' in entity && entity.accessHash) {
      return new Api.InputPeerChannel({
        channelId: bigInt(channelId),
        accessHash: bigInt(entity.accessHash.toString()),
      });
    }
    throw new Error(`Не удалось получить доступ к каналу ${chatId}. Убедитесь что бот добавлен в группу.`);
  }
}

export async function disconnectMtproto(): Promise<void> {
  if (client?.connected) {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
    client = null;
  }
  if (userClient?.connected) {
    try {
      await userClient.disconnect();
    } catch {
      // ignore disconnect errors
    }
    userClient = null;
  }
}
