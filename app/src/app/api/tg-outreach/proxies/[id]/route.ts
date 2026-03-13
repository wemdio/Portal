import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

export const GET = withTgOutreachAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  const { data, error } = await supabase
    .from('tg_pool_proxies')
    .select('*, tg_pool_proxy_tags(tag_id, tg_pool_tags(*))')
    .eq('id', id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  const junctions = (data.tg_pool_proxy_tags ?? []) as Array<{ tg_pool_tags: unknown }>;
  return NextResponse.json({
    ...data,
    tags: junctions.map((j) => j.tg_pool_tags).filter(Boolean),
    tg_pool_proxy_tags: undefined,
  });
});

export const PATCH = withTgOutreachAuth(async (req, { supabase }, params) => {
  const id = params?.id;
  const body = await req.json();

  const updateFields: Record<string, unknown> = {};
  for (const key of ['ip', 'port', 'login', 'password', 'type', 'notes']) {
    if (body[key] !== undefined) updateFields[key] = key === 'port' ? Number(body[key]) : body[key];
  }
  updateFields.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('tg_pool_proxies')
    .update(updateFields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (body.tag_ids !== undefined) {
    await supabase.from('tg_pool_proxy_tags').delete().eq('proxy_id', id);
    if (body.tag_ids.length) {
      await supabase.from('tg_pool_proxy_tags').insert(
        body.tag_ids.map((tag_id: string) => ({ proxy_id: id, tag_id })),
      );
    }
  }

  return NextResponse.json(data);
});

export const DELETE = withTgOutreachAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  const { error } = await supabase.from('tg_pool_proxies').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
});
