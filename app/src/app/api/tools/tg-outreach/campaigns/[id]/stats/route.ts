import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.stats.get' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { supabase } = auth;
        const { id } = await ctx.params;
      
        const [dialogsRes, processedRes, accountsRes, campaignRes] = await Promise.all([
          supabase.from('tg_outreach_dialogs').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
          supabase.from('tg_outreach_processed').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
          supabase.from('tg_outreach_accounts').select('id', { count: 'exact', head: true }).eq('campaign_id', id).eq('is_active', true),
          supabase.from('tg_outreach_campaigns').select('status, updated_at').eq('id', id).single(),
        ]);
      
        if (campaignRes.error) return jsonError('Кампания не найдена', 404);
      
        return NextResponse.json({
          campaign_id: id,
          total_dialogs: dialogsRes.count ?? 0,
          total_processed: processedRes.count ?? 0,
          active_accounts: accountsRes.count ?? 0,
          status: campaignRes.data.status,
          last_activity: campaignRes.data.updated_at,
        });
    },
  );
}
