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
          .select('id, status, updated_at')
          .eq('id', id)
          .single();
      
        if (error) return jsonError('Кампания не найдена', 404);
      
        const { count: runningJobs } = await auth.supabase
          .from('tg_outreach_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', id)
          .eq('action', 'start')
          .in('status', ['pending', 'running']);
      
        return NextResponse.json({
          ...campaign,
          is_running: campaign.status === 'running' && (runningJobs ?? 0) > 0,
        });
    },
  );
}
