import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RUN_COLUMNS =
  'id,trigger,sync_date,status,accounts_total,accounts_done,error_message,created_at,started_at,finished_at';

/** Текущая дата в МСК (YYYY-MM-DD). */
function mskDateStr(): string {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** Список последних запусков синхронизации (для статуса в UI). */
export async function GET(req: NextRequest) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_sync_runs')
    .select(RUN_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data ?? [] });
}

/** Ручной запуск синхронизации «прямо сейчас». */
export async function POST(req: NextRequest) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  // Если синхронизация уже запланирована или идёт — не плодим дубли.
  const { data: active } = await supabaseAdmin!
    .from('sales_chat_sync_runs')
    .select(RUN_COLUMNS)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) return NextResponse.json({ run: active, already_running: true });

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_sync_runs')
    .insert({
      trigger: 'manual',
      sync_date: mskDateStr(),
      status: 'pending',
      requested_by: guard.userId,
    })
    .select(RUN_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ run: data });
}
