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
  return NextResponse.json({ messages: data ?? [] });
}
