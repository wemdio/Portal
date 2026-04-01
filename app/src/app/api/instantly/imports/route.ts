import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const authClient = createAuthedSupabaseClient(token);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const { data, error } = await supabaseInstantly
    .from('instantly_lead_imports')
    .select('*')
    .eq('imported_by', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ items: data });
}

export async function POST(req: NextRequest) {
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const authClient = createAuthedSupabaseClient(token);
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  const body = await req.json();

  const { data, error } = await supabaseInstantly
    .from('instantly_lead_imports')
    .insert({
      project_id: body.project_id || null,
      campaign_id: body.campaign_id || null,
      campaign_name: body.campaign_name || null,
      lead_list_id: body.lead_list_id || null,
      lead_list_name: body.lead_list_name || null,
      leads_count: body.leads_count ?? 0,
      imported_by: user.id,
      tab_name: body.tab_name || null,
    })
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
