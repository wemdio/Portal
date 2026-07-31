import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchIncomeRows } from '@/lib/expenses/rows';
import { summarizeIncomes } from '@/lib/expenses/aggregate';
import { previousRange } from '@/lib/expenses/period';
import { parseIncomesQuery, type IncomesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let query: IncomesQuery;
  let prev: { from: string; to: string };
  try {
    query = parseIncomesQuery(req.nextUrl.searchParams);
    prev = previousRange(query.from, query.to);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const range = { from: query.from, to: query.to };
  const filters = {
    source: query.source,
    payerInn: query.payerInn,
    payerName: query.payerName,
    revenue: query.revenue,
  };

  try {
    const [rows, prevRows] = await Promise.all([
      fetchIncomeRows({ ...range, ...filters }),
      fetchIncomeRows({ ...prev, ...filters }),
    ]);

    const summary = summarizeIncomes(rows, query.groupBy, range, prevRows);

    // Не-выручка — отдельная строка KPI, нужная чтобы итог сходился с
    // банковской выпиской. `summarizeIncomes` берёт её из тех же строк, что и
    // итог, поэтому под фильтром `revenue=true` таких строк в выборке нет
    // вовсе и KPI показал бы 0 ₽ там, где приход был. Досчитываем одним
    // дополнительным запросом: тот же период и те же фильтры, но по
    // не-выручке. Считает та же функция — второй экземпляр той же арифметики
    // рано или поздно разъехался бы с первым.
    if (query.revenue === true) {
      const nonRevenueRows = await fetchIncomeRows({ ...range, ...filters, revenue: false });
      const nonRevenue = summarizeIncomes(nonRevenueRows, query.groupBy, range, null);
      summary.nonRevenueTotal = nonRevenue.nonRevenueTotal;
      summary.nonRevenueCount = nonRevenue.nonRevenueCount;
      summary.nonRevenueByReason = nonRevenue.nonRevenueByReason;
    }

    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
