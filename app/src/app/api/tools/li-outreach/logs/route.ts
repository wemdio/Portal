import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.logs' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
    const campaignId = url.searchParams.get('campaign_id');
    const level = url.searchParams.get('level');

    const ownedCampaignsRes = await supabaseAdmin
      .from('li_campaigns')
      .select('id, name')
      .eq('user_id', auth.user.id);
    if (ownedCampaignsRes.error) return jsonError(ownedCampaignsRes.error.message, 500);
    const ownedCampaigns = (ownedCampaignsRes.data ?? []) as Array<{ id: string; name: string }>;
    const ownedCampaignIds = ownedCampaigns.map((c) => c.id);

    if (campaignId && !ownedCampaignIds.includes(campaignId)) {
      return NextResponse.json({ items: [], total: 0 });
    }
    if (ownedCampaignIds.length === 0) {
      return NextResponse.json({ items: [], total: 0 });
    }

    let query = supabaseAdmin
      .from('li_campaign_logs')
      .select('*', { count: 'exact' })
      .in('campaign_id', campaignId ? [campaignId] : ownedCampaignIds);

    if (level && ['info', 'warning', 'error'].includes(level)) {
      query = query.eq('level', level);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return jsonError(error.message, 500);

    const logs = data ?? [];
    const campaignNames = new Map(ownedCampaigns.map((c) => [c.id, c.name]));
    const items = logs.map((l) => {
      const row = l as { campaign_id: string } & Record<string, unknown>;
      return { ...row, campaign: { name: campaignNames.get(row.campaign_id) ?? 'Unknown' } };
    });

    return NextResponse.json({ items, total: count ?? 0 });
  });
}
