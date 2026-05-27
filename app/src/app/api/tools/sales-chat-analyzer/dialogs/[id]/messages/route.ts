import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const url = req.nextUrl;
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_messages')
    .select('id,dialog_id,tg_message_id,direction,sender_tg_id,sender_name,text,media_type,sent_at')
    .eq('dialog_id', id)
    .order('sent_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = data ?? [];
  // ВАЖНО: запрашиваем вложения по dialog_id, а НЕ через .in('message_id', [...uuids]).
  // При больших диалогах список UUID превышал nginx-лимит на длину URL (8 KB) и
  // PostgREST возвращал 414 Request-URI Too Large. На sales_chat_message_attachments
  // есть индекс (dialog_id, tg_message_id), запрос быстрый.
  const { data: attachments, error: attachError } = await supabaseAdmin!
    .from('sales_chat_message_attachments')
    .select('id,message_id,tg_message_id,media_type,file_name,mime_type,file_size_bytes,status,error_message')
    .eq('dialog_id', id);
  if (attachError) return NextResponse.json({ error: attachError.message }, { status: 500 });

  const byMessage = new Map<string, unknown[]>();
  for (const attachment of attachments ?? []) {
    const messageId = (attachment as { message_id?: string }).message_id;
    if (!messageId) continue;
    const list = byMessage.get(messageId) ?? [];
    list.push(attachment);
    byMessage.set(messageId, list);
  }

  return NextResponse.json({
    messages: messages.map((m) => ({ ...m, attachments: byMessage.get(m.id) ?? [] })),
  });
}
