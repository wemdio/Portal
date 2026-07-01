import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  TG_TOKEN,
  tgApiBase,
  ensureTgApiReady,
  upsertBotChat,
  type TgMessage,
  type VideoInfo,
  processVideoMessage,
  saveErrorRecord,
  getSenderName,
} from '@/lib/tgTranscribe';
import {
  isUserMtprotoAvailable,
  getForumTopicMessagesMtproto,
  type MtprotoTopicMessage,
} from '@/lib/tgMtprotoDownload';
import { logInfo, logError } from '@/lib/loggerServer';

const admin = supabaseAdmin!;

/* ───── Types ───── */

interface ScanVideoRow {
  idx: number;
  sender: string;
  filename: string;
  fileSize: number | null;
  duration: number | null;
  phase: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  transcriptionJobId?: string;
}

interface TgChatFull {
  id: number;
  title?: string;
  type?: string;
  is_forum?: boolean;
}

/* ───── Helpers ───── */

async function isStopped(jobId: string): Promise<boolean> {
  const { data } = await admin.from('tg_scan_jobs').select('status').eq('id', jobId).single();
  return data?.status === 'stopped';
}

async function updateJob(jobId: string, fields: Record<string, unknown>) {
  await admin
    .from('tg_scan_jobs')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', jobId);
}

async function getChatInfo(chatId: number): Promise<TgChatFull | null> {
  try {
    const res = await fetch(`${tgApiBase()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { ok: boolean; result?: TgChatFull };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

/* ───── MTProto forum scan ───── */

interface MtprotoScanArgs {
  jobId: string;
  chatId: number;
  topicId: number | null;
  videoCount: number;
  scanMode: 'limited' | 'full';
  alreadyProcessed: Set<number>;
  errorMessageIds: Set<number>;
}

/**
 * Enumerate topic messages via MTProto (no chat side effects), process video
 * messages only. Returns true when the scan completed (either successfully or
 * because the user stopped it) — caller should NOT fall through to the legacy
 * path. Returns false only when MTProto enumeration failed before doing any
 * work, so the caller can fall back to the legacy forward-everything path.
 */
async function runMtprotoForumScan(args: MtprotoScanArgs): Promise<boolean> {
  const { jobId, chatId, topicId, videoCount, scanMode, alreadyProcessed, errorMessageIds } = args;

  const PAGE_SIZE = 100;
  // Limited scans keep the historic ~2000-message ceiling so a runaway job
  // can't burn through the whole chat history. Full scans iterate until the
  // topic returns an empty page (true end).
  const MAX_PAGES = scanMode === 'full' ? 100_000 : 20;

  let offsetId = 0;
  let videosFound = 0;
  let completed = 0;
  let errors = 0;
  let scanned = 0;
  const videos: ScanVideoRow[] = [];
  let lastDbWrite = 0;

  const flushProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastDbWrite < 3000) return;
    lastDbWrite = now;
    await updateJob(jobId, { scanned, videos_found: videosFound, completed, errors, videos });
  };

  const targetLabel = scanMode === 'full' ? 'whole topic' : `${videoCount} videos`;
  await logInfo(
    'tg-transcribe.scan.start',
    `MTProto scanning ${targetLabel} in chat ${chatId} topic ${topicId ?? 0}`,
    { chatId, topicId, videoCount: scanMode === 'full' ? null : videoCount, scanMode, path: 'mtproto' },
  );

  for (let page = 0; page < MAX_PAGES; page++) {
    if (videosFound >= videoCount) break;

    // Stop check every page (covers slow topics where a page can take seconds).
    if (await isStopped(jobId)) {
      await flushProgress(true);
      return true;
    }

    let messages: MtprotoTopicMessage[];
    try {
      messages = await getForumTopicMessagesMtproto(chatId, topicId, { offsetId, limit: PAGE_SIZE });
    } catch (err) {
      // Hard MTProto failure. If we already processed something, finish what
      // we have rather than re-doing it via the legacy path. If we're on the
      // very first page with nothing done, signal fallback so the legacy code
      // can take over.
      await logError('tg-scan.mtproto.page.failed', err, { chatId, topicId, page, offsetId });
      if (scanned === 0) return false;
      break;
    }

    if (messages.length === 0) break;

    for (const m of messages) {
      if (videosFound >= videoCount) break;
      scanned++;

      if (alreadyProcessed.has(m.id)) {
        // Skip without re-downloading: we already have a clean transcript for
        // this msg_id. Count it toward the videoCount target so a re-scan
        // doesn't keep digging deeper looking for "new" videos.
        videosFound++;
        completed++;
        continue;
      }

      if (!m.isVideo) continue;
      if (!m.document) {
        // No download ref on the MTProto msg (rare — non-Document video media,
        // or the sender's file_reference expired). Skip rather than fall back
        // to a bot forward; the whole point of this path is no chat spam.
        await logInfo(
          'tg-scan.mtproto.no-document',
          `Skipping video msg ${m.id} in chat ${chatId} — no MTProto document ref`,
          { chatId, topicId, messageId: m.id },
        );
        continue;
      }

      // Build a synthetic Bot API-shape TgMessage + VideoInfo from the MTProto
      // payload. processVideoMessage will see videoInfo.mtprotoDoc and take
      // its direct-download branch — no Bot API forward, no chat side effects.
      const videoInfo: VideoInfo = {
        fileId: '',  // unused on the mtprotoDoc branch
        fileSize: m.fileSize,
        duration: m.duration,
        filename: m.fileName ?? `video-${m.id}.mp4`,
        mtprotoDoc: m.document,
      };

      videosFound++;

      const syntheticMsg: TgMessage = {
        chat: { id: chatId },
        message_id: m.id,
        date: m.date,
        message_thread_id: topicId != null && topicId > 0 ? topicId : undefined,
        caption: m.caption,
        from: m.senderId != null
          ? {
              id: m.senderId,
              first_name: m.senderName ?? `User ${m.senderId}`,
            }
          : undefined,
      };

      const senderName = m.senderName ?? getSenderName(syntheticMsg);
      const videoIdx = videosFound;

      videos.push({
        idx: videoIdx,
        sender: senderName,
        filename: videoInfo.filename,
        fileSize: videoInfo.fileSize ?? null,
        duration: videoInfo.duration ?? null,
        phase: 'found',
      });
      await flushProgress(true);

      if (await isStopped(jobId)) {
        await flushProgress(true);
        return true;
      }

      if (errorMessageIds.has(m.id)) {
        await admin
          .from('tg_video_transcripts')
          .delete()
          .eq('tg_chat_id', chatId)
          .eq('tg_message_id', m.id);
      }

      try {
        const result = await processVideoMessage(syntheticMsg, videoInfo, (evt) => {
          const v = videos.find((x) => x.idx === videoIdx);
          if (v) {
            v.phase = evt.phase;
            if (evt.downloadedBytes != null) v.downloadedBytes = evt.downloadedBytes;
            if (evt.totalBytes != null) v.totalBytes = evt.totalBytes;
            if (evt.transcriptionJobId) v.transcriptionJobId = evt.transcriptionJobId;
          }
          void flushProgress();
        });

        const v = videos.find((x) => x.idx === videoIdx);
        if (v) {
          v.phase = (result.status === 'completed' || result.status === 'skipped_exists') ? 'done' : 'error';
          if (result.error) v.error = result.error;
        }

        if (result.status === 'completed' || result.status === 'skipped_exists') {
          completed++;
        } else {
          errors++;
        }
        await flushProgress(true);
      } catch (err) {
        await saveErrorRecord(syntheticMsg, videoInfo, err);
        errors++;
        const errorMsg = err instanceof Error ? err.message : 'Неизвестная ошибка';
        const v = videos.find((x) => x.idx === videoIdx);
        if (v) {
          v.phase = 'error';
          v.error = errorMsg;
        }
        await flushProgress(true);
      }

      // Small breathing room between video downloads — same throttle the
      // legacy path has.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Pagination cursor: smallest id we saw this page becomes next page's
    // offsetId (getReplies / getHistory go newest-first).
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.id <= 0) break;
    offsetId = lastMsg.id;

    await flushProgress();
  }

  await logInfo(
    'tg-transcribe.scan.done',
    `MTProto scan done: ${completed} transcribed, ${errors} errors, scanned ${scanned} messages`,
    { chatId, topicId, completed, errors, scanned, videosFound, path: 'mtproto' },
  );

  await updateJob(jobId, {
    status: 'completed',
    scanned,
    videos_found: videosFound,
    completed,
    errors,
    videos,
    finished_at: new Date().toISOString(),
  });

  return true;
}

/* ───── Main worker ───── */

export async function runTgScanJob(jobId: string): Promise<void> {
  const { data: job } = await admin
    .from('tg_scan_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) {
    console.error(`[tg-scan] Job ${jobId} not found`);
    return;
  }

  const chatId: number = job.tg_chat_id;
  const topicId: number | null = job.topic_id ?? null;
  const scanMode: 'limited' | 'full' = job.scan_mode === 'full' ? 'full' : 'limited';
  // For 'full' scans the video_count column is stored as 0 (sentinel); the loop
  // walks every message until startMsgId hits 0 or the user stops the job.
  const videoCount: number =
    scanMode === 'full' ? Number.POSITIVE_INFINITY : (job.video_count as number);

  await updateJob(jobId, { status: 'running', started_at: new Date().toISOString() });

  try {
    if (!TG_TOKEN) throw new Error('TG_TRANSCRIBE_BOT_TOKEN не настроен');
    await ensureTgApiReady();

    const chatInfo = await getChatInfo(chatId);
    if (chatInfo) {
      // Cache-warm the (chat, topicId) row — match what the user picked in
      // the UI. Skip the title arg (passing '' lets upsertBotChat preserve a
      // user-curated "Group → Topic" label set via /chats/add).
      void upsertBotChat(
        chatInfo.id,
        '',
        chatInfo.type ?? 'group',
        undefined,
        chatInfo.is_forum,
        topicId,
      );
    }
    const isForumChat = chatInfo?.is_forum ?? false;

    // Load already-processed messages. Filter by topic when the job is
    // topic-scoped, otherwise alreadyProcessed.has() could false-positive
    // on the same msg_id in a different topic of the same chat.
    let existingQ = admin
      .from('tg_video_transcripts')
      .select('tg_message_id, status')
      .eq('tg_chat_id', chatId);
    if (topicId != null) existingQ = existingQ.eq('topic_id', topicId);
    const { data: existing } = await existingQ;

    const alreadyProcessed = new Set(
      (existing ?? []).filter((r) => r.status !== 'error').map((r) => Number(r.tg_message_id)),
    );
    const errorMessageIds = new Set(
      (existing ?? []).filter((r) => r.status === 'error').map((r) => Number(r.tg_message_id)),
    );

    // ── MTProto-only path ──────────────────────────────────────────────
    //
    // The legacy bot-forward scan was retired 01.07 after auto-sync cron
    // hit «Продажи Polza» — a chat where the TG_TARGET user account isn't
    // a member — and the fallback dumped ~50 forward+delete pairs into
    // that (client-visible) chat. MTProto through the user account never
    // touches the source chat; if it can't do the work, the job fails
    // with a clear message and a human unstucks it (invites the user
    // into the chat, re-auths the session, etc.).
    if (!isUserMtprotoAvailable()) {
      throw new Error(
        'MTProto пользовательский аккаунт не настроен ' +
        '(TG_TARGET_API_ID / TG_TARGET_API_HASH / TG_TARGET_SESSION). ' +
        'Скан невозможен — легаси-путь через бота отключён.',
      );
    }

    // For non-forum chats the tg_bot_chats row may still carry topic_id=0
    // as a schema default. Pass null so MTProto does GetHistory over the
    // whole chat instead of trying to filter on the (non-existent)
    // General topic of a non-forum chat.
    const effectiveTopicId = isForumChat ? topicId : null;

    const mtprotoRan = await runMtprotoForumScan({
      jobId,
      chatId,
      topicId: effectiveTopicId,
      videoCount,
      scanMode,
      alreadyProcessed,
      errorMessageIds,
    });
    if (mtprotoRan) return;

    throw new Error(
      `Аккаунт Никиты не смог прочитать сообщения чата ${chatId}. ` +
      'Скорее всего он не является участником чата (или его выгнали / ' +
      'сессия TG_TARGET протухла). Добавьте аккаунт в чат и перезапустите ' +
      'сканирование. Легаси-путь через бота отключён во избежание флуда форвардами.',
    );

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Неизвестная ошибка';
    await logError('tg-transcribe.scan.error', err, { jobId });
    await updateJob(jobId, {
      status: 'failed',
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
    });
  }
}

/**
 * Mark stale running jobs as failed (e.g. after server restart).
 * Call from GET /scan to clean up before returning active job.
 * Throttled to run at most once per 60 seconds to avoid hammering the DB on every poll.
 */
let _lastMarkStaleTs = 0;
const MARK_STALE_THROTTLE_MS = 60_000;

export async function markStaleJobs(): Promise<void> {
  const now = Date.now();
  if (now - _lastMarkStaleTs < MARK_STALE_THROTTLE_MS) return;
  _lastMarkStaleTs = now;

  const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
  await admin
    .from('tg_scan_jobs')
    .update({
      status: 'failed',
      error_message: 'Сервер был перезапущен во время обработки',
      finished_at: new Date().toISOString(),
    })
    .in('status', ['pending', 'running'])
    .lt('updated_at', tenMinAgo);
}
