import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getRegionByCode } from '@/lib/companiesSearch/regions';
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
  { key: 'activity_type',   label: 'Вид деятельности' },
  { key: 'employees_count', label: 'Сотрудники' },
  { key: 'revenue',         label: 'Выручка' },
  { key: 'cost',            label: 'Стоимость' },
  { key: 'edo_id',          label: 'ЭДО' },
  { key: 'egais',           label: 'ЕГАИС' },
] as const;

const DB_FIELDS = COLUMNS.map((c) => c.key).join(', ');

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

function applyFilters(body: CompaniesSearchFilters, offset: number) {
  let q = admin
    .from('companies_directory')
    .select(DB_FIELDS)
    .order('id', { ascending: true })
    .range(offset, offset + CHUNK_SIZE - 1);

  if (body.regionCodes && body.regionCodes.length > 0) {
    const tokens: string[] = [];
    for (const code of body.regionCodes) {
      const r = getRegionByCode(code);
      if (r) for (const tk of r.matchTokens) tokens.push(tk);
    }
    if (tokens.length > 0) {
      q = q.or(
        tokens.map((tk) => `address.ilike.%${tk.replace(/[%,]/g, '')}%`).join(','),
      );
    }
  }

  if (body.activityTypes && body.activityTypes.length > 0) {
    q = q.in('activity_type', body.activityTypes);
  }
  if (body.hasPhone) q = q.not('phones', 'is', null);
  if (body.hasEmail) q = q.not('email', 'is', null);
  if (body.legalForms && body.legalForms.length > 0) {
    q = q.or(
      body.legalForms.map((f) => `name.ilike.${f.replace(/[%,]/g, '')}%`).join(','),
    );
  }
  if (body.hasWebsite) q = q.not('website', 'is', null);
  if (body.hasEdo) q = q.not('edo_id', 'is', null);
  if (body.hasEgais) q = q.not('egais', 'is', null);
  if (body.includeIp === false) q = q.not('name', 'ilike', 'ИП %');
  if (typeof body.revenueFrom === 'number') q = q.gte('revenue', body.revenueFrom);
  if (typeof body.revenueTo === 'number') q = q.lte('revenue', body.revenueTo);
  if (typeof body.costFrom === 'number') q = q.gte('cost', body.costFrom);
  if (typeof body.costTo === 'number') q = q.lte('cost', body.costTo);
  if (typeof body.employeesFrom === 'number') q = q.gte('employees_count', body.employeesFrom);
  if (typeof body.employeesTo === 'number') q = q.lte('employees_count', body.employeesTo);
  if (body.innList && body.innList.length > 0) {
    q = q.in('inn', body.innList);
  }

  return q;
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
    const { data, error } = await applyFilters(body, offset);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as unknown as Row[];
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
