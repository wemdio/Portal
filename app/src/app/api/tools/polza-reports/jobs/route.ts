import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const JOB_FIELDS =
  'id, source, status, detailed, include_created, include_base_left, progress, ' +
  'result_xlsx_path, result_filename, campaigns_count, error_message, ' +
  'created_at, started_at, completed_at';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const limit = Math.max(
    1,
    Math.min(100, Number(req.nextUrl.searchParams.get('limit') ?? '20') || 20),
  );

  const { data, error } = await supabase
    .from('polza_report_jobs')
    .select(JOB_FIELDS)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ jobs: data ?? [] });
}
