import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

export const PATCH = withTgOutreachAuth(async (req, { supabase }, params) => {
  const id = params?.id;
  const body = await req.json();

  const updateFields: Record<string, unknown> = {};
  if (body.name !== undefined) updateFields.name = body.name.trim();
  if (body.color !== undefined) updateFields.color = body.color;

  const { data, error } = await supabase
    .from('tg_outreach_tags')
    .update(updateFields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
});

export const DELETE = withTgOutreachAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  const { error } = await supabase.from('tg_outreach_tags').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
});
