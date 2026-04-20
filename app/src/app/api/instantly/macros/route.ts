import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, user) => {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { data, error } = await supabaseAdmin
    .from('user_reply_macros')
    .select('id, title, body, sort_order')
    .eq('user_id', user.id)
    .order('sort_order')
    .order('created_at');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ macros: data ?? [] });
});

export const POST = withAuth(async (req, user) => {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await req.json() as { title?: string; body?: string };
  if (!body.title?.trim() || !body.body?.trim()) {
    return NextResponse.json({ error: 'title и body обязательны' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('user_reply_macros')
    .insert({
      user_id: user.id,
      title: body.title.trim(),
      body: body.body.trim(),
    })
    .select('id, title, body, sort_order')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ macro: data });
});

export const DELETE = withAuth(async (req, user) => {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('user_reply_macros')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
});
