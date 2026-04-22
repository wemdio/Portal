import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.stop.post' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { supabase, user } = auth;
        const { id } = await ctx.params;
      
        const { data: campaign } = await supabase
          .from('tg_outreach_campaigns')
          .select('id, status')
          .eq('id', id)
          .single();
      
        if (!campaign) return jsonError('Кампания не найдена', 404);
        if (campaign.status === 'stopped') return jsonError('Кампания уже остановлена', 409);
      
        const { data, error } = await supabase
          .from('tg_outreach_jobs')
          .insert({ campaign_id: id, user_id: user.id, action: 'stop' })
          .select()
          .single();
      
        if (error) {
          console.error('[tg-outreach][stop] failed to enqueue stop job', {
            campaignId: id,
            userId: user.id,
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          });
          if (error.code === '23503') {
            return jsonError('Профиль пользователя не найден. Обратитесь к администратору.', 409);
          }
          return jsonError(error.message, 500);
        }
      
        return NextResponse.json(data, { status: 201 });
    },
  );
}
