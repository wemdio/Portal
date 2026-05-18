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
  const c = await getClient();

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
}
