import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, checkIsAdmin } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { id } = await ctx.params;
    const admin = await checkIsAdmin(auth.user.id);

    let campQ = supabaseAdmin
      .from('li_campaigns')
      .select('id,status,lead_list_id,user_id')
      .eq('id', id);
    if (!admin) campQ = campQ.eq('user_id', auth.user.id);

    const { data: campaign } = await campQ
      .maybeSingle<{ id: string; status: string; lead_list_id: string | null; user_id: string }>();
    if (!campaign) return jsonError('Campaign not found', 404);
    if (campaign.status === 'running') return jsonError('Already running', 400);

    if (campaign.lead_list_id) {
      const { data: leads } = await supabaseAdmin
        .from('li_leads')
        .select('id')
        .eq('user_id', campaign.user_id)
        .eq('lead_list_id', campaign.lead_list_id)
        .limit(5000);

      // IMPORTANT: ignoreDuplicates=true ensures we ONLY insert new (campaign_id, lead_id)
      // pairs and NEVER touch existing rows. Without this, every Start press would roll
      // back current_step/status to 0/pending for leads already in waiting/in_progress —
      // which sends them another invite and gets us `already_invited` storms from LinkedIn.
      // See bug log Apr 2026: leads stuck cycling for 4 days.
      for (const lead of leads ?? []) {
        await supabaseAdmin.from('li_campaign_leads').upsert(
          { campaign_id: id, lead_id: (lead as { id: string }).id, current_step: 0, status: 'pending' },
          { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true },
        );
      }
    }

    const { error: updErr } = await supabaseAdmin
      .from('li_campaigns')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updErr) return jsonError(`Не удалось перевести кампанию в статус «запущена» — ${updErr.message}`, 500);

    // Record the lifecycle transition in the per-campaign log so the operator
    // sees in the Logs tab who started the campaign and when, alongside the
    // runtime events that follow.
    await supabaseAdmin.from('li_campaign_logs').insert({
      campaign_id: id,
      level: 'info',
      message: `Кампания запущена пользователем (UI «Старт»). Дальше воркер сам будет тикать каждые ~5 минут.`,
    });

    return NextResponse.json({ ok: true });
  });
}
