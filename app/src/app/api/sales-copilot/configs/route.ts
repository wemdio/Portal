import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const GET = withCopilotAuth(async (_req, { supabase }) => {
  const { data, error } = await supabase
    .from('sales_copilot_configs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data });
});

export const POST = withCopilotAuth(async (req, { supabase, userId }) => {
  const body = await req.json();

  const { data: existing } = await supabase
    .from('sales_copilot_configs')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'Copilot уже настроен для вашего аккаунта' }, { status: 409 });
  }

  const { data, error } = await supabase
    .from('sales_copilot_configs')
    .insert({ ...body, user_id: userId })
    .select('*')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
});
