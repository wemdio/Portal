import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  TG_TOKEN,
  tgApiBase,
  ensureTgApiReady,
  upsertBotChat,
  type TgMessage,
  type VideoInfo,
  extractVideoInfo,
  processVideoMessage,
  saveErrorRecord,
  getSenderName,
} from '@/lib/tgTranscribe';
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
}

interface TgChatFull {
  id: number;
  title?: string;
  type?: string;
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
  const videoCount: number = job.video_count;
  const topicId: number | null = job.topic_id ?? null;

  await updateJob(jobId, { status: 'running', started_at: new Date().toISOString() });

  try {
    if (!TG_TOKEN) throw new Error('TG_TRANSCRIBE_BOT_TOKEN не настроен');
    await ensureTgApiReady();

    const chatInfo = await getChatInfo(chatId);
    if (chatInfo) {
      void upsertBotChat(chatInfo.id, chatInfo.title ?? '', chatInfo.type ?? 'group');
    }

    // Load already-processed messages
    const { data: existing } = await admin
      .from('tg_video_transcripts')
      .select('tg_message_id, status')
      .eq('tg_chat_id', chatId);

    const alreadyProcessed = new Set(
      (existing ?? []).filter((r) => r.status !== 'error').map((r) => Number(r.tg_message_id)),
    );
    const errorMessageIds = new Set(
      (existing ?? []).filter((r) => r.status === 'error').map((r) => Number(r.tg_message_id)),
    );

    // Resolve start message ID
    const { data: chatRow } = await admin
      .from('tg_bot_chats')
      .select('last_message_id')
      .eq('chat_id', chatId)
      .single();

    let startMsgId = (chatRow?.last_message_id as number | null) ?? 0;

    if (!startMsgId) {
      const probeBody: Record<string, unknown> = { chat_id: chatId, text: '🔍 Сканирование...' };
      if (topicId != null) probeBody.message_thread_id = topicId;
      try {
        const probe = await fetch(`${tgApiBase()}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(probeBody),
          signal: AbortSignal.timeout(10000),
        });
        const probeJson = (await probe.json()) as { ok: boolean; result?: { message_id: number } };
        if (probeJson.ok && probeJson.result) {
          startMsgId = probeJson.result.message_id;
          void fetch(`${tgApiBase()}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: startMsgId }),
          }).catch(() => {});
        }
      } catch {
        // Telegram API недоступен
      }
    }

    if (!startMsgId) {
      throw new Error('Не удалось определить последнее сообщение. Telegram API недоступен.');
    }

    // Scan loop
    let videosFound = 0;
    let completed = 0;
    let errors = 0;
    let scanned = 0;
    const maxScan = 2000;
    const videos: ScanVideoRow[] = [];
    let lastDbWrite = 0;

    const flushProgress = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastDbWrite < 3000) return;
      lastDbWrite = now;
      await updateJob(jobId, { scanned, videos_found: videosFound, completed, errors, videos });
    };

    await logInfo('tg-transcribe.scan.start', `Scanning for ${videoCount} videos from msg#${startMsgId} in chat ${chatId}`, {
      chatId, startMsgId, videoCount,
    });

    for (let msgId = startMsgId; msgId > 0 && videosFound < videoCount && scanned < maxScan; msgId--) {
      // Cooperative cancellation check every 20 messages
      if (scanned % 20 === 0 && scanned > 0) {
        if (await isStopped(jobId)) {
          await flushProgress(true);
          return; // status already set by PATCH handler
        }
      }

      scanned++;

      if (alreadyProcessed.has(msgId)) {
        videosFound++;
        completed++;
        continue;
      }

      if (scanned % 50 === 0) {
        await flushProgress();
      }

      let forwarded: TgMessage | null;
      try {
        forwarded = await forwardAndInspect(chatId, msgId);
      } catch {
        continue;
      }

      if (!forwarded) continue;
      if (topicId != null && forwarded.message_thread_id !== topicId) continue;

      const videoInfo: VideoInfo | null = extractVideoInfo(forwarded);
      if (!videoInfo) continue;

      videosFound++;

      const syntheticMsg: TgMessage = {
        ...forwarded,
        chat: { id: chatId },
        message_id: msgId,
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

      // Check cancellation before processing each video
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
          }
          // Throttled DB write for download progress
          void flushProgress();
        });

        const v = videos.find((x) => x.idx === videoIdx);
        if (v) {
          v.phase = result.status === 'completed' ? 'done' : 'error';
          if (result.error) v.error = result.error;
        }

        if (result.status === 'completed') {
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
 */
export async function markStaleJobs(): Promise<void> {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
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
