import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { VendorOption } from '@/lib/expenses/types';

export const dynamic = 'force-dynamic';

/**
 * Справочник вендоров — всё, из чего можно выбрать, без привязки к периоду.
 *
 * Сосед `/api/expenses/vendors` отдаёт не справочник, а разбивку за выбранный
 * период: вендора, у которого в этом периоде трат не было, там нет по
 * построению. Для таблицы расходов это верно, а для выпадающего списка —
 * ловушка: человек не находит вендора, заводит его заново и получает 409
 * «такой уже есть». Подсев вендоров из предыдущего периода сглаживает случай
 * отменённой подписки, но молчавший оба периода всё равно пропадает.
 *
 * Поэтому выбор вендора читает эту ручку, а разбивка — ту: период нужен ровно
 * там, где считаются суммы.
 *
 * `is_active` фильтруется здесь и только здесь: выключенный вендор обязан
 * остаться в разбивке за прошлые периоды (деньги ему платили), но предлагать
 * его для новой разметки уже незачем.
 */
export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  // Пагинации нет намеренно: вендоров десятки, а дефолтный потолок PostgREST —
  // 1000 строк. Дорасти до него справочник может только вместе с редизайном
  // самого поля выбора, где плоский список и так перестанет работать.
  const { data, error } = await supabaseAdmin
    .from('expense_vendors')
    .select('id, name, category')
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ items: (data ?? []) as VendorOption[] });
}
