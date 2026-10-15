/**
 * GET /api/client/manual-scoring/runs
 *
 * Список прогонов текущего клиента — последние 20 за 30 дней.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  // Defence in depth: RLS is the main guard ("staff OR own run"), but pin a non-staff
  // caller to their own runs here too, so a policy that ever opens the table again
  // cannot list other clients' runs. Internal non-demo staff keep the unfiltered list,
  // the same rows RLS gives them. A failed profile read counts as not staff.
  const { data: actor } = await supabase
    .from('profiles')
    .select('role, is_demo')
    .eq('id', user.id)
    .maybeSingle();
  const isStaff = actor?.is_demo !== true
    && isInternalRole((actor?.role ?? null) as UserRole | null);

  let runsQuery = supabase
    .from('client_manual_score_runs')
    .select(
      'id, source_filename, uploaded_count, unique_count, processed_count, status, error_message, ' +
        'bucket_storage_count, bucket_medium_count, bucket_high_count, bucket_top_count, ' +
        'started_at, finished_at, expires_at',
    );
  if (!isStaff) {
    runsQuery = runsQuery.eq('client_user_id', user.id);
  }
  const { data, error } = await runsQuery
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ error: 'Ошибка БД' }, { status: 500 });
  }

  return NextResponse.json({ runs: data ?? [] });
}
