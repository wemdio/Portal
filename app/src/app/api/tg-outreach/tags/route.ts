import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

export const GET = withTgOutreachAuth(async (_req, { supabase }) => {
  const { data: tags, error } = await supabase
    .from('tg_outreach_tags')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: tags ?? [] });
});

export const POST = withTgOutreachAuth(async (req, { supabase, userId }) => {
  const body = await req.json();

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  const { data: tag, error } = await supabase
    .from('tg_outreach_tags')
    .insert({
      name: body.name.trim(),
      color: body.color ?? '#3b82f6',
      created_by: userId,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(tag, { status: 201 });
});
