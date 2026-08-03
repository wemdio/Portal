import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Переписки прогрева. Фильтр по аккаунту нужен вкладке: общий поток из
 * шестнадцати аккаунтов нечитаем, а «что было у этого номера» — ровно тот
 * вопрос, который возникает у оператора.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.conversations.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const url = new URL(req.url);
      const accountId = url.searchParams.get('account_id');
      const dayRaw = url.searchParams.get('day');
      const day = dayRaw ? parseInt(dayRaw, 10) : null;
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1),
        500,
      );

      let query = supabase
        .from('tg_outreach_warmup_conversations')
        .select('*')
        .eq('campaign_id', id)
        .order('planned_at', { ascending: false })
        .limit(limit);

      if (accountId) {
        // Аккаунт может быть любой из двух сторон пары.
        query = query.or(`account_a_id.eq.${accountId},account_b_id.eq.${accountId}`);
      }
      if (day != null && !Number.isNaN(day)) query = query.eq('day_no', day);

      const { data, error } = await query;
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ items: data ?? [] });
    },
  );
}
