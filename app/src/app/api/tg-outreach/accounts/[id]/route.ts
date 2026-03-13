import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

export const GET = withTgOutreachAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  const { data, error } = await supabase
    .from('tg_pool_accounts')
    .select(`
      *,
      proxy:tg_pool_proxies(id, ip, port, type),
      tg_pool_account_tags(tag_id, tg_pool_tags(*))
    `)
    .eq('id', id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  const junctions = (data.tg_pool_account_tags ?? []) as Array<{ tg_pool_tags: unknown }>;
  return NextResponse.json({
    ...data,
    tags: junctions.map((j) => j.tg_pool_tags).filter(Boolean),
    tg_pool_account_tags: undefined,
  });
});

export const PATCH = withTgOutreachAuth(async (req, { supabase }, params) => {
  const id = params?.id;
  const body = await req.json();

  const allowedFields = [
    'first_name', 'last_name', 'username', 'bio', 'avatar_url',
    'proxy_id', 'status', 'account_price', 'notes', 'phone',
    'format', 'session_data',
    'max_invites_per_day', 'max_messages_per_day', 'max_chat_messages_per_day',
    'max_contact_adds_per_day', 'max_story_views_per_day',
    'max_neurocomment_posts_per_day', 'control_tg_request_limit',
  ];

  const updateFields: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (body[key] !== undefined) updateFields[key] = body[key];
  }
  updateFields.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('tg_pool_accounts')
    .update(updateFields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (body.tag_ids !== undefined) {
    await supabase.from('tg_pool_account_tags').delete().eq('account_id', id);
    if (body.tag_ids.length) {
      await supabase.from('tg_pool_account_tags').insert(
        body.tag_ids.map((tag_id: string) => ({ account_id: id, tag_id })),
      );
    }
  }

  return NextResponse.json(data);
});

export const DELETE = withTgOutreachAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  const { error } = await supabase.from('tg_pool_accounts').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
});
