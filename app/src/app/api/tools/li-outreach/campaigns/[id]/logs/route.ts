import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.logs' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;

    // Verify ownership
    const { data: campaign } = await auth.supabase
      .from('li_campaigns')
      .select('id')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!campaign) return jsonError('Campaign not found', 404);

    const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 100), 500);
    const { data, error } = await auth.supabase
      .from('li_campaign_logs')
      .select('*')
      .eq('campaign_id', id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ logs: data ?? [] });
  });
}
