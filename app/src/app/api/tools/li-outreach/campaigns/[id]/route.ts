import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, checkIsAdmin, userOwnsAccount } from '@/lib/liOutreach/apiHelpers';
import { normalizeTimezoneOffset, normalizeWorkingHours } from '@/lib/liOutreach/schedule';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.getOne' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    // Cross-specialist visibility (view-only): any specialist can open any
    // campaign's detail. Mutations below (PUT/DELETE) still scope by user_id,
    // so a viewer can read a foreign launch but not change it.
    const { data, error } = await supabaseAdmin
      .from('li_campaigns')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return jsonError('Campaign not found', 404);
    return NextResponse.json({ campaign: data });
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;
    const admin = await checkIsAdmin(auth.user.id);

    let existQ = supabaseAdmin.from('li_campaigns').select('id').eq('id', id);
    if (!admin) existQ = existQ.eq('user_id', auth.user.id);
    const { data: existing } = await existQ.maybeSingle();
    if (!existing) return jsonError('Campaign not found', 404);

    const body = (await req.json()) as Record<string, unknown>;
    // Reassigning the campaign's LinkedIn account is only allowed to an account
    // the editor owns (accounts are visible cross-specialist but not usable).
    if (body.account_id && !(await userOwnsAccount(auth.user.id, String(body.account_id)))) {
      return jsonError('Нельзя привязать кампанию к LinkedIn-аккаунту другого специалиста', 403);
    }
    const allowed = [
      'name', 'account_id', 'lead_list_id', 'steps', 'use_ai', 'ai_prompt_invite', 'ai_prompt_chat',
      'stop_on_reply', 'min_delay', 'max_delay', 'daily_invite_limit', 'welcome_message',
      'message_existing_connections', 'use_ai_welcome', 'use_ai_followup', 'ai_model',
      'use_custom_invites',
    ];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) { if (key in body) patch[key] = body[key]; }
    // working_hours / timezone_offset go through the shared normalizers so
    // garbage values can't reach the DB (the runner regex-matches each entry).
    if ('working_hours' in body) {
      const hours = normalizeWorkingHours(body.working_hours);
      if (hours !== null) patch.working_hours = hours;
    }
    if ('timezone_offset' in body) {
      patch.timezone_offset = normalizeTimezoneOffset(body.timezone_offset);
    }

    const { error } = await supabaseAdmin
      .from('li_campaigns')
      .update(patch)
      .eq('id', id);
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
    const admin = await checkIsAdmin(auth.user.id);

    let existQ = supabaseAdmin.from('li_campaigns').select('id').eq('id', id);
    if (!admin) existQ = existQ.eq('user_id', auth.user.id);
    const { data: existing } = await existQ.maybeSingle();
    if (!existing) return jsonError('Campaign not found', 404);

    const { error } = await supabaseAdmin
      .from('li_campaigns')
      .delete()
      .eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
