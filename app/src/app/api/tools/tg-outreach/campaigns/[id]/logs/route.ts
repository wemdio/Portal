import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.logs.get' },
    async () => {

        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;

        const url = new URL(req.url);
        // Ceiling raised to 5000 to accommodate the 6h-window default the UI
        // uses — at peak ~50 lines/hour per account × 20 accounts that's still
        // well under the cap, and Supabase happily streams 5k rows in one go.
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1), 5000);
        const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
        // Optional time-based filter: clients can pass `since=<ISO>` to fetch
        // only logs newer than that timestamp. The UI uses this to render a
        // rolling 6-hour window without paginating through ancient noise.
        const sinceRaw = url.searchParams.get('since');
        const sinceIso = sinceRaw && !Number.isNaN(new Date(sinceRaw).getTime())
          ? new Date(sinceRaw).toISOString()
          : null;

        // Фильтр по аккаунту. Колонку account_id заполняет прогрев (миграция
        // 20260803_0006); у боевых логов она пустая, поэтому фильтр работает
        // только там, где привязка действительно записана.
        const accountId = url.searchParams.get('account_id');

        let query = auth.supabase
          .from('tg_outreach_logs')
          .select('*', { count: 'exact' })
          .eq('campaign_id', id)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (sinceIso) query = query.gte('created_at', sinceIso);
        if (accountId) query = query.eq('account_id', accountId);

        const { data, error, count } = await query;

        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ items: data ?? [], total: count ?? 0, since: sinceIso });
    },
  );
}
