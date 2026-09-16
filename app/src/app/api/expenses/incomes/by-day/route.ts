import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { isSmallPayment } from '@/lib/expenses/aggregate';
import { groupByDay } from '@/lib/expenses/byDay';
import { fetchIncomeRows } from '@/lib/expenses/rows';
import { parseIncomesQuery, type IncomesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

/** Приходы за период, разложенные по дням. Зеркало `/api/expenses/by-day`. */
export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let query: IncomesQuery;
  try {
    query = parseIncomesQuery(req.nextUrl.searchParams);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    // Не-выручка остаётся в списке: экран обязан сходиться с выпиской, а
    // отобрать только её или только выручку можно явным `?revenue=`.
    const rows = await fetchIncomeRows({
      from: query.from,
      to: query.to,
      source: query.source,
      payerInn: query.payerInn,
      payerName: query.payerName,
      revenue: query.revenue,
    });
    // Мелкие платежи (выручка до SMALL_PAYMENT_THRESHOLD_RUB) в доход не входят,
    // поэтому основной список их не показывает, а `?small=only` отдаёт только
    // их — для отдельного списка под основным. Правило то же, что у итога
    // (isSmallPayment), чтобы список и плитка не разошлись.
    const smallOnly = req.nextUrl.searchParams.get('small') === 'only';
    const picked = rows.filter((r) => isSmallPayment(r) === smallOnly);
    return NextResponse.json({ days: groupByDay(picked), total: picked.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
