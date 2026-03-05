import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import { decodeFileId } from 'tg-file-id';
import { logInfo } from '@/lib/loggerServer';

const API_ID = Number(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const BOT_TOKEN = process.env.TG_TRANSCRIBE_BOT_TOKEN || '';

let client: TelegramClient | null = null;
let connecting: Promise<TelegramClient> | null = null;

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
  const c = await getClient();

  const fileRef = decoded.fileReference
    ? Buffer.from(decoded.fileReference, 'hex')
    : Buffer.alloc(0);

  const inputLocation = new Api.InputDocumentFileLocation({
    id: BigInt(decoded.id),
    accessHash: BigInt(decoded.access_hash),
    fileReference: fileRef,
    thumbSize: '',
  });

  await logInfo('mtproto.download.start', `Downloading file via MTProto (dc=${decoded.dcId})`, {
    dcId: decoded.dcId, fileSize,
  });

  const startTime = Date.now();
  const buf = await c.downloadFile(inputLocation, {
    dcId: decoded.dcId,
    fileSize: fileSize ? bigInt(fileSize) : undefined,
    workers: 4,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeMb = (buf.byteLength / (1024 * 1024)).toFixed(1);
  await logInfo('mtproto.download.done', `Downloaded ${sizeMb} MB in ${elapsed}s`, {
    bytes: buf.byteLength, elapsed,
  });

  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
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
