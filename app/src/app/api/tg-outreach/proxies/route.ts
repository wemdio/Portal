import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

export const GET = withTgOutreachAuth(async (_req, { supabase }) => {
  const { data: proxies, error } = await supabase
    .from('tg_pool_proxies')
    .select('*, tg_pool_proxy_tags(tag_id, tg_pool_tags(*))')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (proxies ?? []).map((p: Record<string, unknown>) => {
    const junctions = (p.tg_pool_proxy_tags ?? []) as Array<{ tg_pool_tags: unknown }>;
    return {
      ...p,
      tags: junctions.map((j) => j.tg_pool_tags).filter(Boolean),
      tg_pool_proxy_tags: undefined,
    };
  });

  return NextResponse.json({ items });
});

export const POST = withTgOutreachAuth(async (req, { supabase, userId }) => {
  const body = await req.json();

  const { data: proxy, error } = await supabase
    .from('tg_pool_proxies')
    .insert({
      ip: body.ip,
      port: Number(body.port),
      login: body.login ?? '',
      password: body.password ?? '',
      type: body.type ?? 'HTTP',
      notes: body.notes ?? '',
      created_by: userId,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (body.tag_ids?.length) {
    await supabase.from('tg_pool_proxy_tags').insert(
      body.tag_ids.map((tag_id: string) => ({ proxy_id: proxy.id, tag_id })),
    );
  }

  return NextResponse.json(proxy, { status: 201 });
});
