import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.logs' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
    const campaignId = url.searchParams.get('campaign_id');
    const level = url.searchParams.get('level');

    const { data: userCampaigns } = await auth.supabase
      .from('li_campaigns')
      .select('id')
      .eq('user_id', auth.user.id);
    const campaignIds = (userCampaigns ?? []).map((c) => c.id);
    if (campaignIds.length === 0) {
      return NextResponse.json({ items: [], total: 0 });
    }

    let query = auth.supabase
      .from('li_campaign_logs')
      .select('*, campaign:li_campaigns!inner(name)', { count: 'exact' });

    if (campaignId) {
      if (!campaignIds.includes(campaignId)) return jsonError('Campaign not found', 404);
      query = query.eq('campaign_id', campaignId);
    } else {
      query = query.in('campaign_id', campaignIds);
    }

    if (level && ['info', 'warning', 'error'].includes(level)) {
      query = query.eq('level', level);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ items: data ?? [], total: count ?? 0 });
  });
}
