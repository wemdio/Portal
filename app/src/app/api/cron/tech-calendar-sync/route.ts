import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runSpaceProxyTechCalendarSync } from '@/lib/techCalendar/spaceProxySync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CRON_SECRET = process.env.CRON_SECRET ?? '';
const SPACEPROXY_API_KEY = process.env.SPACEPROXY_API_KEY ?? '';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!CRON_SECRET && token === CRON_SECRET;
}

async function run() {
  if (!supabaseAdmin) {
    return jsonError('Server misconfigured: missing Supabase service role', 500);
  }
  if (!SPACEPROXY_API_KEY.trim()) {
    return jsonError('Server misconfigured: missing SPACEPROXY_API_KEY', 500);
  }

  try {
    const spaceproxy = await runSpaceProxyTechCalendarSync({
      db: supabaseAdmin,
      apiKey: SPACEPROXY_API_KEY.trim(),
      now: new Date(),
    });
    return NextResponse.json({ ok: true, spaceproxy });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Tech calendar sync failed';
    console.error('[tech-calendar-sync] failed', e);
    return jsonError(message, 502);
  }
}

export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonError('Unauthorized', 401);
  return run();
}
