import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { isGisSignalsClient } from '@/lib/gisSignalOutreach/access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/gis-signals/enabled — виден ли дашборд «2GIS + сигналы»
 * текущему пользователю (он ли клиент из gis_signal_pipeline_config).
 *
 * Лёгкий роут для навигации — как /api/client/mailboxes/enabled: всегда
 * отдаёт { enabled }, без 401/403/404, чтобы меню тихо скрывало пункт.
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ enabled: false });

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ enabled: false });

  return NextResponse.json({ enabled: await isGisSignalsClient(user.id) });
}
