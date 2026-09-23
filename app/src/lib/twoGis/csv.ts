import { TWO_GIS_RESULT_COLUMNS, type TwoGisCard } from './types';

export const TWO_GIS_CSV_COLUMNS = [...TWO_GIS_RESULT_COLUMNS];

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

/**
 * \u041D\u0430\u0447\u0430\u043B\u043E \u0444\u0430\u0439\u043B\u0430: BOM (\u0447\u0442\u043E\u0431\u044B Excel \u043F\u0440\u043E\u0447\u0451\u043B \u043A\u0438\u0440\u0438\u043B\u043B\u0438\u0446\u0443) \u0438 \u0441\u0442\u0440\u043E\u043A\u0430 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u043E\u0432.
 *
 * \u0421\u0442\u0440\u043E\u043A\u0438-\u043F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0438 Excel `sep=;` \u0437\u0434\u0435\u0441\u044C \u043D\u0435\u0442 \u043D\u0430\u043C\u0435\u0440\u0435\u043D\u043D\u043E. \u0424\u0430\u0439\u043B \u0443\u0445\u043E\u0434\u0438\u0442 \u043D\u0435 \u0442\u043E\u043B\u044C\u043A\u043E \u0432
 * Excel, \u043D\u043E \u0438 \u0432 Google \u0422\u0430\u0431\u043B\u0438\u0446\u044B \u0438 \u041A\u043E\u043D\u0441\u0442\u0440\u0443\u043A\u0442\u043E\u0440 \u0431\u0430\u0437, \u0438 \u0442\u0430\u043C \u043E\u043D\u0430 \u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u0430\u0441\u044C \u043F\u0435\u0440\u0432\u043E\u0439
 * \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0434\u0430\u043D\u043D\u044B\u0445: \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430\u043C\u0438 \u0441\u0447\u0438\u0442\u0430\u043B\u043E\u0441\u044C \u00ABsep=\u00BB, \u043A\u043E\u043B\u043E\u043D\u043A\u0430 website \u043D\u0435 \u043D\u0430\u0445\u043E\u0434\u0438\u043B\u0430\u0441\u044C.
 * \u0420\u0443\u0441\u0441\u043A\u0438\u0439 Excel \u0438 \u0431\u0435\u0437 \u043F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0438 \u0434\u0435\u043B\u0438\u0442 \u043F\u043E \u0442\u043E\u0447\u043A\u0435 \u0441 \u0437\u0430\u043F\u044F\u0442\u043E\u0439.
 */
export function createTwoGisCsvPreamble(): string {
  return `\uFEFF${TWO_GIS_CSV_COLUMNS.map((column) => quoteCsv(column)).join(';')}\r\n`;
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
