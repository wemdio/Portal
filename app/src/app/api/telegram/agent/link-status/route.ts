import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ linked: false });

  const { data } = await supabaseAdmin
    .from('telegram_links')
    .select('telegram_id, telegram_username, telegram_first_name, telegram_last_name')
    .eq('user_id', user.id)
    .maybeSingle();

  return NextResponse.json({
    linked: !!data,
    telegram_id: data?.telegram_id ?? null,
    telegram_username: data?.telegram_username ?? null,
    telegram_first_name: data?.telegram_first_name ?? null,
    telegram_last_name: data?.telegram_last_name ?? null,
  });
}

export async function DELETE(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  await supabaseAdmin
    .from('telegram_links')
    .delete()
    .eq('user_id', user.id);

  return NextResponse.json({ ok: true, linked: false });
}
