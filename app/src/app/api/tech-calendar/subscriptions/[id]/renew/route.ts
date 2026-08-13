import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { addCycle } from '@/lib/techCalendar/dates';
import { ValidationError, parseRenewInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Продление — не «правка строки», а переход цикла: дата уезжает вперёд, статус
 * возвращается в «активна», решение обнуляется. Отдельная ручка нужна ровно
 * поэтому: PATCH'ем то же самое сделала бы форма редактирования, случайно
 * затерев решение, принятое пару минут назад.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let input;
  try {
    input = parseRenewInput((await req.json().catch(() => ({}))) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { data: current, error: loadError } = await supabaseAdmin
    .from('tech_subscriptions')
    .select('id, next_billing_date, billing_cycle')
    .eq('id', id)
    .maybeSingle();

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 });

  const row = current as { next_billing_date: string; billing_cycle: 'monthly' | 'quarterly' | 'yearly' };
  const nextDate = input.next_billing_date ?? addCycle(row.next_billing_date, row.billing_cycle);

  const patch: Record<string, unknown> = {
    next_billing_date: nextDate,
    status: 'active',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
  };
  if (input.amount !== undefined) patch.amount = input.amount;

  const { error } = await supabaseAdmin.from('tech_subscriptions').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, next_billing_date: nextDate });
}
