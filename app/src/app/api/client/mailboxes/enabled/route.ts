import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { isByoMailboxEnabled } from '@/lib/byoMailbox/access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/mailboxes/enabled — включён ли пилот у текущего пользователя.
 *
 * Лёгкий: только резолвит юзера из токена и проверяет env-allowlist — без запросов
 * к profiles/доступам, потому что меню дёргает это на каждый рендер у ВСЕХ клиентов.
 * Всегда отдаёт { enabled }, не 403, чтобы меню могло тихо скрыть пункт.
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ enabled: false });

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ enabled: false });

  return NextResponse.json({ enabled: await isByoMailboxEnabled(user.id) });
}
