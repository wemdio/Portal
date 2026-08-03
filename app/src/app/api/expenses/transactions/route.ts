import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseExpensesQuery, parsePage, type ExpensesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const params = req.nextUrl.searchParams;

  let query: ExpensesQuery;
  let page: number;
  try {
    query = parseExpensesQuery(params);
    page = parsePage(params);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    // Перемещения тут НЕ отбрасываются: список транзакций должен сходиться с
    // выпиской построчно, иначе сверять дашборд не с чем.
    const rows = await fetchExpenseRows({
      from: query.from,
      to: query.to,
      source: query.source,
      category: query.category,
      vendorId: query.vendorId,
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
