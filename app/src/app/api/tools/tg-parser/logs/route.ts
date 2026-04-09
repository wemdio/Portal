import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.logs.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 200));
      const isTargetParam = req.nextUrl.searchParams.get('is_target');
      const isTarget =
        isTargetParam == null ? null : isTargetParam === 'true' ? true : isTargetParam === 'false' ? false : null;

      let query = supabase
        .from('tg_parser_logs')
        .select('id, created_at, job_id, job_user_id, is_target, account_label, level, message')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (isTarget !== null) {
        query = query.eq('is_target', isTarget);
      }

      const { data, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ items: data ?? [] });
    },
  );
}
