import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.cis-leads.jobs.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const activeOnly = new URL(req.url).searchParams.get('active') === '1';
      let q = auth.supabase
        .from('lead_import_jobs')
        .select('id,status,source_filename,source_label,total_rows,processed_rows,error_message,created_at,started_at,completed_at')
        .eq('user_id', auth.user.id)
        .order('created_at', { ascending: false })
        .limit(activeOnly ? 5 : 30);

      if (activeOnly) q = q.in('status', ['pending', 'running']);

      const { data, error } = await q;
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ jobs: data ?? [] });
    },
  );
}

