import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.logs.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const url = new URL(req.url);
    const campaignId = url.searchParams.get('campaign_id');
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));

    let query = auth.supabase
      .from('li2_logs')
      .select('*')
      .eq('user_id', auth.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (campaignId) query = query.eq('campaign_id', campaignId);

    const { data, error } = await query;
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ logs: data ?? [] });
  });
}
