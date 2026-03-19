import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const GET = withCopilotAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data, error } = await supabase
    .from('sales_copilot_configs')
    .select('*, account:tg_pool_accounts(id, phone, first_name, last_name, username, status, avatar_url)')
    .eq('id', id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json(data);
});

export const PATCH = withCopilotAuth(async (req, { supabase }, params) => {
  const id = params?.id;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const body = await req.json();
  delete body.id;
  delete body.user_id;
  delete body.account_id;
  delete body.created_at;
  body.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('sales_copilot_configs')
    .update(body)
    .eq('id', id)
    .select('*, account:tg_pool_accounts(id, phone, first_name, last_name, username, status, avatar_url)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
});

export const DELETE = withCopilotAuth(async (_req, { supabase }, params) => {
  const id = params?.id;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await supabase
    .from('sales_copilot_configs')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
});
