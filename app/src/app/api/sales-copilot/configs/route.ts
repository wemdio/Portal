import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const GET = withCopilotAuth(async (_req, { supabase }) => {
  const { data, error } = await supabase
    .from('sales_copilot_configs')
    .select('*, account:tg_pool_accounts(id, phone, first_name, last_name, username, status, avatar_url)')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data });
});

export const POST = withCopilotAuth(async (req, { supabase, userId }) => {
  const body = await req.json();

  const { data: existing } = await supabase
    .from('sales_copilot_configs')
    .select('id')
    .eq('account_id', body.account_id)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'Copilot для этого аккаунта уже настроен' }, { status: 409 });
  }

  const { data, error } = await supabase
    .from('sales_copilot_configs')
    .insert({ ...body, user_id: userId })
    .select('*, account:tg_pool_accounts(id, phone, first_name, last_name, username, status, avatar_url)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
});
