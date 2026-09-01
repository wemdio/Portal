import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { techCalendarMutationError } from '@/lib/techCalendar/budgetErrors';
import { addCycle } from '@/lib/techCalendar/dates';
import { ValidationError, parseRenewInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Тело продления необязательно (пустое тело = «посчитай дату по циклу»), но
 * это не то же самое, что СЛОМАННОЕ тело. `req.json().catch(() => ({}))`
 * раньше не различал эти два случая: и «тела нет», и «прислали не-JSON»
 * одинаково давали `{}`, и битый запрос тихо продлевал подписку и стирал
 * решение вместо ответа 400. Читаем сырой текст сами и парсим JSON только
 * когда он не пуст — тогда ошибка парсинга бьёт по конкретному запросу,
 * а не глушится общим catch.
 */
async function readRenewBody(req: NextRequest): Promise<Record<string, unknown>> {
  const raw = (await req.text()).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ValidationError('Битый JSON в теле запроса');
  }
}

/**
 * Продление — не «правка строки», а переход цикла: дата уезжает вперёд, статус
 * возвращается в «активна», решение обнуляется. Отдельная ручка нужна ровно
 * поэтому: PATCH'ем то же самое сделала бы форма редактирования, случайно
 * затерев решение, принятое пару минут назад.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  let input;
  try {
    input = parseRenewInput(await readRenewBody(req));
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { data: current, error: loadError } = await supabaseAdmin
    .from('tech_subscriptions')
    .select('id, next_billing_date, billing_cycle, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 });

  const row = current as {
    next_billing_date: string;
    billing_cycle: 'monthly' | 'quarterly' | 'yearly';
    updated_at: string;
  };
  const nextDate = input.next_billing_date ?? addCycle(row.next_billing_date, row.billing_cycle);

  const { data, error } = await supabaseAdmin.rpc('renew_tech_subscription_with_budget', {
    p_subscription_id: id,
    p_next_billing_date: nextDate,
    p_next_amount: input.amount ?? null,
    p_actor_id: guard.user.id,
    p_expected_updated_at: input.expected_updated_at ?? row.updated_at,
  });
  if (error) {
    const mapped = techCalendarMutationError(error);
    if (mapped) {
      return NextResponse.json(
        { error: mapped.message, code: mapped.code },
        { status: mapped.status },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    next_billing_date: typeof data === 'string' ? data : nextDate,
  });
}
