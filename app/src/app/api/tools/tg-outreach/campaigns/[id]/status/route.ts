import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.status.get' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { id } = await ctx.params;
      
        const { data: campaign, error } = await auth.supabase
          .from('tg_outreach_campaigns')
          .select('id, status, updated_at, lease_until')
          .eq('id', id)
          .single();
      
        if (error) return jsonError('Кампания не найдена', 404);
      
        /*
         * «Идёт» — это статус плюс живая аренда, и ничего больше.
         *
         * Раньше признаком служило наличие команды «старт» в очереди: она
         * висела в статусе «выполняется» всё время работы кампании. С переездом
         * на аренду команда закрывается тем же запросом, который её берёт, —
         * то есть прежний признак стал ВСЕГДА ложным, и экран считал бы
         * работающую кампанию остановившейся. Аренда же отвечает ровно на
         * нужный вопрос: держит ли кампанию живой исполнитель прямо сейчас.
         * Она продлевается втрое чаще своего срока, так что живая кампания
         * просроченной не выглядит.
         */
        const leaseUntil = (campaign as { lease_until: string | null }).lease_until;
        const leaseAlive = !!leaseUntil && Date.parse(leaseUntil) > Date.now();
      
        return NextResponse.json({
          ...campaign,
          is_running: campaign.status === 'running' && leaseAlive,
        });
    },
  );
}
