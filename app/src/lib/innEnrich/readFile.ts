/**
 * Чтение таблицы из буфера (воркер / API), без File API браузера.
 */

import { parseCSV, readXlsxRows } from '@/lib/spreadsheet/parseCSV';

export function spreadsheetExt(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

export async function readSpreadsheetBuffer(fileName: string, buffer: Buffer): Promise<string[][]> {
  const ext = spreadsheetExt(fileName);
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    return parseCSV(buffer.toString('utf8'));
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const ab = new ArrayBuffer(buffer.length);
    new Uint8Array(ab).set(buffer);
    return readXlsxRows(ab);
  }
  throw new Error('Поддерживаются форматы: CSV, TSV, XLSX, XLS');
}
