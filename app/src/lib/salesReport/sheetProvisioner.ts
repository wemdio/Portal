/**
 * Автосоздание месячного листа отчёта продаж из шаблона.
 *
 * Логика при отсутствии листа «Месяц Год»:
 *   1. Найти лист-шаблон (по умолчанию «ШАБЛОН»).
 *   2. Дублировать его через `spreadsheets.batchUpdate` → `duplicateSheet`.
 *   3. Переименовать копию в «Месяц Год».
 *   4. Прочитать из копии позиции дат (колонки в row 1, где значение — дата).
 *   5. Sequentially прописать новые даты (1..N-й день месяца) в эти позиции.
 *      Позиций в шаблоне 31 — этого хватит для любого календарного месяца
 *      (28-31 день). Излишки (BF для 30-дневного месяца и т.п.) остаются
 *      пустыми — на структуре отчёта это не сказывается.
 */
import { getSheetsClient } from '@/lib/googleSheets/auth';
import { quoteSheet } from '@/lib/googleSheets/writer';
import { columnIndexToLetter } from '@/lib/salesReport/sheetSchema';

const DEFAULT_TEMPLATE_SHEET = 'ШАБЛОН';

async function listSheets(
  spreadsheetId: string,
): Promise<Array<{ sheetId: number; title: string }>> {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  return (resp.data.sheets ?? []).map((s) => ({
    sheetId: Number(s.properties?.sheetId),
    title: String(s.properties?.title ?? ''),
  }));
}

async function duplicateAndRename(
  spreadsheetId: string,
  sourceSheetId: number,
  newTitle: string,
): Promise<number> {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          duplicateSheet: {
            sourceSheetId,
            newSheetName: newTitle,
            insertSheetIndex: 0, // Ставим новый лист первым (свежий месяц слева)
          },
        },
      ],
    },
  });
  const newSheetId = resp.data.replies?.[0]?.duplicateSheet?.properties?.sheetId;
  if (typeof newSheetId !== 'number') {
    throw new Error(`duplicateSheet returned no sheetId for '${newTitle}'`);
  }
  return newSheetId;
}

async function readDateColumnPositions(
  spreadsheetId: string,
  sheetTitle: string,
): Promise<number[]> {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheet(sheetTitle)}!A1:BZ1`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const row = (resp.data.values?.[0] ?? []) as unknown[];
  const positions: number[] = [];
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    if (cell instanceof Date) {
      positions.push(i + 1);
      continue;
    }
    if (typeof cell === 'string' && cell.length > 0) {
      const d = new Date(cell);
      if (!Number.isNaN(d.getTime())) positions.push(i + 1);
    }
  }
  return positions;
}

function formatDdMmYyyy(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const y = date.getUTCFullYear();
  return `${d}.${m}.${y}`;
}

async function writeMonthDates(
  spreadsheetId: string,
  sheetTitle: string,
  year: number,
  monthIndex: number, // 0-11
  positions: number[],
): Promise<number> {
  const sheets = getSheetsClient();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const data: { range: string; values: (string | number | null)[][] }[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    if (d - 1 >= positions.length) break;
    const col = positions[d - 1];
    const dateStr = formatDdMmYyyy(new Date(Date.UTC(year, monthIndex, d)));
    data.push({
      range: `${quoteSheet(sheetTitle)}!${columnIndexToLetter(col)}1`,
      values: [[dateStr]],
    });
  }
  // Оставшиеся неиспользованные позиции (если daysInMonth < positions.length) чистим,
  // чтобы для нового 30-дневного месяца не осталась старая шаблонная дата.
  for (let i = daysInMonth; i < positions.length; i++) {
    const col = positions[i];
    data.push({
      range: `${quoteSheet(sheetTitle)}!${columnIndexToLetter(col)}1`,
      values: [['']],
    });
  }
  if (data.length === 0) return 0;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });
  return data.length;
}

/**
 * Гарантирует существование листа `<Месяц> <Год>` в таблице.
 * Возвращает { created: true } если только что создан, { created: false }
 * если уже был.
 */
export async function ensureMonthlySheet(
  spreadsheetId: string,
  sheetName: string,
  year: number,
  monthIndex: number, // 0-11
  templateSheetName: string = DEFAULT_TEMPLATE_SHEET,
): Promise<{ created: boolean; datesWritten?: number }> {
  const all = await listSheets(spreadsheetId);
  if (all.some((s) => s.title === sheetName)) {
    return { created: false };
  }
  const template = all.find((s) => s.title === templateSheetName);
  if (!template) {
    throw new Error(
      `Cannot create sheet '${sheetName}': template '${templateSheetName}' not found. Available: ${all.map((s) => s.title).join(', ')}`,
    );
  }
  await duplicateAndRename(spreadsheetId, template.sheetId, sheetName);
  const positions = await readDateColumnPositions(spreadsheetId, sheetName);
  const datesWritten = await writeMonthDates(
    spreadsheetId,
    sheetName,
    year,
    monthIndex,
    positions,
  );
  return { created: true, datesWritten };
}
