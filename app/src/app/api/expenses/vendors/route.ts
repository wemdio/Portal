import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { breakdownByVendor } from '@/lib/expenses/aggregate';
import { previousRange } from '@/lib/expenses/period';
import {
  EXPENSE_CATEGORIES,
  parseExpensesQuery,
  readJsonBody,
  type ExpensesQuery,
} from '@/lib/expenses/request';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ExpenseCategory } from '@/lib/expenses/types';

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

    return NextResponse.json({ items: breakdownByVendor(rows, prevRows) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: { name?: string; category?: string };
  try {
    body = await readJsonBody<{ name?: string; category?: string }>(req);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const category = body.category as ExpenseCategory | undefined;

  if (name.length < 2) {
    return NextResponse.json({ error: 'Название вендора короче двух символов' }, { status: 400 });
  }
  if (!category || !EXPENSE_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `Категория должна быть одной из: ${EXPENSE_CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from('expense_vendors')
    .insert({ name, category, created_by: guard.userId })
    .select('id, name, category')
    .single();

  if (error) {
    // Уникальный индекс по lower(name) — вендор с таким именем уже есть.
    const status = error.code === '23505' ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json(data, { status: 201 });
}
