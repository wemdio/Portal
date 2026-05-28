import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const url = new URL(req.url);
    const listId = url.searchParams.get('lead_list_id');
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    let q = supabaseAdmin
      .from('li_leads')
      .select('*', { count: 'exact' })
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false });

    if (listId === '__none') q = q.is('lead_list_id', null);
    else if (listId) q = q.eq('lead_list_id', listId);
    if (status) q = q.eq('status', status);
    if (search) q = q.or(`name.ilike.%${search}%,company.ilike.%${search}%,position.ilike.%${search}%`);

    const { data, count, error } = await q.range(offset, offset + limit - 1);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ leads: data ?? [], total: count ?? 0 });
  });
}

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as Record<string, unknown>;
    const { data, error } = await auth.supabase
      .from('li_leads')
      .insert({
        user_id: auth.user.id,
        lead_list_id: body.lead_list_id || null,
        linkedin_id: body.linkedin_id || null,
        public_identifier: body.public_identifier || null,
        profile_url: body.profile_url || null,
        name: String(body.name ?? ''),
        first_name: body.first_name || null,
        last_name: body.last_name || null,
        position: body.position || null,
        company: body.company || null,
        status: 'new',
      })
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ lead: data });
  });
}

export async function DELETE(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.bulkDelete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json()) as { ids?: string[] };
    if (!body.ids?.length) return jsonError('No IDs provided', 400);

    const { error } = await auth.supabase
      .from('li_leads')
      .delete()
      .eq('user_id', auth.user.id)
      .in('id', body.ids);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true, deleted: body.ids.length });
  });
}
