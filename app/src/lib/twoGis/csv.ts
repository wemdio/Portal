import { TWO_GIS_SOURCE_COLUMNS, type TwoGisCard } from './types';

export const TWO_GIS_CSV_COLUMNS = [...TWO_GIS_SOURCE_COLUMNS];

function protectSpreadsheetCell(column: string | undefined, text: string): string {
  if (
    text
    && (column === 'id' || column === 'post_code' || column === 'phone')
  ) {
    return `'${text}`;
  }

  const trimmed = text.trimStart();
  if (!/^[=+\-@]/.test(trimmed)) return text;

  if (
    (column === 'lon' || column === 'lat')
    && /^[+-]?\d+(?:[.,]\d+)?$/.test(trimmed)
  ) {
    return text;
  }

  return `'${text}`;
}

function quoteCsv(value: unknown, column?: string): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = protectSpreadsheetCell(column, raw);
  return `"${text.replace(/"/g, '""')}"`;
}

export function createTwoGisCsvPreamble(): string {
  return `\uFEFFsep=;\r\n${TWO_GIS_CSV_COLUMNS.map((column) => quoteCsv(column)).join(';')}\r\n`;
}

export function serializeTwoGisCsvRows(
  rows: Array<Partial<TwoGisCard> | Record<string, unknown>>,
): string {
  return rows
    .map((row) =>
      TWO_GIS_CSV_COLUMNS
        .map((column) => quoteCsv(row[column], column))
        .join(';'),
    )
    .join('\r\n')
    .concat(rows.length > 0 ? '\r\n' : '');
}
