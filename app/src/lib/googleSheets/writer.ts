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

/** Дописывает строки в конец листа. Каждая row — массив ячеек. */
export async function appendRows(
  spreadsheetId: string,
  sheetName: string,
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
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
