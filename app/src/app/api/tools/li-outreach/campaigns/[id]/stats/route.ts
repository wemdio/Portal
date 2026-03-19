import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.stats' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    const { data: campaign } = await auth.supabase
      .from('li_campaigns')
      .select('id')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!campaign) return jsonError('Campaign not found', 404);

    const { data: stats } = await auth.supabase
      .from('li_campaign_step_stats')
      .select('*')
      .eq('campaign_id', id)
      .order('step_index', { ascending: true });

    const { data: leadStats } = await auth.supabase
      .from('li_campaign_leads')
      .select('status')
      .eq('campaign_id', id);

    const summary: Record<string, number> = {};
    for (const row of leadStats ?? []) {
      const s = (row as { status: string }).status;
      summary[s] = (summary[s] ?? 0) + 1;
    }

    return NextResponse.json({ step_stats: stats ?? [], lead_summary: summary });
  });
}
