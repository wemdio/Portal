import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { blockNonInternal } from '@/lib/ai-caller/requireInternal';
import { pickRecordingUrl } from '@/lib/vapi';

export const dynamic = 'force-dynamic';

const TG_TOKEN = process.env.AI_CALLER_TG_BOT_TOKEN ?? '';
const VAPI_KEY = process.env.VAPI_API_KEY ?? '';

/** POST — отправить информацию о лиде в Telegram чат */
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

  let body: {
    chatId: number;
    vapiCallId?: string;
    phone?: string;
    company?: string;
    contactName?: string;
    email?: string;
    extra?: Record<string, string>;
    outcome?: string;
    interestLevel?: number;
    summary?: string;
    nextAction?: string;
    keyPoints?: string[];
    callDate?: string;
    recordingUrl?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.chatId) {
    return NextResponse.json({ error: 'chatId required' }, { status: 400 });
  }

  // Resolve recording URL
  let recordingUrl = body.recordingUrl || '';
  if (!recordingUrl && body.vapiCallId && VAPI_KEY) {
    try {
      const vapiRes = await fetch(`https://api.vapi.ai/call/${body.vapiCallId}`, {
        headers: { Authorization: `Bearer ${VAPI_KEY}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (vapiRes.ok) {
        const vapiData = await vapiRes.json();
        recordingUrl = pickRecordingUrl(vapiData);
      }
    } catch { /* continue without audio */ }
  }

  // Build message text
  const outcomeLabels: Record<string, string> = {
    interested: '🟢 Заинтересован',
    callback: '🔵 Перезвонить',
    not_interested: '🔴 Не интересно',
    no_answer: '⚪ Без ответа',
    voicemail: '📞 Автоответчик',
    other: '⚪ Другое',
  };

  const lines: string[] = [];
  lines.push('📋 <b>Новый лид от AI Caller</b>');
  lines.push('');
  if (body.company) lines.push(`🏢 <b>Компания:</b> ${esc(body.company)}`);
  if (body.phone) lines.push(`📱 <b>Телефон:</b> ${esc(body.phone)}`);
  if (body.contactName) lines.push(`👤 <b>Контакт:</b> ${esc(body.contactName)}`);
  if (body.email) lines.push(`📧 <b>Email:</b> ${esc(body.email)}`);

  if (body.extra && Object.keys(body.extra).length > 0) {
    for (const [key, value] of Object.entries(body.extra)) {
      if (value) lines.push(`  • <b>${esc(key)}:</b> ${esc(value)}`);
    }
  }

  lines.push('');
  const outcomeStr = body.outcome ? (outcomeLabels[body.outcome] ?? body.outcome) : '—';
  lines.push(`<b>Результат:</b> ${outcomeStr}`);
  if (body.interestLevel !== undefined) lines.push(`<b>Интерес:</b> ${body.interestLevel}/10`);
  if (body.summary) lines.push(`<b>Резюме:</b> ${esc(body.summary)}`);

  if (body.keyPoints && body.keyPoints.length > 0) {
    lines.push('<b>Ключевые моменты:</b>');
    for (const kp of body.keyPoints) {
      lines.push(`  • ${esc(kp)}`);
    }
  }

  if (body.nextAction) {
    lines.push('');
    lines.push(`➡️ <b>Следующий шаг:</b> ${esc(body.nextAction)}`);
  }

  if (body.callDate) {
    lines.push('');
    lines.push(`🕐 ${esc(body.callDate)}`);
  }

  const fullText = lines.join('\n');

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: body.chatId,
        text: fullText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return NextResponse.json({ error: tgData.description || 'Telegram send failed' }, { status: 502 });
    }

    return NextResponse.json({ ok: true, messageId: tgData.result?.message_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
