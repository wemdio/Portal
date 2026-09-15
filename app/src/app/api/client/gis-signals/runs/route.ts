import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getGisSignalsClientUserId } from '@/lib/gisSignalOutreach/access';
import { getRunHistory } from '@/lib/gisSignalOutreach/reportQueries';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/gis-signals/runs — история запусков пайплайна для блока
 * «История запусков» дашборда «2GIS + сигналы». Тот же гейт, что у
 * /api/client/gis-signals: ровно один клиент из
 * gis_signal_pipeline_config.client_user_id, чужим 404.
 *
 * Ответ: { runs: GisRunHistoryItem[] } — последние 30 прогонов, свежие сверху:
 * дата/статус/длительность, итоги воронки, причина падения и связанная база
 * (base_constructor_jobs 'gis-signals-…', матч по окну прогона — см.
 * getRunHistory). Ошибка БД → 500, пустой список = «запусков не было».
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const allowedUserId = await getGisSignalsClientUserId();
  if (!allowedUserId || allowedUserId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const runs = await getRunHistory(user.id, 30);
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Runs query failed' },
      { status: 500 },
    );
  }
}
