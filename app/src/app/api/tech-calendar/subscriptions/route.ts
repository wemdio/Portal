import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { mskDateStr } from '@/lib/techCalendar/dates';
import { refreshPendingReview } from '@/lib/techCalendar/pending';
import { ValidationError, parseCreateInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

const COLUMNS =
  'id, service_name, service_type, amount, currency, billing_cycle, next_billing_date, status, decision_by, decision_at, decision_notes, notes, source, external_key, quantity, provider_status, synced_at, is_hidden, hidden_at, created_by, created_at, updated_at';
const BALANCE_COLUMNS = 'provider, label, balance, unit, synced_at, last_error, updated_at';

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  // Жёлтый статус ставим перед выдачей: экран не должен показывать «активна»
  // сервису, до списания которого три дня, только потому что робот ещё не
  // добежал.
  await refreshPendingReview(supabaseAdmin, mskDateStr(new Date()));

  const includeHidden = req.nextUrl.searchParams.get('include_hidden') === '1';
  let query = supabaseAdmin
    .from('tech_subscriptions')
    .select(COLUMNS)
    .order('next_billing_date', { ascending: true });

  if (!includeHidden) query = query.eq('is_hidden', false);

  const [{ data, error }, balancesRes] = await Promise.all([
    query,
    supabaseAdmin.from('tech_provider_balances').select(BALANCE_COLUMNS).order('provider', { ascending: true }),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (balancesRes.error) return NextResponse.json({ error: balancesRes.error.message }, { status: 500 });
  return NextResponse.json({ subscriptions: data ?? [], balances: balancesRes.data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let input;
  try {
    input = parseCreateInput((await req.json()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from('tech_subscriptions')
    .insert({ ...input, status: 'active', created_by: guard.user.id });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
