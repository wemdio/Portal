import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { blockNonInternal } from '@/lib/ai-caller/requireInternal';

export const dynamic = 'force-dynamic';

const TG_TOKEN = process.env.AI_CALLER_TG_BOT_TOKEN ?? '';
const VAPI_KEY = process.env.VAPI_API_KEY ?? '';

/** POST — send call recording as a voice message to Telegram */
export async function POST(req: NextRequest) {
  const blocked = await blockNonInternal(req);
  if (blocked) return blocked;

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!TG_TOKEN) {
    return NextResponse.json({ error: 'AI_CALLER_TG_BOT_TOKEN не настроен' }, { status: 500 });
  }

  let body: { chatId: number; vapiCallId: string; recordingUrl?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.chatId || !body.vapiCallId) {
    return NextResponse.json({ error: 'chatId and vapiCallId required' }, { status: 400 });
  }

  let recordingUrl = body.recordingUrl || '';
  if (!recordingUrl && VAPI_KEY) {
    try {
      const vapiRes = await fetch(`https://api.vapi.ai/call/${body.vapiCallId}`, {
        headers: { Authorization: `Bearer ${VAPI_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (vapiRes.ok) {
        const vapiData = await vapiRes.json();
        recordingUrl = vapiData.recordingUrl || vapiData.artifact?.recordingUrl || '';
      }
    } catch { /* continue */ }
  }

  if (!recordingUrl) {
    return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 });
  }

  try {
    const audioRes = await fetch(recordingUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audioRes.ok) {
      return NextResponse.json({ error: 'Не удалось скачать запись' }, { status: 502 });
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const caption = body.phone
      ? `🎙 Запись звонка: ${body.phone}`
      : '🎙 Запись звонка';

    const form = new FormData();
    form.append('chat_id', String(body.chatId));
    form.append('voice', new Blob([audioBuffer], { type: 'audio/ogg' }), 'recording.ogg');
    form.append('caption', caption);

    const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendVoice`, {
      method: 'POST',
      body: form,
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      const fallbackForm = new FormData();
      fallbackForm.append('chat_id', String(body.chatId));
      fallbackForm.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'recording.mp3');
      fallbackForm.append('caption', caption);
      fallbackForm.append('title', `Звонок ${body.phone || ''}`);

      const fallbackRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendAudio`, {
        method: 'POST',
        body: fallbackForm,
      });
      const fallbackData = await fallbackRes.json();

      if (!fallbackData.ok) {
        return NextResponse.json({ error: fallbackData.description || 'Telegram send failed' }, { status: 502 });
      }
      return NextResponse.json({ ok: true, messageId: fallbackData.result?.message_id });
    }

    return NextResponse.json({ ok: true, messageId: tgData.result?.message_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
