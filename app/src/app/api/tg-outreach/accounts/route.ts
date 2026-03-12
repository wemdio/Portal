import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

export const GET = withTgOutreachAuth(async (_req, { supabase }) => {
  const { data: accounts, error } = await supabase
    .from('tg_outreach_accounts')
    .select(`
      *,
      proxy:tg_outreach_proxies(id, ip, port, type),
      tg_outreach_account_tags(tag_id, tg_outreach_tags(*))
    `)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (accounts ?? []).map((a: Record<string, unknown>) => {
    const junctions = (a.tg_outreach_account_tags ?? []) as Array<{ tg_outreach_tags: unknown }>;
    return {
      ...a,
      tags: junctions.map((j) => j.tg_outreach_tags).filter(Boolean),
      tg_outreach_account_tags: undefined,
    };
  });

  return NextResponse.json({ items });
});

export const POST = withTgOutreachAuth(async (req, { supabase, userId }) => {
  const body = await req.json();

  const { data: account, error } = await supabase
    .from('tg_outreach_accounts')
    .insert({
      format: body.format ?? 'session_json',
      session_data: body.session_data ?? {},
      phone: body.phone ?? '',
      first_name: body.first_name ?? '',
      last_name: body.last_name ?? '',
      username: body.username ?? '',
      bio: body.bio ?? '',
      proxy_id: body.proxy_id ?? null,
      notes: body.notes ?? '',
      created_by: userId,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (body.tag_ids?.length) {
    await supabase.from('tg_outreach_account_tags').insert(
      body.tag_ids.map((tag_id: string) => ({ account_id: account.id, tag_id })),
    );
  }

  return NextResponse.json(account, { status: 201 });
});
