import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const url = new URL(req.url);
      const campaignId = url.searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const status = url.searchParams.get('status');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

      let query = auth.supabase
        .from('tg_outreach_dialogs')
        .select('*', { count: 'exact' })
        .eq('campaign_id', campaignId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error, count } = await query;
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ items: data ?? [], total: count ?? 0 });
    },
  );
}
