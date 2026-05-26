import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isTechnician } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isTechnician((profile?.role ?? null) as UserRole | null)) {
    return jsonError('Forbidden', 403);
  }

  const search = new URL(req.url).searchParams.get('q') ?? '';

  let query = supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('role', 'client')
    .order('full_name', { ascending: true })
    .limit(30);

  if (search.trim()) {
    query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return jsonError('Failed to load clients', 500);

  const clientIds = (data ?? []).map((c: { id: string }) => c.id);

  let tariffMap: Record<string, { tariff_type: string; paid_until: string | null; paid_at: string | null; setup_until: string | null; is_active: boolean; billing_period: string | null; billing_amount: number | null }> = {};
  if (clientIds.length > 0) {
    const { data: tariffs } = await supabaseAdmin
      .from('client_tariffs')
      .select('user_id, tariff_type, paid_until, paid_at, setup_until, is_active, billing_period, billing_amount')
      .in('user_id', clientIds);
    for (const t of tariffs ?? []) {
      tariffMap[t.user_id] = t;
    }
  }

  const clients = (data ?? []).map((c: { id: string; full_name: string | null; email: string | null }) => ({
    ...c,
    tariff: tariffMap[c.id] ?? null,
  }));

  return NextResponse.json({ clients });
}
