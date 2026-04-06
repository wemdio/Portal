import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  if (!supabaseInstantly || !supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');

  let clientUserIds: string[] = [];

  if (campaignId) {
    const { data: rows } = await supabaseInstantly
      .from('client_instantly_access')
      .select('client_user_id')
      .eq('resource_type', 'campaign')
      .eq('resource_id', campaignId);

    clientUserIds = [...new Set((rows ?? []).map((r: { client_user_id: string }) => r.client_user_id))];
  } else {
    const { data: rows } = await supabaseInstantly
      .from('client_instantly_access')
      .select('client_user_id')
      .eq('resource_type', 'campaign');

    clientUserIds = [...new Set((rows ?? []).map((r: { client_user_id: string }) => r.client_user_id))];
  }

  if (clientUserIds.length === 0) {
    return NextResponse.json({ clients: [] });
  }

  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', clientUserIds);

  const { data: chats } = await supabaseInstantly
    .from('client_telegram_chats')
    .select('client_user_id, chat_id, chat_title')
    .in('client_user_id', clientUserIds);

  const chatMap = new Map<string, { chat_id: number; chat_title: string | null }[]>();
  for (const ch of chats ?? []) {
    const arr = chatMap.get(ch.client_user_id) ?? [];
    arr.push({ chat_id: ch.chat_id, chat_title: ch.chat_title });
    chatMap.set(ch.client_user_id, arr);
  }

  const clients = (profiles ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    email: p.email,
    telegram_chats: chatMap.get(p.id) ?? [],
  }));

  return NextResponse.json({ clients });
});
