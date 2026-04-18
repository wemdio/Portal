import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const admin = supabaseAdmin;

    const { data, error } = await admin
      .from('li_lead_lists')
      .select('*')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);
    const lists = data ?? [];
    if (!lists.length) return NextResponse.json({ lead_lists: [] });

    const withCounts = await Promise.all(
      lists.map(async (list) => {
        const { count } = await admin
          .from('li_leads')
          .select('*', { head: true, count: 'exact' })
          .eq('user_id', auth.user.id)
          .eq('lead_list_id', list.id);
        return { ...list, leads_count: count ?? 0 };
      }),
    );

    return NextResponse.json({ lead_lists: withCounts });
  });
}

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as { name?: string; description?: string };
    if (!body.name?.trim()) return jsonError('Name is required', 400);

    const { data, error } = await auth.supabase
      .from('li_lead_lists')
      .insert({ user_id: auth.user.id, name: body.name.trim(), description: body.description ?? null })
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ lead_list: data });
  });
}
