import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.jobs.by-id.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: job, error } = await auth.supabase
        .from('tg_outreach_jobs')
        .select('id, campaign_id, action, status, progress, error_message, created_at, started_at, finished_at')
        .eq('id', id)
        .single();

      if (error || !job) return jsonError('Job не найден', 404);

      return NextResponse.json(job);
    },
  );
}
