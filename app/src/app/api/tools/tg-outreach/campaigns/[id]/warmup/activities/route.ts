import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Лента активностей в публичных чатах: что аккаунты ответили и на что.
 *
 * Отдельно от переписок: у активности другой набор полей (чат, исходное
 * сообщение, вид действия), и мешать их в одном списке — значит показывать
 * половину колонок пустыми.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.activities.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const url = new URL(req.url);
      const accountId = url.searchParams.get('account_id');
      const runId = url.searchParams.get('run_id');
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1),
        1000,
      );

      let query = auth.supabase
        .from('tg_outreach_warmup_activities')
        .select('*')
        .eq('campaign_id', id)
        .order('planned_at', { ascending: false })
        .limit(limit);

      if (runId) query = query.eq('run_id', runId);
      if (accountId) query = query.eq('account_id', accountId);

      const { data, error } = await query;
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}
