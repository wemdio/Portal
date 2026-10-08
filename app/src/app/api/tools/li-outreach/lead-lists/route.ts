import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, fetchOwnerNames } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const admin = supabaseAdmin;

    // Lead lists are shared by the whole team (08.10.2026): leads aren't
    // confidential, and lists of a specialist who left were otherwise lost to
    // everyone. `owner_name` only labels who created the list.
    const { data, error } = await admin
      .from('li_lead_lists')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);
    const lists = data ?? [];
    if (!lists.length) return NextResponse.json({ lead_lists: [] });

    const ownerMap = await fetchOwnerNames(lists.map((l) => l.user_id as string));
    const withCounts = await Promise.all(
      lists.map(async (list) => {
        const { count } = await admin
          .from('li_leads')
          .select('*', { head: true, count: 'exact' })
          .eq('lead_list_id', list.id);
        return { ...list, leads_count: count ?? 0, owner_name: ownerMap.get(list.user_id as string) ?? null };
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
