import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.start.post' },
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
        if (campaign.status === 'running') return jsonError('Кампания уже запущена', 409);
      
        const { data, error } = await supabase
          .from('tg_outreach_jobs')
          .insert({ campaign_id: id, user_id: user.id, action: 'start' })
          .select()
          .single();
      
        if (error) return jsonError(error.message, 500);
      
        await supabase
          .from('tg_outreach_campaigns')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', id);
      
        return NextResponse.json(data, { status: 201 });
    },
  );
}
