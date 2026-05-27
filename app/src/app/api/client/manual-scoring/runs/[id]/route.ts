/**
 * GET /api/client/manual-scoring/runs/[id]
 *
 * Детали одного прогона + быстрый breakdown по bucket'ам (для UI прогресс-бара
 * и кнопок «Скачать»).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const token = getBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('client_manual_score_runs')
    .select(
      'id, source_filename, uploaded_count, unique_count, status, processed_count, ' +
        'bucket_storage_count, bucket_medium_count, bucket_high_count, bucket_top_count, ' +
        'started_at, finished_at, error_message, expires_at',
    )
    .eq('id', id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Прогон не найден' }, { status: 404 });
  }

  return NextResponse.json(data);
}
