import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isYookassaConfigured } from '@/lib/yookassa';
import { runAutoRenewBatch } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/auto-renew
 *
 * Тонкий HTTP-фасад над runAutoRenewBatch() из lib/billing.ts. Существует на
 * случай если шедулер живёт ВНЕ нашего процесса (Supabase pg_cron, внешняя
 * пинговалка). Основной планировщик в проде — worker/autoRenewCron.ts, он
 * вызывает runAutoRenewBatch напрямую и НЕ ходит через HTTP.
 *
 * Защищён CRON_SECRET. chargeMonthlyRenewal внутри идемпотентен по
 * (tariffId, YYYY-MM) — повторный вызов в том же месяце безопасен.
 */
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  if (!isYookassaConfigured()) return NextResponse.json({ error: 'YooKassa not configured' }, { status: 503 });

  const batch = await runAutoRenewBatch();
  return NextResponse.json({ ok: true, ...batch });
}
