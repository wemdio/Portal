import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.getOne' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    const { data, error } = await supabaseAdmin
      .from('li_campaigns')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return jsonError('Campaign not found', 404);
    return NextResponse.json({ campaign: data });
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const body = (await req.json()) as Record<string, unknown>;
    const allowed = [
      'name', 'account_id', 'lead_list_id', 'steps', 'use_ai', 'ai_prompt_invite', 'ai_prompt_chat',
      'stop_on_reply', 'min_delay', 'max_delay', 'daily_invite_limit', 'welcome_message',
      'message_existing_connections', 'use_ai_welcome', 'use_ai_followup',
    ];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) { if (key in body) patch[key] = body[key]; }

    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { error } = await supabaseAdmin.from('li_campaigns').update(patch).eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    const { error } = await supabaseAdmin.from('li_campaigns').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
