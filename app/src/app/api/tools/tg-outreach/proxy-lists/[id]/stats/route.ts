import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { computeListStats } from '@/lib/tgOutreach/proxyListStats';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Сводка по конкретному списку.
 *
 * Возраст считается в часах от `created_at` до момента запроса. Для
 * выключенных прокси — это оценка «как долго партия прожила»: точной даты
 * отключения мы не пишем, но если большинство выключенных — одного возраста,
 * картина правдоподобная. Если в списке нет выключенных, поле
 * `avg_age_hours_at_death` возвращается null и в UI не рисуется.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxy-lists.by-id.stats.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: listRow, error: listErr } = await auth.supabase
        .from('tg_outreach_proxy_lists')
        .select('id, campaign_id')
        .eq('id', id)
        .maybeSingle();

      if (listErr) return jsonError(listErr.message, 500);
      if (!listRow) return jsonError('Список не найден', 404);

      const stats = await computeListStats({
        campaignId: listRow.campaign_id,
        listId: id,
        supabase: auth.supabase,
      });
      return NextResponse.json(stats);
    },
  );
}
