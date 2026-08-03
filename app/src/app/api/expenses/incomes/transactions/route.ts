import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchIncomeRows } from '@/lib/expenses/rows';
import { parseIncomesQuery, parsePage, type IncomesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;

  let query: IncomesQuery;
  let page: number;
  try {
    query = parseIncomesQuery(params);
    page = parsePage(params);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    // Не-выручка тут НЕ отбрасывается по умолчанию: список операций должен
    // сходиться с выпиской построчно, иначе сверять дашборд не с чем. Отобрать
    // только её (или только выручку) можно явным `?revenue=`.
    const rows = await fetchIncomeRows({
      from: query.from,
      to: query.to,
      source: query.source,
      payerInn: query.payerInn,
      payerName: query.payerName,
      revenue: query.revenue,
    });

    return NextResponse.json({
      items: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
      total: rows.length,
      page,
      pageSize: PAGE_SIZE,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
