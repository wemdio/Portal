import { NextResponse } from 'next/server';
import { syncClientLeads } from '@/lib/instantly/clientLeadsSync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CRON_SECRET = process.env.CRON_SECRET ?? '';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function checkCronAuth(req: Request): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === CRON_SECRET;
}

async function runSync() {
  try {
    const result = await syncClientLeads();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синхронизации лидов';
    return jsonError(message, 500);
  }
}

/** Vercel Cron / внешний планировщик */
export async function GET(req: Request) {
  if (!checkCronAuth(req)) return jsonError('Unauthorized', 401);
  return runSync();
}

/** Ручной вызов */
export async function POST(req: Request) {
  if (!checkCronAuth(req)) return jsonError('Unauthorized', 401);
  return runSync();
}
