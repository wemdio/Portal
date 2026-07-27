/**
 * Батч-запись ФАКТ-ячеек в лист отчёта продаж.
 *
 * Пишет ТОЛЬКО целевые клетки через `spreadsheets.values.batchUpdate` —
 * не трогает ПЛАН, % и весь остальной шит, поэтому безопасно запускать
 * скрипт хоть каждую минуту. Формулы `%` в шите (например =F8/E8) сами
 * пересчитаются на новые ФАКТ-числа.
 */
import { getSheetsClient } from '@/lib/googleSheets/auth';
import { columnIndexToLetter } from '@/lib/salesReport/sheetSchema';

export type CellUpdate = {
  row: number;                  // 1-based
  columnIndex: number;          // 1-based (F = 6)
  value: number | string;
};

export async function writeFactCells(
  spreadsheetId: string,
  sheetName: string,
  updates: CellUpdate[],
): Promise<void> {
  if (updates.length === 0) return;
  const sheets = getSheetsClient();

  const data = updates.map((u) => ({
    range: `${sheetName}!${columnIndexToLetter(u.columnIndex)}${u.row}`,
    values: [[u.value]],
  }));

  console.log(
    `[sales-report.writeFactCells] sheet="${sheetName}" writing ${updates.length} cells (first: ${data[0].range}, last: ${data[data.length - 1].range})`,
  );

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });
}
