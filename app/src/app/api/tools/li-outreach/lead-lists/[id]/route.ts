import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const body = (await req.json()) as { name?: string; description?: string };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name) patch.name = body.name;
    if ('description' in body) patch.description = body.description;
    const { error } = await auth.supabase.from('li_lead_lists').update(patch).eq('id', id).eq('user_id', auth.user.id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const { error } = await auth.supabase.from('li_lead_lists').delete().eq('id', id).eq('user_id', auth.user.id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
