import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runTechCalendarSync } from '@/lib/techCalendar/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SPACEPROXY_API_KEY = process.env.SPACEPROXY_API_KEY ?? '';
const SERPER_API_KEY = process.env.SERPER_API_KEY ?? '';
const PROXY_MARKET_API_KEY = process.env.PROXY_MARKET_API_KEY ?? '';

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  try {
    const sync = await runTechCalendarSync({
      db: supabaseAdmin,
      now: new Date(),
      spaceProxyApiKey: SPACEPROXY_API_KEY,
      serperApiKey: SERPER_API_KEY,
      proxyMarketApiKey: PROXY_MARKET_API_KEY,
    });
    return NextResponse.json({ ok: true, sync });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Не удалось синхронизировать техничку';
    console.error('[tech-calendar-sync] manual sync failed', e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
