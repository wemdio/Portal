import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.campaigns.logs' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Admin client not configured', 500);
    const { id } = await ctx.params;

    const { data: campaign } = await supabaseAdmin
      .from('li_campaigns')
      .select('id')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!campaign) return jsonError('Campaign not found', 404);

    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
    const level = url.searchParams.get('level');

    let query = supabaseAdmin
      .from('li_campaign_logs')
      .select('*', { count: 'exact' })
      .eq('campaign_id', id);

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
