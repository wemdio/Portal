import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { groupByDay } from '@/lib/expenses/byDay';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseExpensesQuery, type ExpensesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

/**
 * Расходы за период, разложенные по дням.
 *
 * Отдаём весь период разом, а не постранично: выборка на сервере всё равно
 * материализуется целиком (см. fetchExpenseRows), а списку нужны и итоги дней,
 * и сами операции внутри — постраничная нарезка ломала бы и то, и другое.
 * Сортировку по столбцам делает клиент: данные уже у него на руках, и ходить
 * на сервер за каждым щелчком по заголовку незачем.
 */
export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let query: ExpensesQuery;
  try {
    query = parseExpensesQuery(req.nextUrl.searchParams);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    // Перемещения между своими счетами тут НЕ отбрасываются — как и в списке
    // транзакций: файл и экран должны сходиться с выпиской построчно.
    const rows = await fetchExpenseRows({
      from: query.from,
      to: query.to,
      source: query.source,
      category: query.category,
      vendorId: query.vendorId,
    });
    return NextResponse.json({ days: groupByDay(rows), total: rows.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
