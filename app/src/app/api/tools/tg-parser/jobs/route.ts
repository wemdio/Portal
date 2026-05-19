import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.jobs.get' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const supabase = createAuthedSupabaseClient(token);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 50));

      // Try lightweight RPC (no result_users payload) — falls back to full select if RPC not deployed yet
      const { data: rpcData, error: rpcError } = await supabase.rpc('tg_parser_jobs_list', { row_limit: limit });

      if (!rpcError) {
        return NextResponse.json({ items: rpcData ?? [] });
      }

      // Fallback: full select (before migration is applied)
      const { data, error } = await supabase
        .from('tg_parser_jobs')
        .select(
          'id, user_id, created_at, status, config, account_id, result_users, stop_reason, error_message, started_at, completed_at',
        )
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ items: data ?? [] });
    },
  );
}
