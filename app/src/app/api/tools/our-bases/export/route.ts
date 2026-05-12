import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const CHUNK_SIZE = 5000;

const COLUMNS = [
  { key: 'name',            label: 'Название' },
  { key: 'inn',             label: 'ИНН' },
  { key: 'kpp',             label: 'КПП' },
  { key: 'ogrn',            label: 'ОГРН' },
  { key: 'address',         label: 'Адрес' },
  { key: 'phones',          label: 'Телефоны' },
  { key: 'email',           label: 'Email' },
  { key: 'website',         label: 'Сайт' },
  { key: 'okved_code',      label: 'Код ОКВЭД' },
  { key: 'okved_name',      label: 'ОКВЭД (название)' },
  { key: 'activity_type',   label: 'Вид деятельности' },
  { key: 'employees_count', label: 'Сотрудники' },
  { key: 'revenue',         label: 'Выручка' },
  { key: 'cost',            label: 'Стоимость' },
  { key: 'edo_id',          label: 'ЭДО' },
  { key: 'egais',           label: 'ЕГАИС' },
] as const;

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

type Row = Record<string, unknown>;

function toSheetRow(row: Row): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const col of COLUMNS) {
    const v = row[col.key];
    out[col.label] = v === null || v === undefined ? null : (v as string | number);
  }
  return out;
}

function escapeCSV(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';

  let body: CompaniesSearchFilters;
  try {
    body = (await req.json()) as CompaniesSearchFilters;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const allRows: Row[] = [];
  let offset = 0;

  for (;;) {
    const { rows, error } = await searchRows(body, CHUNK_SIZE, offset);
    if (error) return NextResponse.json({ error }, { status: 500 });
    if (rows.length === 0) break;

    allRows.push(...rows);
    offset += CHUNK_SIZE;
    if (rows.length < CHUNK_SIZE) break;
  }

  if (allRows.length === 0) {
    return NextResponse.json({ error: 'Нет данных по заданным фильтрам' }, { status: 404 });
  }

  const dateSuffix = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const header = COLUMNS.map((c) => c.label).join(',');
    const csvRows = allRows.map((row) =>
      COLUMNS.map((c) => escapeCSV(row[c.key])).join(','),
    );
    const csv = [header, ...csvRows].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="companies_${dateSuffix}.csv"`,
        'X-Rows-Count': String(allRows.length),
      },
    });
  }

  const sheetRows = allRows.map(toSheetRow);
  const ws = XLSX.utils.json_to_sheet(sheetRows);

  ws['!cols'] = COLUMNS.map((col) => ({
    wch: Math.min(
      sheetRows.reduce(
        (max, r) => Math.max(max, String(r[col.label] ?? '').length),
        col.label.length,
      ),
      60,
    ),
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Компании');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(buf, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="companies_${dateSuffix}.xlsx"`,
      'X-Rows-Count': String(allRows.length),
    },
  });
}
