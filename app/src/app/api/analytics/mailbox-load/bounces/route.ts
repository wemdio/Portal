import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveAsOf } from '@/lib/instantly/mailboxLoad';
import { requireMailboxLoadAccess } from '../access';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/mailbox-load/bounces?day=YYYY-MM-DD
 * Разбивка отбоев за день: по ящикам, кампаниям, шагам цепочки и доменам.
 * Причин отказа Instantly не отдаёт — только то, что сохранено по событиям.
 */
export async function GET(req: NextRequest) {
  const denied = await requireMailboxLoadAccess(req);
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ error: 'not_configured', data: null }, { status: 503 });

  try {
    const { asOfDay } = await resolveAsOf(req.nextUrl.searchParams.get('day') ?? undefined);
    if (!asOfDay) return NextResponse.json({ data: null, error: 'no_data' });
    const { data, error } = await supabaseAdmin.rpc('instantly_bounces_breakdown', { p_day: asOfDay });
    if (error) throw new Error(error.message);
    return NextResponse.json({ data: { day: asOfDay, ...(data as object) } });
  } catch (e) {
    const detail = (e as Error).message;
    console.error('[mailbox-bounces] build failed:', detail);
    return NextResponse.json({ error: 'build_failed', detail, data: null }, { status: 500 });
  }
}
