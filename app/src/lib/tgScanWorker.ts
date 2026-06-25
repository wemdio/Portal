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
async function detectTopicId(chatId: number, messageId: number): Promise<number> {
  const res = await fetch(`${tgApiBase()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '.',
      reply_parameters: { message_id: messageId },
    }),
  });

  const json = (await res.json()) as { ok: boolean; result?: TgMessage; description?: string };
  if (!json.ok || !json.result) {
    await logInfo('tg-scan.detectTopic.fail', `detectTopicId failed for msg ${messageId}`, {
      chatId, messageId, ok: json.ok, description: json.description,
    });
    return 0;
  }

  const threadId = json.result.message_thread_id ?? 0;

  await logInfo('tg-scan.detectTopic', `msg ${messageId} → topic ${threadId}`, {
    chatId, messageId, threadId,
  });

  void fetch(`${tgApiBase()}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: json.result.message_id }),
  }).catch(() => {});

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
      chatId, startMsgId, videoCount, topicId,
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

      // For forum topics: check the original message's topic via reply probe.
      // Only done for video messages to minimize API calls.
      if (topicId != null) {
        try {
          const msgTopicId = await detectTopicId(chatId, msgId);
          if (msgTopicId !== topicId) continue;
        } catch {
          continue;
        }
      }

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
