import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { reconcileRecentTransitions } from '@/lib/amoFunnelGuard/reconcile';

export const dynamic = 'force-dynamic';

/**
 * Страховочный прогон правил воронки: перечитывает журнал AMO за последние
 * часы и откатывает то, что пропустил вебхук (портал лежал, AMO не достучалась).
 * Дёргается кроном на сервере (раз в 5 минут) с тем же секретом, что и вебхук:
 *   POST /api/amo/funnel-guard/webhook/reconcile?secret=<AMO_FUNNEL_GUARD_SECRET>[&minutes=180]
 * Путь лежит под `/webhook/`, чтобы пройти мимо входа по сессии (см. middleware).
 */
export async function POST(req: NextRequest) {
  const expected = process.env.AMO_FUNNEL_GUARD_SECRET ?? '';
  const given = req.nextUrl.searchParams.get('secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: true });
  }
  const minutes = Math.min(1440, Math.max(5, Number(req.nextUrl.searchParams.get('minutes')) || 180));
  try {
    return NextResponse.json({ ok: true, ...(await reconcileRecentTransitions(minutes)) });
  } catch (err) {
    console.error('[amo-funnel-guard] reconcile failed', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
