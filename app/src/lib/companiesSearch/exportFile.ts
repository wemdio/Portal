import * as XLSX from 'xlsx';

export type ExportFormat = 'csv' | 'xlsx';
export const EXPORT_CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

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

/** Both formats are built from the same frozen rows, before quota is charged. */
export function buildCompanyExportFiles(rows: Row[]): Record<ExportFormat, Buffer> {
  const header = COLUMNS.map((c) => c.label).join(',');
  const csvRows = rows.map((row) => COLUMNS.map((c) => escapeCSV(row[c.key])).join(','));
  // Excel needs a BOM to reliably recognize Cyrillic in UTF-8 CSV.
  const csv = Buffer.from('\uFEFF' + [header, ...csvRows].join('\r\n'), 'utf-8');
  const sheetRows = rows.map(toSheetRow);
  const sheet = XLSX.utils.json_to_sheet(sheetRows);
  sheet['!cols'] = COLUMNS.map((col) => ({
    wch: Math.min(sheetRows.reduce((max, row) =>
      Math.max(max, String(row[col.label] ?? '').length), col.label.length), 60),
  }));
  sheet['!autofilter'] = { ref: sheet['!ref']! };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Компании');
  return { csv, xlsx: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) };
}
