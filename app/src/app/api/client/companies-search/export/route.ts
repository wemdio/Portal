import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { recordSeenCompanies, extractCompanyIds } from '@/lib/companiesSearch/seenJournal';
import {
  getClientTariffRow,
  resolveEffectiveLimits,
  getBillingPeriodStart,
  countClientRows,
  getClientStatus,
  isClientToolAccessAllowed,
  isAwaitingFirstPayment,
  TOOL_ACCESS_DENIED_MESSAGE,
  AWAITING_PAYMENT_MESSAGE,
} from '@/lib/tariffs';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

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

interface ExportFilters {
  regionCodes?: string[];
  activityTypes?: string[];
  okvedCodes?: string[];
  hasPhone?: boolean;
  hasEmail?: boolean;
  legalForms?: string[];
  hasWebsite?: boolean;
  hasEdo?: boolean;
  hasEgais?: boolean;
  revenueFrom?: number | null;
  revenueTo?: number | null;
  costFrom?: number | null;
  costTo?: number | null;
  employeesFrom?: number | null;
  employeesTo?: number | null;
  includeIp?: boolean;
  innList?: string[];
  /** Включить и уже выгружавшиеся компании (по умолчанию — исключаются). */
  includeSeen?: boolean;
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
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';

  let body: ExportFilters;
  try {
    body = (await req.json()) as ExportFilters;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const tariffRow = await getClientTariffRow(result.auth.userId);
  // Серверный гейт оплаты (страничная проверка обходится прямым вызовом API).
  // Пускаем оплаченных: active + setup; режем inactive/expired.
  if (!isClientToolAccessAllowed(getClientStatus(tariffRow))) {
    return jsonError(TOOL_ACCESS_DENIED_MESSAGE, 403);
  }
  // Оформил подписку, но ещё не оплатил — доступа нет до оплаты.
  if (isAwaitingFirstPayment(tariffRow)) {
    return jsonError(AWAITING_PAYMENT_MESSAGE, 403);
  }
  const limits = resolveEffectiveLimits(tariffRow);
  const periodStart = getBillingPeriodStart(tariffRow);
  const usedRows = await countClientRows(result.auth.userId, periodStart);
  const remaining = Math.max(0, limits.max_rows - usedRows);

  if (remaining <= 0) {
    return jsonError(
      `Лимит запросов по тарифу исчерпан. Доступно 0 из ${limits.max_rows.toLocaleString('ru-RU')} запросов.`,
      429,
    );
  }

  // Дедуп по seen-журналу включён по умолчанию (клиент получает СЛЕДУЮЩИЙ
  // срез базы, а не те же первые N каждый месяц); галочка include_seen снимает.
  const seenOpts = body.includeSeen === true
    ? undefined
    : { excludeSeenForUser: result.auth.userId };

  // Кап по остатку тарифа: раньше проверялось только remaining > 0 на входе,
  // и клиент с остатком 1 мог выгрузить весь срез базы разом (списание шло
  // постфактум в минус). Теперь файл содержит не больше remaining строк.
  const allRows: Row[] = [];

  for (;;) {
    const want = Math.min(CHUNK_SIZE, remaining - allRows.length);
    if (want <= 0) break;
    // offset = уже собранные строки: ORDER BY id и предикаты стабильны в
    // пределах цикла, поэтому смещение по счётчику корректно.
    const { rows, error } = await searchRows(body, want, allRows.length, seenOpts);
    if (error) return jsonError(error, 500);
    if (rows.length === 0) break;

    allRows.push(...rows);
    if (rows.length < want) break;
  }

  if (allRows.length === 0) {
    return jsonError('Нет данных по заданным фильтрам', 404);
  }

  if (supabaseAdmin) {
    await supabaseAdmin
      .from('client_companies_search_exports')
      .insert({ user_id: result.auth.userId, row_count: allRows.length });
  }
  // Помечаем выгруженное в seen-журнале (идемпотентно, дата первой выдачи
  // сохраняется). Best-effort — файл клиент уже получает в любом случае.
  await recordSeenCompanies(result.auth.userId, extractCompanyIds(allRows));

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
