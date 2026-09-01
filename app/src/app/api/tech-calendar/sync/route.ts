import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runSpaceProxyTechCalendarSync } from '@/lib/techCalendar/spaceProxySync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SPACEPROXY_API_KEY = process.env.SPACEPROXY_API_KEY ?? '';

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  if (!SPACEPROXY_API_KEY.trim()) {
    return NextResponse.json({ error: 'Не задан SPACEPROXY_API_KEY' }, { status: 500 });
  }

  try {
    const spaceproxy = await runSpaceProxyTechCalendarSync({
      db: supabaseAdmin,
      apiKey: SPACEPROXY_API_KEY.trim(),
      now: new Date(),
    });
    return NextResponse.json({ ok: true, spaceproxy });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Не удалось синхронизировать SpaceProxy';
    console.error('[tech-calendar-sync] manual sync failed', e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
