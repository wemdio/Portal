import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Логи прогрева. Отдельно от логов кампании: в общем потоке боевого цикла
 * («круг завершён», «пауза перед переходом к следующему аккаунту») события
 * прогрева тонули полностью.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.logs.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const url = new URL(req.url);
      const accountId = url.searchParams.get('account_id');
      const runId = url.searchParams.get('run_id');
      const errorsOnly = url.searchParams.get('errors_only') === '1';
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1),
        2000,
      );

      let query = supabase
        .from('tg_outreach_warmup_logs')
        .select('*')
        .eq('campaign_id', id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (runId) query = query.eq('run_id', runId);
      // Общие события прогрева (account_id IS NULL) показываем всегда: без них
      // «начался день 2» пропал бы при фильтре по аккаунту, а это важный контекст.
      if (accountId) query = query.or(`account_id.eq.${accountId},account_id.is.null`);
      if (errorsOnly) query = query.in('level', ['warning', 'error']);

      const { data, error } = await query;
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}
