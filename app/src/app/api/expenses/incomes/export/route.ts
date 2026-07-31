import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { fetchIncomeRows } from '@/lib/expenses/rows';
import { parseIncomesQuery, type IncomesQuery } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let query: IncomesQuery;
  try {
    query = parseIncomesQuery(req.nextUrl.searchParams);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  let rows;
  try {
    // Выгрузка отдаёт то же, что видно в списке операций, включая не-выручку:
    // файл идёт на сверку с выпиской, а из неё её не выкинешь.
    rows = await fetchIncomeRows({
      from: query.from,
      to: query.to,
      source: query.source,
      payerInn: query.payerInn,
      payerName: query.payerName,
      revenue: query.revenue,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Дата: r.occurred_on_msk,
      Источник: r.source,
      Плательщик: r.counterparty ?? '',
      ИНН: r.counterparty_inn ?? '',
      Назначение: r.details ?? '',
      Сумма: r.amount,
      Валюта: r.currency,
      // Пусто, а не ноль: у строки без курса ЦБ рублёвой суммы нет, и ноль
      // здесь врал бы при суммировании столбца в Excel.
      'Сумма, ₽': r.amount_rub ?? '',
      // Не «да/нет»: нерасклассифицированная строка (is_revenue = NULL) — это
      // третье состояние, и в файле сверки его нельзя выдавать за одно из
      // двух. Агрегация считает такую строку выручкой, но пустая клетка
      // показывает, что решение принял не классификатор.
      Выручка: r.is_revenue === null ? '' : r.is_revenue ? 'да' : 'нет',
      'Причина исключения': r.exclude_reason ?? '',
    })),
  );

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Доходы');
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="incomes-${query.from}_${query.to}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
