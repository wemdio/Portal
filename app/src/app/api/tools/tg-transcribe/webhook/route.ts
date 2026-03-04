import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  TG_TOKEN,
  ensureTgApiReady,
  type TgMessage,
  extractVideoInfo,
  processVideoMessage,
  saveErrorRecord,
  upsertBotChat,
} from '@/lib/tgTranscribe';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!TG_TOKEN) {
    return NextResponse.json({ ok: true });
  }

  await ensureTgApiReady();

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = (update.message ?? update.channel_post) as (TgMessage & { chat: { id: number; title?: string; type?: string } }) | undefined;
  if (!msg) {
    return NextResponse.json({ ok: true });
  }

  void upsertBotChat(msg.chat.id, msg.chat.title ?? '', msg.chat.type ?? 'group', msg.message_id);

  const videoInfo = extractVideoInfo(msg);
  if (!videoInfo) {
    return NextResponse.json({ ok: true });
  }

  try {
    await processVideoMessage(msg, videoInfo);
  } catch (err) {
    await saveErrorRecord(msg, videoInfo, err);
  }

  return NextResponse.json({ ok: true });
}
