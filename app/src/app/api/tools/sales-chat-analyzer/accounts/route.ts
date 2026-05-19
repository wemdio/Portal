import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Колонки аккаунта, безопасные для отдачи в UI (без session_sealed). */
export const ACCOUNT_PUBLIC_COLUMNS =
  'id,created_by,label,phone,tg_user_id,tg_username,tg_first_name,tg_last_name,' +
  'status,backfill_status,backfill_dialogs_done,backfill_dialogs_total,' +
  'last_connected_at,last_event_at,last_error,created_at,updated_at';

export async function GET(req: NextRequest) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_accounts')
    .select(ACCOUNT_PUBLIC_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accounts: data ?? [] });
}
