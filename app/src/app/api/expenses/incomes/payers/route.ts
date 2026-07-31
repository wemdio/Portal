import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchIncomeRows } from '@/lib/expenses/rows';
import { breakdownByPayer } from '@/lib/expenses/aggregate';
import { previousRange } from '@/lib/expenses/period';
import { parseIncomesQuery, type IncomesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

/**
 * Разбивка дохода по плательщикам — аналог `/api/expenses/vendors` для
 * прихода. POST-близнеца у него нет: справочника плательщиков не существует,
 * группировка идёт по ИНН из самой выписки.
 */
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

    return NextResponse.json({ items: breakdownByPayer(rows, prevRows) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
