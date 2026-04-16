import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
    const { id } = await ctx.params;

    const { data: campaign } = await supabaseAdmin
      .from('li_campaigns')
      .select('id,status,lead_list_id')
      .eq('id', id)
      .single<{ id: string; status: string; lead_list_id: string | null }>();
    if (!campaign) return jsonError('Campaign not found', 404);
    if (campaign.status === 'running') return jsonError('Already running', 400);

    if (campaign.lead_list_id) {
      const { data: leads } = await supabaseAdmin
        .from('li_leads')
        .select('id')
        .eq('lead_list_id', campaign.lead_list_id)
        .limit(5000);

      for (const lead of leads ?? []) {
        await supabaseAdmin.from('li_campaign_leads').upsert(
          { campaign_id: id, lead_id: (lead as { id: string }).id, current_step: 0, status: 'pending' },
          { onConflict: 'campaign_id,lead_id' },
        );
      }
    }

    // Set status to running
    await supabaseAdmin
      .from('li_campaigns')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', id);

    return NextResponse.json({ ok: true });
  });
}
