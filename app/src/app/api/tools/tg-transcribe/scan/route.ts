import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
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
import { logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface TgChatFull {
  id: number;
  title?: string;
  type?: string;
}

async function getChatInfo(chatId: number): Promise<TgChatFull | null> {
  try {
    const res = await fetch(`${tgApiBase()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { ok: boolean; result?: TgChatFull; description?: string };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

async function forwardAndInspect(
  chatId: number,
  messageId: number,
): Promise<TgMessage | null> {
  const res = await fetch(`${tgApiBase()}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      from_chat_id: chatId,
      message_id: messageId,
    }),
  });

  const json = (await res.json()) as { ok: boolean; result?: TgMessage; description?: string };
  if (!json.ok || !json.result) return null;

  const forwarded = json.result;

  void fetch(`${tgApiBase()}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: forwarded.message_id,
    }),
  }).catch(() => {});

  return forwarded;
}

/**
 * POST /api/tools/tg-transcribe/scan
 *
 * Body: { chatId: number, videoCount: number }
 * Scans backwards from the latest message to find `videoCount` videos.
 * Streams NDJSON progress.
 */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  if (!TG_TOKEN) return jsonError('TG_TRANSCRIBE_BOT_TOKEN не настроен', 500);
  if (!supabaseAdmin) return jsonError('Supabase admin не настроен', 500);

  await ensureTgApiReady();

  let body: { chatId?: number; videoCount?: number };
  try {
    body = await req.json();
  } catch {
    return jsonError('Неверный JSON', 400);
  }

  const chatId = body.chatId;
  const videoCount = Math.min(Math.max(body.videoCount ?? 5, 1), 50);

  if (!chatId) {
    return jsonError('Необходим chatId', 400);
  }

  const chatInfo = await getChatInfo(chatId);
  if (chatInfo) {
    void upsertBotChat(chatInfo.id, chatInfo.title ?? '', chatInfo.type ?? 'group');
  }

  const { data: existing } = await supabaseAdmin
    .from('tg_video_transcripts')
    .select('tg_message_id, status')
    .eq('tg_chat_id', chatId);

  const alreadyProcessed = new Set(
    (existing ?? []).filter((r) => r.status !== 'error').map((r) => Number(r.tg_message_id)),
  );
  const errorMessageIds = new Set(
    (existing ?? []).filter((r) => r.status === 'error').map((r) => Number(r.tg_message_id)),
  );

  const { data: chatRow } = await supabaseAdmin
    .from('tg_bot_chats')
    .select('last_message_id')
    .eq('chat_id', chatId)
    .single();

  let startMsgId = (chatRow?.last_message_id as number | null) ?? 0;

  if (!startMsgId) {
    try {
      const probe = await fetch(`${tgApiBase()}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '🔍 Сканирование...' }),
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
    return jsonError('Не удалось определить последнее сообщение. Telegram API недоступен. Попробуйте позже или включите VPN.', 500);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      };

      let videosFound = 0;
      let completed = 0;
      let errors = 0;
      let scanned = 0;
      const maxScan = 2000;

      await logInfo('tg-transcribe.scan.start', `Scanning for ${videoCount} videos from msg#${startMsgId} in chat ${chatId}`, {
        chatId, startMsgId, videoCount, userId: user!.id,
      });

      for (let msgId = startMsgId; msgId > 0 && videosFound < videoCount && scanned < maxScan; msgId--) {
        scanned++;

        if (alreadyProcessed.has(msgId)) {
          videosFound++;
          completed++;
          send({ type: 'progress', scanned, videosFound, videoCount, completed, errors });
          continue;
        }

        let forwarded: TgMessage | null;
        try {
          forwarded = await forwardAndInspect(chatId, msgId);
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
          message_id: msgId,
        };

        const senderName = getSenderName(syntheticMsg);

        if (errorMessageIds.has(msgId)) {
          await supabaseAdmin
            .from('tg_video_transcripts')
            .delete()
            .eq('tg_chat_id', chatId)
            .eq('tg_message_id', msgId);
        }

        try {
          const result = await processVideoMessage(syntheticMsg, videoInfo);
          if (result.status === 'completed') {
            completed++;
          } else {
            errors++;
          }
          send({
            type: 'progress',
            scanned,
            videosFound,
            videoCount,
            completed,
            errors,
            lastSender: senderName,
            lastStatus: result.status,
          });
        } catch (err) {
          await saveErrorRecord(syntheticMsg, videoInfo, err);
          errors++;
          send({
            type: 'progress',
            scanned,
            videosFound,
            videoCount,
            completed,
            errors,
            lastSender: senderName,
            lastStatus: 'error',
            lastError: err instanceof Error ? err.message : 'Неизвестная ошибка',
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      await logInfo('tg-transcribe.scan.done', `Scan complete: ${completed} transcribed, ${errors} errors, scanned ${scanned} messages`, {
        chatId, completed, errors, scanned, videosFound,
      });

      send({ type: 'done', completed, errors, videosFound, scanned });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
}
