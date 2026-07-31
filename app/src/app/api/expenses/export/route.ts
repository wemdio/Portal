import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchExpenseRows } from '@/lib/expenses/rows';
import { parseExpensesQuery, type ExpensesQuery } from '@/lib/expenses/request';
import { CATEGORY_LABELS } from '@/lib/expenses/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let query: ExpensesQuery;
  try {
    query = parseExpensesQuery(req.nextUrl.searchParams);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  let rows;
  try {
    // Выгрузка отдаёт то же, что видно в списке транзакций, включая
    // перемещения: файл идёт на сверку с выпиской, а из неё их не выкинешь.
    rows = await fetchExpenseRows({
      from: query.from,
      to: query.to,
      source: query.source,
      category: query.category,
      vendorId: query.vendorId,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Дата: r.occurred_on_msk,
      Источник: r.source,
      Вендор: r.vendor_name ?? 'Без вендора',
      Категория: r.category ? CATEGORY_LABELS[r.category] : '',
      Контрагент: r.counterparty ?? '',
      ИНН: r.counterparty_inn ?? '',
      Назначение: r.details ?? '',
      Сумма: r.amount,
      Валюта: r.currency,
      // Пусто, а не ноль: у строки без курса ЦБ рублёвой суммы нет, и ноль
      // здесь врал бы при суммировании столбца в Excel.
      'Сумма, ₽': r.amount_rub ?? '',
    })),
  );

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Расходы');
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="expenses-${query.from}_${query.to}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
