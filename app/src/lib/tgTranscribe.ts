import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  extractOrConvertToMp3,
  extractMp3FromFile,
  transcribeAudio,
  analyzeAudioActivity,
  NoSpeechError,
} from '@/lib/transcription';
import { logError, logInfo } from '@/lib/loggerServer';
import { linkTranscriptToLead } from '@/lib/transcriptAmoLink';
import {
  isMtprotoAvailable,
  isUserMtprotoAvailable,
  downloadFileByFileId,
  downloadFileByFileIdToPath,
  downloadMtprotoDocToPath,
  getForumTopicsMtproto,
  type MtprotoDocumentRef,
} from '@/lib/tgMtprotoDownload';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TG_TOKEN = process.env.TG_TRANSCRIBE_BOT_TOKEN ?? '';
const TG_LOCAL_API_URL = process.env.TG_LOCAL_API_URL || '';

const TG_FILE_SIZE_LIMIT_CLOUD = 20 * 1024 * 1024;

let localApiAvailable: boolean | null = null;
let localApiCheckedAt = 0;
const LOCAL_API_RECHECK_MS = 30_000;
const TG_TRANSCRIPT_WRITE_BACKOFF_MS = 15_000;
let tgTranscriptWritesPausedUntil = 0;
let lastTgTranscriptWriteErrorAt = 0;

function canAttemptTranscriptWrite(): boolean {
  return Date.now() >= tgTranscriptWritesPausedUntil;
}

function markTranscriptWriteFailure(error: unknown): void {
  const now = Date.now();
  tgTranscriptWritesPausedUntil = now + TG_TRANSCRIPT_WRITE_BACKOFF_MS;
  if (now - lastTgTranscriptWriteErrorAt > TG_TRANSCRIPT_WRITE_BACKOFF_MS) {
    lastTgTranscriptWriteErrorAt = now;
    console.error('[tg-transcribe] Failed to write tg_video_transcripts:', error);
  }
}

/**
 * Fields in tg_video_transcripts that are integer columns in Postgres.
 * Telegram MTProto returns some of them as floats (duration especially —
 * seen 596.8, 12.5, etc.), and passing those through to supabase-js used
 * to fail with "invalid input syntax for type integer: 596.8" and then
 * the swallowed error would silently drop the whole batch for 15 s.
 */
const INT_COLUMNS = new Set([
  'duration_seconds',
  'file_size_bytes',
  'length',
]);

function sanitizeTranscriptRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of INT_COLUMNS) {
    const v = out[key];
    if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) {
      out[key] = Math.round(v);
    }
  }
  return out;
}

async function safeInsertTranscript(row: Record<string, unknown>): Promise<string | null> {
  if (!supabaseAdmin) return null;
  if (!canAttemptTranscriptWrite()) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('tg_video_transcripts')
      .insert(sanitizeTranscriptRow(row))
      .select('id');
    if (error) {
      markTranscriptWriteFailure(error);
      return null;
    }
    tgTranscriptWritesPausedUntil = 0;
    return (data?.[0] as { id: string } | undefined)?.id ?? null;
  } catch (error) {
    markTranscriptWriteFailure(error);
    return null;
  }
}

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
  date?: number;
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
  /**
   * When set, processVideoMessage downloads the video directly from MTProto
   * using this reference and skips every Bot API path (getFile / forward /
   * downloadFileByFileId). Populated by the MTProto forum scan path — that
   * way the bot never has to forward the message into the source chat to
   * obtain a file_id, which is what created the visible "→ <forward>" spam.
   */
  mtprotoDoc?: MtprotoDocumentRef;
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
const HTTP_CHUNK_STALL_MS = 600_000; // 10 min with no data = stalled

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
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`HTTP download stalled: no data for ${HTTP_CHUNK_STALL_MS / 1000}s`)),
            HTTP_CHUNK_STALL_MS,
          ),
        ),
      ]);
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
  transcriptionJobId?: string;
}

/**
 * Statuses that mean "we're done with this message forever" — the file either
 * has a transcript or PERMANENTLY can't have one (no audio track / no speech).
 * Scans must not re-download or re-submit these: before this list existed, a
 * 3 GB silent screen recording was re-downloaded by every nightly scan just
 * to fail on the same "no audio stream" ffmpeg error again.
 */
export const TERMINAL_TRANSCRIPT_STATUSES = [
  'completed',
  'skipped_no_audio',
  'skipped_no_speech',
] as const;

async function hasSuccessfulTranscript(chatId: number, messageId: number, topicId: number): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('tg_video_transcripts')
      .select('id, topic_id')
      .eq('tg_chat_id', chatId)
      .eq('tg_message_id', messageId)
      .in('status', [...TERMINAL_TRANSCRIPT_STATUSES])
      .limit(1);
    if (error) return false;
    const row = data?.[0];
    if (!row) return false;
    // Existing transcript: re-tag the topic_id if we now know it differs.
    // Lets legacy NULL or wrong-bucket rows migrate to the correct topic
    // without re-burning transcription quota.
    const existingTopicId = (row as { topic_id: number | null }).topic_id;
    if (existingTopicId !== topicId) {
      try {
        await supabaseAdmin
          .from('tg_video_transcripts')
          .update({ topic_id: topicId })
          .eq('id', (row as { id: string }).id);
      } catch {
        // best-effort re-tag; skip remains correct either way
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg's way of saying "this video has no audio track at all" (-vn drops video, nothing remains). */
function isNoAudioStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /does not contain any stream|Output file is empty/i.test(err.message);
}

/** Whisper (local 422 / Groq empty result) reported that there is no recognizable speech. */
function isNoSpeechProviderError(err: unknown): boolean {
  if (err instanceof NoSpeechError) return true;
  if (!(err instanceof Error)) return false;
  return /Не удалось распознать речь/i.test(err.message);
}

/**
 * Record a PERMANENT skip (no audio track / no speech) as a terminal status.
 * Unlike status='error' rows, these are never deleted-and-retried by the
 * scan worker, so the file stops being re-downloaded every night.
 */
async function saveSkippedRecord(
  msg: TgMessage,
  videoInfo: VideoInfo,
  status: 'skipped_no_audio' | 'skipped_no_speech',
  reason: string,
  fileSizeBytes?: number,
): Promise<void> {
  console.log(
    `[tg-transcribe] Permanently skipping ${videoInfo.filename} (msgId=${msg.message_id}): ${reason}`,
  );
  await logInfo('tg-transcribe.skipped', reason, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    status,
    filename: videoInfo.filename,
  });
  await safeInsertTranscript({
    tg_chat_id: msg.chat.id,
    tg_message_id: msg.message_id,
    topic_id: msg.message_thread_id ?? 0,
    tg_sender_id: getSenderId(msg),
    sender_name: getSenderName(msg),
    filename: videoInfo.filename,
    file_size_bytes: fileSizeBytes ?? videoInfo.fileSize ?? null,
    duration_seconds: videoInfo.duration ?? null,
    tg_message_date: msg.date != null ? new Date(msg.date * 1000).toISOString() : null,
    caption: msg.caption ?? null,
    text: '',
    length: 0,
    status,
    error_text: reason,
  });
}

export type ProcessVideoStatus =
  | 'completed'
  | 'error'
  | 'skipped_size'
  | 'skipped_exists'
  | 'skipped_no_audio'
  | 'skipped_no_speech';

/** Statuses that count as successfully dealt with (not an error, no retry needed). */
export function isTerminalOkStatus(status: ProcessVideoStatus): boolean {
  return status === 'completed'
    || status === 'skipped_exists'
    || status === 'skipped_no_audio'
    || status === 'skipped_no_speech';
}

export async function processVideoMessage(
  msg: TgMessage,
  videoInfo: VideoInfo,
  onProgress?: (event: VideoProgressEvent) => void,
): Promise<{ status: ProcessVideoStatus; text?: string; error?: string }> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client not configured');
  }

  if (await hasSuccessfulTranscript(msg.chat.id, msg.message_id, msg.message_thread_id ?? 0)) {
    console.log(`[tg-transcribe] Skipping ${videoInfo.filename} (msgId=${msg.message_id}) — already transcribed`);
    return { status: 'skipped_exists' };
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
    await safeInsertTranscript({
      tg_chat_id: msg.chat.id,
      tg_message_id: msg.message_id,
      topic_id: msg.message_thread_id ?? 0,
      tg_sender_id: senderId,
      sender_name: senderName,
      filename: videoInfo.filename,
      file_size_bytes: videoInfo.fileSize ?? null,
      duration_seconds: videoInfo.duration ?? null,
      tg_message_date: msg.date != null ? new Date(msg.date * 1000).toISOString() : null,
      caption: msg.caption ?? null,
      text: '',
      length: 0,
      status: 'error',
      error_text: errorText,
    });
    return { status: 'skipped_size', error: errorText };
  }

  console.log(`[tg-transcribe] Processing ${videoInfo.filename} (${((videoInfo.fileSize ?? 0) / 1e6).toFixed(1)} MB), mtproto=${canUseMtproto}, large=${isLargeFile}, localApi=${isLocalApi()}, mtprotoDoc=${!!videoInfo.mtprotoDoc}`);
  onProgress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes: videoInfo.fileSize });

  try {
    if (videoInfo.mtprotoDoc && isUserMtprotoAvailable()) {
      // Direct MTProto download — used by the forum-topic scanner so the bot
      // doesn't have to forward+delete the message in the source chat just to
      // produce a file_id. The forward path was visible to chat members and
      // generated push notifications even though the message got deleted right
      // after; this branch skips it entirely.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-tg-dl-'));
      const ext = getExtFromFilename(videoInfo.filename);
      const videoPath = path.join(tmpDir, `video${ext}`);
      try {
        await downloadMtprotoDocToPath(
          videoInfo.mtprotoDoc,
          videoPath,
          (downloaded, total) => {
            onProgress?.({ phase: 'downloading', downloadedBytes: downloaded, totalBytes: total });
          },
          // Refresh context: if the fileReference has expired (common when a
          // scan sits on message N for hours while earlier messages in the
          // same batch age out), the downloader re-fetches the message from
          // Telegram and retries with a fresh reference.
          { chatId: msg.chat.id, msgId: msg.message_id },
        );
        const stat = await fs.stat(videoPath);
        fileSizeBytes = stat.size;
        console.log(`[tg-transcribe] Downloaded ${videoInfo.filename} via MTProto-direct, ${(fileSizeBytes / 1e6).toFixed(1)} MB, converting...`);
        onProgress?.({ phase: 'converting' });
        mp3 = await extractMp3FromFile(videoPath);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    } else if (canUseMtproto && isLargeFile) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-tg-dl-'));
      const ext = getExtFromFilename(videoInfo.filename);
      const videoPath = path.join(tmpDir, `video${ext}`);
      try {
        await downloadFileByFileIdToPath(videoInfo.fileId, videoPath, videoInfo.fileSize, (downloaded, total) => {
          onProgress?.({ phase: 'downloading', downloadedBytes: downloaded, totalBytes: total });
        });
        const stat = await fs.stat(videoPath);
        fileSizeBytes = stat.size;
        console.log(`[tg-transcribe] Downloaded ${videoInfo.filename}, ${(fileSizeBytes / 1e6).toFixed(1)} MB on disk, converting...`);
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
  } catch (err) {
    if (isNoAudioStreamError(err)) {
      // Stickers, GIF-style memes and muted screen recordings have no audio
      // track at all. That can't change on retry — record it as a terminal
      // skip so nightly scans stop re-downloading the file (a 3 GB silent
      // screen recording used to be pulled from Telegram every single night).
      const reason = 'В файле нет аудиодорожки (стикер/гифка/запись экрана без звука) — расшифровывать нечего.';
      await saveSkippedRecord(msg, videoInfo, 'skipped_no_audio', reason, fileSizeBytes || undefined);
      return { status: 'skipped_no_audio', error: reason };
    }
    throw err;
  }

  console.log(`[tg-transcribe] Converted ${videoInfo.filename} → MP3 (${(mp3.byteLength / 1e6).toFixed(1)} MB), sending to transcriber...`);

  // Pre-flight: measure audible signal before spending transcription quota.
  // Threshold is deliberately conservative — only files with < 3 s of sound
  // above -40 dB are skipped, so quiet-but-real speech still goes through.
  if (process.env.TG_TRANSCRIBE_SILENCE_PREFLIGHT !== '0') {
    try {
      const activity = await analyzeAudioActivity(mp3);
      if (activity.activeSeconds < 3) {
        const reason =
          `В записи не слышно речи (звук громче порога: ~${Math.round(activity.activeSeconds)} с ` +
          `из ${Math.round(activity.durationSeconds)} с) — файл пропущен, квота расшифровки не потрачена.`;
        await saveSkippedRecord(msg, videoInfo, 'skipped_no_speech', reason, fileSizeBytes || undefined);
        return { status: 'skipped_no_speech', error: reason };
      }
    } catch (preflightErr) {
      // Best-effort check: if ffmpeg hiccups here, just proceed to the provider.
      console.warn(
        '[tg-transcribe] Silence pre-flight failed (ignored):',
        preflightErr instanceof Error ? preflightErr.message : preflightErr,
      );
    }
  }

  const transcriptionJobId = crypto.randomUUID();
  onProgress?.({ phase: 'transcribing', transcriptionJobId });
  let text: string;
  try {
    text = await transcribeAudio({ audioMp3: mp3, filename: videoInfo.filename, jobId: transcriptionJobId });
  } catch (err) {
    if (isNoSpeechProviderError(err)) {
      // Whisper listened to the whole file and found nothing to write down
      // (music without words, background noise). Same deal as no-audio:
      // permanent, don't burn quota on it again tomorrow night.
      const reason = 'Распознавание не нашло речи в записи (музыка или шум без слов) — файл помечен как обработанный.';
      await saveSkippedRecord(msg, videoInfo, 'skipped_no_speech', reason, fileSizeBytes || undefined);
      return { status: 'skipped_no_speech', error: reason };
    }
    throw err;
  }
  console.log(`[tg-transcribe] Transcribed ${videoInfo.filename}, text length: ${text.length}`);

  const insertOk = await safeInsertTranscript({
    tg_chat_id: msg.chat.id,
    tg_message_id: msg.message_id,
    topic_id: msg.message_thread_id ?? 0,
    tg_sender_id: senderId,
    sender_name: senderName,
    filename: videoInfo.filename,
    file_size_bytes: fileSizeBytes,
    duration_seconds: videoInfo.duration ?? null,
    tg_message_date: msg.date != null ? new Date(msg.date * 1000).toISOString() : null,
    caption: msg.caption ?? null,
    text,
    length: text.length,
    status: 'completed',
  });

  if (!insertOk) {
    // Escalate — otherwise the scan worker will happily mark this video as
    // completed while the transcript is nowhere in the DB, and the user
    // sees ✓ in the scan progress but the record never appears in History.
    throw new Error(
      `Не удалось записать транскрипт в БД (msg ${msg.message_id}). ` +
      'Скорее всего Postgres отклонил вставку (см. предыдущий log).',
    );
  }

  await linkTranscriptToLead(supabaseAdmin, insertOk, msg.caption);

  await logInfo('tg-transcribe.completed', `Transcribed video from ${senderName}`, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    senderId,
    filename: videoInfo.filename,
    textLength: text.length,
  });

  return { status: 'completed', text };
}

/**
 * Auto-upsert every forum topic Telegram knows about for `chatId` into
 * `tg_bot_chats`, using the topic title from MTProto. Best-effort: swallows
 * MTProto errors, no-ops when no user MTProto session is configured.
 *
 * Why: transcripts get `topic_id = msg.message_thread_id` written on every
 * insert, but `tg_bot_chats` only had a row for the topics that a user
 * manually registered via /chats/add. Any topic no-one registered surfaced
 * in the UI as the fallback label `<chat> · topic <id>` — visually broken
 * even though the transcript itself was fine. This helper closes that gap.
 *
 * Runs at the start of every scan job (cheap — one MTProto call returns the
 * full topic list), and lazily from the webhook when a message arrives in
 * an unnamed topic. Also updates `topic_name` when Telegram side renamed it.
 */
export async function syncForumTopicsFromApi(chatId: number): Promise<void> {
  if (!supabaseAdmin) return;
  if (!isUserMtprotoAvailable()) return;

  let topics: Awaited<ReturnType<typeof getForumTopicsMtproto>>;
  try {
    topics = await getForumTopicsMtproto(chatId);
  } catch (err) {
    // Don't spam logs — some chats aren't forums, MTProto session may be
    // temporarily unavailable, etc. Auto-upsert is best-effort.
    console.warn(`[tg-transcribe] syncForumTopicsFromApi(${chatId}) failed:`, err);
    return;
  }
  if (topics.length === 0) return;

  // Preserve chat-level chat_type. Fall back to 'supergroup' — forum chats
  // are always supergroups in Telegram.
  let chatType = 'supergroup';
  try {
    const { data: chatRow } = await supabaseAdmin
      .from('tg_bot_chats')
      .select('chat_type')
      .eq('chat_id', chatId)
      .eq('topic_id', 0)
      .maybeSingle();
    if (chatRow && typeof (chatRow as { chat_type?: unknown }).chat_type === 'string') {
      chatType = (chatRow as { chat_type: string }).chat_type;
    }
  } catch {
    // best-effort — supergroup is a safe default
  }

  for (const t of topics) {
    // upsertBotChat with title='' preserves any user-curated title on the
    // row (e.g. "Продажи Polza → Звонки" set via /chats/add). is_forum=true
    // and topicName ensures the row displays as "<chat> → <topic>" not
    // "<chat> · topic N".
    await upsertBotChat(chatId, '', chatType, undefined, true, t.id, t.title);
  }
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
    chat_type: chatType,
    topic_id: topicId ?? 0,
    updated_at: new Date().toISOString(),
  };
  // Only overwrite the title if we have a non-empty value — otherwise a
  // webhook payload missing chat.title would blank out a user-curated
  // "Group → Topic" label set via /chats/add.
  if (title) row.title = title;
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
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
  console.error(
    `[tg-transcribe] Video error: ${err instanceof Error ? err.message : err}`,
    cause ? `cause: ${cause}` : '',
    `file: ${videoInfo.filename}`,
    `msgId: ${msg.message_id}`,
  );
  await logError('tg-transcribe.error', err, {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    senderId: getSenderId(msg),
    cause,
  });

  if (!supabaseAdmin) return;

  const errorText = err instanceof Error
    ? (cause ? `${err.message} (cause: ${cause})` : err.message)
    : 'Неизвестная ошибка';
  await safeInsertTranscript({
    tg_chat_id: msg.chat.id,
    tg_message_id: msg.message_id,
    topic_id: msg.message_thread_id ?? 0,
    tg_sender_id: getSenderId(msg),
    sender_name: getSenderName(msg),
    filename: videoInfo.filename,
    file_size_bytes: videoInfo.fileSize ?? null,
    duration_seconds: videoInfo.duration ?? null,
    tg_message_date: msg.date != null ? new Date(msg.date * 1000).toISOString() : null,
    caption: msg.caption ?? null,
    text: '',
    length: 0,
    status: 'error',
    error_text: errorText,
  });
}
