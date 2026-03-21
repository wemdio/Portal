import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.getOne' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const { data, error } = await auth.supabase.from('li_leads').select('*').eq('id', id).eq('user_id', auth.user.id).single();
    if (error) return jsonError('Lead not found', 404);
    return NextResponse.json({ lead: data });
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const body = (await req.json()) as Record<string, unknown>;
    const allowed = ['name', 'first_name', 'last_name', 'position', 'company', 'profile_url', 'lead_list_id', 'status'];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) { if (key in body) patch[key] = body[key]; }
    const { error } = await auth.supabase.from('li_leads').update(patch).eq('id', id).eq('user_id', auth.user.id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const { error } = await auth.supabase.from('li_leads').delete().eq('id', id).eq('user_id', auth.user.id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
