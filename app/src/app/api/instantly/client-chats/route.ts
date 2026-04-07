import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const clientUserId = url.searchParams.get('client_user_id');

  let query = supabaseInstantly
    .from('client_telegram_chats')
    .select('*')
    .order('created_at', { ascending: false });

  if (clientUserId) {
    query = query.eq('client_user_id', clientUserId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
});

export const POST = withAuth(async (req, user) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = (await req.json()) as {
    client_user_id?: string;
    chat_id?: number;
    chat_title?: string;
  };

  if (!body.client_user_id || !body.chat_id) {
    return NextResponse.json(
      { error: 'client_user_id and chat_id are required' },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseInstantly
    .from('client_telegram_chats')
    .insert({
      client_user_id: body.client_user_id,
      chat_id: body.chat_id,
      chat_title: body.chat_title ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'This chat is already linked to this client' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
});

export const DELETE = withAuth(async (req) => {
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const { error } = await supabaseInstantly
    .from('client_telegram_chats')
    .delete()
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
});
