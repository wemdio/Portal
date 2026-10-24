import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { logCampaignEvent } from '@/lib/liOutreach/campaignLog';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

// Lists are shared by the team (08.10.2026): anyone may rename or delete any
// list, whoever created it. The admin client is needed because RLS on
// li_lead_lists is still owner-only.

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;
    const body = (await req.json()) as { name?: string; description?: string; campaign_id?: string | null };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name) patch.name = body.name;
    if ('description' in body) patch.description = body.description;
    // Перенос базы в другую кампанию (null — открепить).
    if ('campaign_id' in body) patch.campaign_id = body.campaign_id || null;
    // Порядок в очереди кампании: задаётся стрелками на вкладке «Базы».
    if (typeof (body as { queue_position?: unknown }).queue_position === 'number') {
      patch.queue_position = (body as { queue_position: number }).queue_position;
    }
    const { error } = await supabaseAdmin.from('li_lead_lists').update(patch).eq('id', id);
    if (error) return jsonError(error.message, 500);

    const { data: list } = await supabaseAdmin.from('li_lead_lists').select('name, campaign_id, queue_position').eq('id', id).maybeSingle();
    const campaignId = (list?.campaign_id as string | null) ?? null;
    const actor = auth.user.email ?? null;
    if ('campaign_id' in body && campaignId) {
      await logCampaignEvent(supabaseAdmin, campaignId, 'info', `База «${list?.name}» добавлена в кампанию, место в очереди: ${list?.queue_position ?? '—'}`, actor);
    } else if (typeof patch.queue_position === 'number' && campaignId) {
      await logCampaignEvent(supabaseAdmin, campaignId, 'info', `Очередь баз изменена: «${list?.name}» теперь на месте ${patch.queue_position}`, actor);
    } else if (body.name && campaignId) {
      await logCampaignEvent(supabaseAdmin, campaignId, 'info', `База переименована: «${body.name}»`, actor);
    }
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.lead-lists.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;
    const { data: list } = await supabaseAdmin.from('li_lead_lists').select('name, campaign_id').eq('id', id).maybeSingle();
    const { count } = await supabaseAdmin.from('li_leads').select('id', { count: 'exact', head: true }).eq('lead_list_id', id);
    const { error } = await supabaseAdmin.from('li_lead_lists').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    await logCampaignEvent(supabaseAdmin, (list?.campaign_id as string | null) ?? null, 'warning', `База «${list?.name}» удалена вместе с людьми (${count ?? 0})`, auth.user.email ?? null);
    return NextResponse.json({ ok: true });
  });
}
