import { getSheetsClient } from '@/lib/googleSheets/auth';

/** Читает значения одной колонки листа (A1-нотация без диапазона). */
export async function readColumn(
  spreadsheetId: string,
  sheetName: string,
  column: string, // 'A', 'B', ...
): Promise<string[]> {
  const sheets = getSheetsClient();
  const range = `${sheetName}!${column}:${column}`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = resp.data.values ?? [];
  return rows.map((r) => (r[0] ?? '').toString());
}

/**
 * Дописывает строки в конец листа. Каждая row — массив ячеек.
 *
 * Ранее использовался `spreadsheets.values.append` с `range='SheetName!A1'`,
 * который полагался на table-detection Google Sheets API. Это ломалось на
 * листах, где столбец A не заполняется в реальных строках (например «Оффер»
 * — ручная колонка, часто пустая): API не находил «таблицу» и вписывал
 * начиная с самого верха, поверх пустых строк над данными.
 *
 * Теперь читаем `A:Z` листа, находим реальную последнюю занятую строку по
 * любой колонке и пишем через `values.update` в явный диапазон
 * `A<lastRow+1>:<endCol><lastRow+N>`. Это надёжно независимо от того,
 * какие колонки в существующих строках заполнены.
 */
export async function appendRows(
  spreadsheetId: string,
  sheetName: string,
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const sheets = getSheetsClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });
  const lastRow = (resp.data.values ?? []).length;
  const startRow = lastRow + 1;
  const endRow = startRow + rows.length - 1;
  const numCols = rows[0]?.length ?? 0;
  if (numCols === 0 || numCols > 26) {
    throw new Error(
      `appendRows: unsupported row width ${numCols} for sheet ${sheetName}`,
    );
  }
  const endCol = String.fromCharCode('A'.charCodeAt(0) + numCols - 1);
  const targetRange = `${sheetName}!A${startRow}:${endCol}${endRow}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: targetRange,
    valueInputOption: 'RAW',
    requestBody: { values: rows as (string | number | null)[][] },
  });
}

/** Возвращает true, если лист с таким именем уже существует. */
export async function sheetExists(
  spreadsheetId: string,
  sheetName: string,
): Promise<boolean> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === sheetName,
  );
}
