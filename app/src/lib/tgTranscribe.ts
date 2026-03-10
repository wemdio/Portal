import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { extractOrConvertToMp3, extractMp3FromFile, callOpenRouterTranscription } from '@/lib/transcription';
import { logError, logInfo } from '@/lib/loggerServer';
import { isMtprotoAvailable, downloadFileByFileId, downloadFileByFileIdToPath } from '@/lib/tgMtprotoDownload';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TG_TOKEN = process.env.TG_TRANSCRIBE_BOT_TOKEN ?? '';
const TG_LOCAL_API_URL = process.env.TG_LOCAL_API_URL || '';

const TG_FILE_SIZE_LIMIT_CLOUD = 20 * 1024 * 1024;

let localApiAvailable: boolean | null = null;
let localApiCheckedAt = 0;
const LOCAL_API_RECHECK_MS = 30_000;

async function checkLocalApi(): Promise<boolean> {
  if (!TG_LOCAL_API_URL) return false;
  if (localApiAvailable === true) return true;
  const now = Date.now();
  if (localApiAvailable === false && now - localApiCheckedAt < LOCAL_API_RECHECK_MS) return false;
  try {
    const res = await fetch(`${TG_LOCAL_API_URL}/bot${TG_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(3000),
    });
    const json = await res.json() as { ok?: boolean };
    localApiAvailable = !!json.ok;
  } catch {
    localApiAvailable = false;
  }
  localApiCheckedAt = now;
  if (!localApiAvailable) {
    console.warn('[tg-bot-api] Local API недоступен, используем api.telegram.org');
  }
  return localApiAvailable;
}

export async function ensureTgApiReady(): Promise<void> {
  await checkLocalApi();
}

function isLocalApi(): boolean {
  return localApiAvailable === true;
}

export function tgApiBase(): string {
  if (isLocalApi()) return `${TG_LOCAL_API_URL}/bot${TG_TOKEN}`;
  return `https://api.telegram.org/bot${TG_TOKEN}`;
}

function tgFileBase(): string {
  if (isLocalApi()) return `${TG_LOCAL_API_URL}/file/bot${TG_TOKEN}`;
  return `https://api.telegram.org/file/bot${TG_TOKEN}`;
}

export { TG_TOKEN };

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgVideo {
  file_id: string;
  file_size?: number;
  duration?: number;
  file_name?: string;
}

export interface TgForwardOrigin {
  type: string;
  sender_user?: TgUser;
  sender_user_name?: string;
  chat?: { id: number; title?: string };
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number };
  from?: TgUser;
  forward_origin?: TgForwardOrigin;
  forward_from?: TgUser;
  forward_sender_name?: string;
  video?: TgVideo;
  video_note?: { file_id: string; file_size?: number; duration?: number };
  document?: { file_id: string; file_size?: number; file_name?: string; mime_type?: string };
  caption?: string;
}

export function buildName(from: TgUser | undefined): string {
  if (!from) return '';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || `User ${from.id}`;
}

export function getSenderName(msg: TgMessage): string {
  if (msg.forward_origin) {
    const fo = msg.forward_origin;
    if (fo.type === 'user' && fo.sender_user) return buildName(fo.sender_user);
    if (fo.type === 'hidden_user' && fo.sender_user_name) return fo.sender_user_name;
    if (fo.type === 'chat' && fo.chat?.title) return fo.chat.title;
  }
  if (msg.forward_from) return buildName(msg.forward_from);
  if (msg.forward_sender_name) return msg.forward_sender_name;
  return buildName(msg.from) || 'Unknown';
}

export function getSenderId(msg: TgMessage): number {
  if (msg.forward_origin?.type === 'user' && msg.forward_origin.sender_user) {
    return msg.forward_origin.sender_user.id;
  }
  if (msg.forward_from) return msg.forward_from.id;
  return msg.from?.id ?? 0;
}

export interface VideoInfo {
  fileId: string;
  fileSize: number | undefined;
  duration: number | undefined;
  filename: string;
}

export function extractVideoInfo(msg: TgMessage): VideoInfo | null {
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      fileSize: msg.video.file_size,
      duration: msg.video.duration,
      filename: msg.video.file_name ?? 'video.mp4',
    };
  }

  if (msg.video_note) {
    return {
      fileId: msg.video_note.file_id,
      fileSize: msg.video_note.file_size,
      duration: msg.video_note.duration,
      filename: 'video_note.mp4',
    };
  }

  if (msg.document) {
    const mime = msg.document.mime_type ?? '';
    if (mime.startsWith('video/')) {
      return {
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size,
        duration: undefined,
        filename: msg.document.file_name ?? 'document.mp4',
      };
    }
  }

  return null;
}

async function resolveTelegramFilePath(fileId: string): Promise<string> {
  const getFileRes = await fetch(
    `${tgApiBase()}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const getFileJson = (await getFileRes.json()) as {
    ok: boolean;
    result?: { file_path?: string; file_size?: number };
    description?: string;
  };

  if (!getFileJson.ok || !getFileJson.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${getFileJson.description ?? 'unknown error'}`);
  }

  return getFileJson.result.file_path;
}

export async function downloadTelegramFile(fileId: string): Promise<{ bytes: Buffer; filePath: string }> {
  const filePath = await resolveTelegramFilePath(fileId);
  const downloadUrl = `${tgFileBase()}/${filePath}`;
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Telegram file download failed: ${downloadRes.status} ${downloadRes.statusText}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  return { bytes: Buffer.from(arrayBuffer), filePath };
}

/**
 * Stream a file from Telegram Bot API (cloud or local) directly to disk.
 */
async function downloadTelegramFileToDisk(fileId: string, destPath: string): Promise<string> {
  const filePath = await resolveTelegramFilePath(fileId);
  const downloadUrl = `${tgFileBase()}/${filePath}`;
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Telegram file download failed: ${downloadRes.status} ${downloadRes.statusText}`);
  }

  if (!downloadRes.body) {
    throw new Error('Telegram file download returned no body');
  }

  const fileHandle = await fs.open(destPath, 'w');
  try {
    const reader = (downloadRes.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await fileHandle.write(value);
    }
  } finally {
    await fileHandle.close();
  }

  return filePath;
}

function getExtFromPath(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  if (idx === -1) return '.mp4';
  return filePath.slice(idx).toLowerCase();
}

function getExtFromFilename(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '.mp4';
  return filename.slice(idx).toLowerCase();
}

export type VideoPhase = 'downloading' | 'converting' | 'transcribing' | 'done' | 'error';

export interface VideoProgressEvent {
  phase: VideoPhase;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export async function processVideoMessage(
  msg: TgMessage,
  videoInfo: VideoInfo,
  onProgress?: (event: VideoProgressEvent) => void,
): Promise<{ status: 'completed' | 'error' | 'skipped_size'; text?: string; error?: string }> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  const senderName = getSenderName(msg);
  const senderId = getSenderId(msg);

  const isLargeFile = videoInfo.fileSize != null && videoInfo.fileSize > TG_FILE_SIZE_LIMIT_CLOUD;
  const canUseMtproto = isMtprotoAvailable();

  let mp3: Buffer;
  let fileSizeBytes = videoInfo.fileSize ?? 0;

  if (isLargeFile && !canUseMtproto && !isLocalApi()) {
    const sizeMb = ((videoInfo.fileSize ?? 0) / (1024 * 1024)).toFixed(1);
    const errorText = `Файл слишком большой (${sizeMb} МБ). Лимит Bot API — 20 МБ. Настройте TELEGRAM_API_ID/TELEGRAM_API_HASH или TG_LOCAL_API_URL.`;
    await supabaseAdmin.from('tg_video_transcripts').insert({
      tg_chat_id: msg.chat.id,
      tg_message_id: msg.message_id,
      tg_sender_id: senderId,
      sender_name: senderName,
      filename: videoInfo.filename,
      file_size_bytes: videoInfo.fileSize ?? null,
      duration_seconds: videoInfo.duration ?? null,
      text: '',
      length: 0,
      status: 'error',
      error_text: errorText,
    });
    return { status: 'skipped_size', error: errorText };
  }

  onProgress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes: videoInfo.fileSize });

  if (canUseMtproto && isLargeFile) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-tg-dl-'));
    const ext = getExtFromFilename(videoInfo.filename);
    const videoPath = path.join(tmpDir, `video${ext}`);
    try {
      await downloadFileByFileIdToPath(videoInfo.fileId, videoPath, videoInfo.fileSize, (downloaded, total) => {
        onProgress?.({ phase: 'downloading', downloadedBytes: downloaded, totalBytes: total });
      });
      const stat = await fs.stat(videoPath);
      fileSizeBytes = stat.size;
      onProgress?.({ phase: 'converting' });
      mp3 = await extractMp3FromFile(videoPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } else if (canUseMtproto) {
    const bytes = await downloadFileByFileId(videoInfo.fileId, videoInfo.fileSize);
    fileSizeBytes = bytes.byteLength;
    onProgress?.({ phase: 'converting' });
    const ext = getExtFromFilename(videoInfo.filename);
    mp3 = await extractOrConvertToMp3({ bytes, inputExt: ext });
  } else if (isLocalApi() && isLargeFile) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-tg-dl-'));
    const ext = getExtFromFilename(videoInfo.filename);
    const videoPath = path.join(tmpDir, `video${ext}`);
    try {
      await downloadTelegramFileToDisk(videoInfo.fileId, videoPath);
      const stat = await fs.stat(videoPath);
      fileSizeBytes = stat.size;
      onProgress?.({ phase: 'converting' });
      mp3 = await extractMp3FromFile(videoPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    const result = await downloadTelegramFile(videoInfo.fileId);
    fileSizeBytes = result.bytes.byteLength;
    onProgress?.({ phase: 'converting' });
    const ext = getExtFromPath(result.filePath);
    mp3 = await extractOrConvertToMp3({ bytes: result.bytes, inputExt: ext });
  }

  onProgress?.({ phase: 'transcribing' });
  const text = await callOpenRouterTranscription({ audioMp3: mp3 });

  await supabaseAdmin.from('tg_video_transcripts').insert({
    tg_chat_id: msg.chat.id,
    tg_message_id: msg.message_id,
    tg_sender_id: senderId,
    sender_name: senderName,
    filename: videoInfo.filename,
    file_size_bytes: fileSizeBytes,
    duration_seconds: videoInfo.duration ?? null,
    text,
    length: text.length,
    status: 'completed',
  });

  await logInfo('tg-transcribe.completed', `Transcribed video from ${senderName}`, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    senderId,
    filename: videoInfo.filename,
    textLength: text.length,
  });

  return { status: 'completed', text };
}

export async function upsertBotChat(
  chatId: number,
  title: string,
  chatType: string,
  lastMessageId?: number,
  isForum?: boolean,
  topicId?: number | null,
  topicName?: string | null,
): Promise<void> {
  if (!supabaseAdmin) return;
  const row: Record<string, unknown> = {
    chat_id: chatId,
    title,
    chat_type: chatType,
    topic_id: topicId ?? 0,
    updated_at: new Date().toISOString(),
  };
  if (lastMessageId != null) row.last_message_id = lastMessageId;
  if (isForum != null) row.is_forum = isForum;
  if (topicName !== undefined) row.topic_name = topicName;

  try {
    await supabaseAdmin.from('tg_bot_chats').upsert(row, { onConflict: 'chat_id,topic_id' });
  } catch {
    // ignore
  }
}

export async function saveErrorRecord(
  msg: TgMessage,
  videoInfo: VideoInfo,
  err: unknown,
): Promise<void> {
  await logError('tg-transcribe.error', err, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    senderId: getSenderId(msg),
  });

  if (!supabaseAdmin) return;

  const errorText = err instanceof Error ? err.message : 'Неизвестная ошибка';
  await supabaseAdmin.from('tg_video_transcripts').insert({
    tg_chat_id: msg.chat.id,
    tg_message_id: msg.message_id,
    tg_sender_id: getSenderId(msg),
    sender_name: getSenderName(msg),
    filename: videoInfo.filename,
    file_size_bytes: videoInfo.fileSize ?? null,
    duration_seconds: videoInfo.duration ?? null,
    text: '',
    length: 0,
    status: 'error',
    error_text: errorText,
  });
}
