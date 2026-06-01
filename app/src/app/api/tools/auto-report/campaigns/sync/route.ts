import { NextResponse } from 'next/server';
import { syncInstantlyCampaignCatalog } from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CRON_SECRET = process.env.CRON_SECRET ?? '';
const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

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
  if (!INSTANTLY_API_KEY) {
    return jsonError('Сервис не настроен (INSTANTLY_API_KEY)', 503);
  }
  try {
    const result = await syncInstantlyCampaignCatalog();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синхронизации';
    return jsonError(message, 500);
  }
}

/** Vercel Cron: GET с Authorization: Bearer CRON_SECRET */
export async function GET(req: Request) {
  if (!checkCronAuth(req)) return jsonError('Unauthorized', 401);
  return runSync();
}

/** Ручной вызов / внешний планировщик */
export async function POST(req: Request) {
  if (!checkCronAuth(req)) return jsonError('Unauthorized', 401);
  return runSync();
}
