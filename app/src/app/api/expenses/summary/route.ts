import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { summarize } from '@/lib/expenses/aggregate';
import { previousRange } from '@/lib/expenses/period';
import { parseExpensesQuery, type ExpensesQuery } from '@/lib/expenses/request';
import { TRANSFER_CATEGORIES } from '@/lib/expenses/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let query: ExpensesQuery;
  let prev: { from: string; to: string };
  try {
    query = parseExpensesQuery(req.nextUrl.searchParams);
    prev = previousRange(query.from, query.to);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const range = { from: query.from, to: query.to };
  const filters = { source: query.source, category: query.category };

  try {
    const [rows, prevRows] = await Promise.all([
      fetchExpenseRows({ ...range, ...filters }),
      fetchExpenseRows({ ...prev, ...filters }),
    ]);

    const summary = summarize(rows, query.groupBy, range, prevRows);

    // Перемещения — отдельная строка KPI, нужная чтобы итог сходился с
    // банковской выпиской. `summarize` берёт их из тех же строк, что и итог,
    // поэтому под фильтром по категории (скажем, tools) их в выборке нет
    // вовсе, и KPI показал бы 0 ₽ там, где перемещения были. Досчитываем их
    // одним дополнительным запросом: тот же период и тот же источник, но без
    // фильтра по категории. Сумма считается тем же `summarize`, чтобы не
    // заводить второй экземпляр той же арифметики.
    if (query.category !== null && !TRANSFER_CATEGORIES.includes(query.category)) {
      const transferRows = await fetchExpenseRows({
        ...range,
        source: query.source,
        category: TRANSFER_CATEGORIES,
      });
      summary.transfersTotal = summarize(transferRows, query.groupBy, range, null).transfersTotal;
    }

    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
