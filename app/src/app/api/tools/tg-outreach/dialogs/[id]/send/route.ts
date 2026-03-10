import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import type { DialogMessage } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { supabase } = auth;
  const { id } = await ctx.params;

  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError('Неверный JSON', 400);
  }

  const messageText = body.message?.trim();
  if (!messageText) return jsonError('message обязателен', 400);

  const { data: dialog, error: dErr } = await supabase
    .from('tg_outreach_dialogs')
    .select('*')
    .eq('id', id)
    .single();

  if (dErr || !dialog) return jsonError('Диалог не найден', 404);

  const newMsg: DialogMessage = {
    role: 'assistant',
    content: messageText,
    timestamp: new Date().toISOString(),
  };

  const messages = [...(dialog.messages as DialogMessage[]), newMsg];

  const { data, error } = await supabase
    .from('tg_outreach_dialogs')
    .update({ messages, last_message_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}
