import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  TG_TOKEN,
  tgApiBase,
  ensureTgApiReady,
  upsertBotChat,
  type TgMessage,
  extractVideoInfo,
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

/**
 * Determine which forum topic a message belongs to by replying to it.
 * The Bot API response includes message_thread_id of the thread the
 * original message lives in. Returns 0 for non-forum chats.
 */
async function detectTopicId(chatId: number, messageId: number): Promise<number | null> {
  const res = await fetch(`${tgApiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '.',
      // disable_notification keeps the probe from pinging the original
      // sender's device; the message still appears briefly in the chat
      // until deleteMessage lands below.
      disable_notification: true,
      reply_parameters: { message_id: messageId },
    }),
  });

  const json = (await res.json()) as { ok: boolean; result?: TgMessage; description?: string };
  if (!json.ok || !json.result) {
    await logInfo('tg-scan.detectTopic.fail', `detectTopicId failed for msg ${messageId}`, {
      chatId, messageId, ok: json.ok, description: json.description,
    });
    // null signals "couldn't determine" — distinct from 0 which means
    // "confirmed General / non-forum". Callers can decide to skip vs default.
    return null;
  }

  const threadId = json.result.message_thread_id ?? 0;

  await logInfo('tg-scan.detectTopic', `msg ${messageId} → topic ${threadId}`, {
    chatId, messageId, threadId,
  });

  try {
    await fetch(`${tgApiBase()}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: json.result.message_id }),
    });
  } catch {
    // Probe '.' remains in the chat — log so operators can tell when this
    // starts piling up (network blip vs revoked permission vs rate-limited).
    await logInfo('tg-scan.detectTopic.deleteFailed', `Failed to delete probe message in chat ${chatId}`, {
      chatId, probeMessageId: json.result.message_id,
    });
  }

  return threadId;
}

async function forwardAndInspect(chatId: number, messageId: number): Promise<TgMessage | null> {
  const res = await fetch(`${tgApiBase()}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, from_chat_id: chatId, message_id: messageId }),
  });

  const json = (await res.json()) as { ok: boolean; result?: TgMessage };
  if (!json.ok || !json.result) return null;

  const forwarded = json.result;
  void fetch(`${tgApiBase()}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: forwarded.message_id }),
  }).catch(() => {});

  return forwarded;
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

      // Forward via Bot API to get the file_id + sender info processVideoMessage
      // needs. This is the ONLY chat side-effect — and only for actual videos.
      let forwarded: TgMessage | null;
      try {
        forwarded = await forwardAndInspect(chatId, m.id);
      } catch {
        continue;
      }
      if (!forwarded) continue;

      const videoInfo = extractVideoInfo(forwarded);
      if (!videoInfo) continue;

      videosFound++;

      const syntheticMsg: TgMessage = {
        ...forwarded,
        chat: { id: chatId },
        message_id: m.id,
        // Tag the transcript with the topic that was requested in the job. MTProto
        // already enforced the topic filter via getReplies (or fallback filter),
        // so we don't need a per-message detectTopicId probe.
        message_thread_id: topicId != null && topicId > 0 ? topicId : undefined,
      };

      const senderName = getSenderName(syntheticMsg);
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

    // ── MTProto fast path for forum chats ──────────────────────────────
    //
    // Legacy path: probe last msg_id → iterate by -1 → forwardMessage every
    // single message_id → filter by topic via "."-reply. On a chat with 5000
    // total messages and 449 in the target subchat that's 5000 forwards
    // + 5000 reply probes — all visible in the source chat as fleeting
    // forward + "." pairs. Users see this as floods of notifications.
    //
    // New path: MTProto messages.getReplies pulls only the topic's messages
    // (or fallback to getHistory + filter) with zero side effects. We only
    // forwardMessage for messages MTProto already told us are videos, so the
    // chat sees at most one forward per video found (≤ video_count, typically
    // 5-50) instead of per-message-id-walked.
    //
    // Activates when bot has MTProto creds AND chat is a forum. Non-forum
    // chats use the legacy path — there's no per-topic floods to avoid.
    if (isForumChat && isUserMtprotoAvailable()) {
      const mtprotoRan = await runMtprotoForumScan({
        jobId,
        chatId,
        topicId,
        videoCount,
        scanMode,
        alreadyProcessed,
        errorMessageIds,
      });
      if (mtprotoRan) return;
      await logInfo('tg-scan.mtproto.fallback', `MTProto path bailed for chat ${chatId} — using legacy forward scan`, {
        chatId, topicId,
      });
    }

    // Resolve start message ID
    const { data: chatRow } = await admin
      .from('tg_bot_chats')
      .select('last_message_id')
      .eq('chat_id', chatId)
      .eq('topic_id', topicId ?? 0)
      .single();

    let startMsgId = (chatRow?.last_message_id as number | null) ?? 0;

    const probeErrors: string[] = [];
    const tryProbe = async (withTopic: boolean): Promise<number | null> => {
      const probeBody: Record<string, unknown> = { chat_id: chatId, text: '🔍 Сканирование...' };
      if (withTopic && topicId != null) probeBody.message_thread_id = topicId;
      try {
        const probe = await fetch(`${tgApiBase()}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(probeBody),
          signal: AbortSignal.timeout(10000),
        });
        const probeJson = (await probe.json()) as {
          ok: boolean;
          result?: { message_id: number };
          description?: string;
          error_code?: number;
        };
        if (probeJson.ok && probeJson.result) {
          const mid = probeJson.result.message_id;
          void fetch(`${tgApiBase()}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: mid }),
          }).catch(() => {});
          return mid;
        }
        const tag = withTopic ? `topic ${topicId}` : 'no-topic';
        const msg = probeJson.description ?? `ok=false${probeJson.error_code ? ` (код ${probeJson.error_code})` : ''}`;
        probeErrors.push(`${tag}: ${msg}`);
        await logInfo('tg-scan.probe.fail', `Probe sendMessage failed for chat ${chatId} ${tag}`, {
          chatId, topicId: topicId ?? 0, withTopic, description: probeJson.description, errorCode: probeJson.error_code,
        });
        return null;
      } catch (err) {
        const tag = withTopic ? `topic ${topicId}` : 'no-topic';
        const msg = err instanceof Error ? err.message : 'сетевая ошибка';
        probeErrors.push(`${tag}: ${msg}`);
        await logInfo('tg-scan.probe.exception', `Probe sendMessage exception for chat ${chatId} ${tag}`, {
          chatId, topicId: topicId ?? 0, withTopic, error: msg,
        });
        return null;
      }
    };

    if (!startMsgId) {
      if (topicId != null) {
        startMsgId = (await tryProbe(true)) ?? 0;
        if (!startMsgId) {
          startMsgId = (await tryProbe(false)) ?? 0;
        }
      } else {
        startMsgId = (await tryProbe(false)) ?? 0;
      }
    }

    if (!startMsgId) {
      const hint = topicId != null
        ? 'Проверьте, что бот добавлен в группу как админ и имеет право писать в General и/или в выбранный подчат.'
        : 'Проверьте, что бот добавлен в группу и может отправлять сообщения.';
      const reason = probeErrors.length ? ` Причина: ${probeErrors.join('; ')}.` : '';
      throw new Error(`Не удалось отправить тестовое сообщение в чат для определения стартовой позиции.${reason} ${hint}`);
    }

    // Scan loop
    let videosFound = 0;
    let completed = 0;
    let errors = 0;
    let scanned = 0;
    // 'limited' scans keep the historic 2000-message ceiling — enough to find ~50 videos
    // in a typical chat without hammering Bot API. 'full' scans run until startMsgId
    // reaches 0 (or the user stops them); we use a very large but finite bound so the
    // loop counter still terminates even if startMsgId somehow misbehaves.
    const maxScan = scanMode === 'full' ? 10_000_000 : 2000;
    const videos: ScanVideoRow[] = [];
    let lastDbWrite = 0;

    const flushProgress = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastDbWrite < 3000) return;
      lastDbWrite = now;
      await updateJob(jobId, { scanned, videos_found: videosFound, completed, errors, videos });
    };

    const targetLabel = scanMode === 'full' ? 'whole chat' : `${videoCount} videos`;
    await logInfo('tg-transcribe.scan.start', `Scanning ${targetLabel} from msg#${startMsgId} in chat ${chatId}`, {
      chatId, startMsgId, videoCount: scanMode === 'full' ? null : videoCount, scanMode, topicId,
    });

    for (let msgId = startMsgId; msgId > 0 && videosFound < videoCount && scanned < maxScan; msgId--) {
      if (scanned % 20 === 0 && scanned > 0) {
        if (await isStopped(jobId)) {
          await flushProgress(true);
          return;
        }
      }

      scanned++;

      if (alreadyProcessed.has(msgId)) {
        videosFound++;
        completed++;
        continue;
      }

      if (scanned % 50 === 0) await flushProgress();

      let forwarded: TgMessage | null;
      try {
        forwarded = await forwardAndInspect(chatId, msgId);
      } catch {
        continue;
      }

      if (!forwarded) continue;

      const videoInfo = extractVideoInfo(forwarded);
      if (!videoInfo) continue;

      // For forum chats: probe to learn which topic the ORIGINAL message
      // belongs to. forwardMessage lands the bot's copy in General with
      // no source-thread info, so without detection we'd silently bucket
      // every video under topic_id=0. Skip the probe for non-forum chats
      // (one extra API call per video is wasted) and when topicId filter
      // is "no filter" on a non-forum chat (nothing to learn anyway).
      let resolvedTopicId: number | null = null;
      if (isForumChat || topicId != null) {
        resolvedTopicId = await detectTopicId(chatId, msgId);
        // null = probe failed. Treat as "unknown topic": when filter active,
        // skip (can't confirm match); when no filter, default to 0 so we
        // at least record the video under chat-level bucket.
        if (topicId != null) {
          if (resolvedTopicId == null) continue;
          // General-renamed quirk: when topic_id=1 in our DB actually points to
          // the General topic of a forum (the user added e.g. "Звонки с клиентами"
          // which was the renamed General), Bot API replies with no
          // message_thread_id on those messages, so detectTopicId resolves to 0
          // instead of 1. Without this union the legacy path would silently
          // skip every video in such topics (saw a real "0 found in 4692"
          // incident on prod). MTProto path handles this differently — see
          // runMtprotoForumScan.
          const matchesTopic =
            resolvedTopicId === topicId || (topicId === 1 && resolvedTopicId === 0);
          if (!matchesTopic) continue;
        }
      }

      videosFound++;

      const effectiveTopicId = resolvedTopicId ?? topicId ?? 0;
      const syntheticMsg: TgMessage = {
        ...forwarded,
        chat: { id: chatId },
        message_id: msgId,
        message_thread_id: effectiveTopicId || undefined,
      };

      const senderName = getSenderName(syntheticMsg);
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
        return;
      }

      if (errorMessageIds.has(msgId)) {
        await admin
          .from('tg_video_transcripts')
          .delete()
          .eq('tg_chat_id', chatId)
          .eq('tg_message_id', msgId);
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

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await logInfo('tg-transcribe.scan.done', `Scan complete: ${completed} transcribed, ${errors} errors, scanned ${scanned} messages`, {
      chatId, completed, errors, scanned, videosFound,
    });

    await updateJob(jobId, {
      status: 'completed',
      scanned,
      videos_found: videosFound,
      completed,
      errors,
      videos,
      finished_at: new Date().toISOString(),
    });
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
