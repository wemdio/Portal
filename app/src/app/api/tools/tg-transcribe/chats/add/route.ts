import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { tgApiBase, ensureTgApiReady, upsertBotChat } from '@/lib/tgTranscribe';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { chatId?: number; title?: string; topicId?: number; topicName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });
  }

  const chatId = body.chatId;
  if (!chatId) {
    return NextResponse.json({ error: 'Необходим chatId' }, { status: 400 });
  }

  await ensureTgApiReady();

  let title = body.title ?? '';
  let chatType = 'group';
  let isForum = false;

  try {
    const res = await fetch(`${tgApiBase()}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(5000),
    });

    const json = (await res.json()) as {
      ok: boolean;
      result?: { id: number; title?: string; type?: string; is_forum?: boolean };
    };

    if (json.ok && json.result) {
      title = json.result.title ?? title;
      chatType = json.result.type ?? chatType;
      isForum = json.result.is_forum ?? false;
    }
  } catch {
    // Telegram API unavailable — save with what we have
  }

  if (!title) title = `Chat ${chatId}`;

  const topicId = body.topicId ?? null;
  const topicName = body.topicName ?? null;

  const displayTitle = topicName ? `${title} → ${topicName}` : title;

  await upsertBotChat(chatId, displayTitle, chatType, undefined, isForum, topicId, topicName);

  return NextResponse.json({
    chat: { chatId, title: displayTitle, chatType, isForum, topicId, topicName },
  });
}
