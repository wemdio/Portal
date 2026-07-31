import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseExpensesQuery, type ExpensesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

const QUEUE_LIMIT = 200;

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
    // Фильтр по категории здесь сознательно не применяется: у неразмеченной
    // строки категории нет по определению, и любой такой фильтр опустошил бы
    // очередь целиком.
    const rows = await fetchExpenseRows({
      from: query.from,
      to: query.to,
      source: query.source,
      unclassifiedOnly: true,
    });

    // Сначала самое дорогое: разметка десяти крупных операций закрывает больше
    // суммы, чем сотни мелких.
    rows.sort((a, b) => (b.amount_rub ?? 0) - (a.amount_rub ?? 0));

    return NextResponse.json({ items: rows.slice(0, QUEUE_LIMIT), total: rows.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
