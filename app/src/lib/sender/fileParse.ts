import 'server-only';

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

/**
 * Разбор загруженного файла в строки «колонка → значение».
 *
 * Провайдеры (Maildoso, ZapMail) отдают выгрузку как CSV или XLSX со своими
 * заголовками, поэтому здесь только чтение файла: сопоставление колонок с
 * нашими полями живёт в mailboxImport.ts и проверяется отдельно.
 */

export type FileRow = Record<string, string>;

export class FileParseError extends Error {}

const MAX_ROWS = 20_000;

function cleanValue(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeRows(raw: Record<string, unknown>[]): FileRow[] {
  const out: FileRow[] = [];
  for (const row of raw.slice(0, MAX_ROWS)) {
    const clean: FileRow = {};
    let hasValue = false;
    for (const [key, value] of Object.entries(row)) {
      const header = key.trim();
      if (!header) continue;
      const text = cleanValue(value);
      clean[header] = text;
      if (text) hasValue = true;
    }
    if (hasValue) out.push(clean);
  }
  return out;
}

function parseDelimited(text: string): FileRow[] {
  // delimiter: '' — papaparse сам определяет разделитель: у провайдеров
  // встречаются и запятая, и точка с запятой, и таб.
  const parsed = Papa.parse<Record<string, unknown>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: '',
  });
  if (!parsed.data.length && parsed.errors.length) {
    throw new FileParseError(`Не удалось разобрать CSV: ${parsed.errors[0].message}`);
  }
  return normalizeRows(parsed.data);
}

function parseWorkbook(buffer: Buffer): FileRow[] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = book.SheetNames[0];
  if (!sheetName) throw new FileParseError('В файле нет ни одного листа');
  const sheet = book.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
  return normalizeRows(raw);
}

/** CSV/TSV/XLSX → строки. Формат определяется по расширению имени файла. */
export function parseMailboxFile(fileName: string, buffer: Buffer): FileRow[] {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const rows = ext === 'xlsx' || ext === 'xls'
    ? parseWorkbook(buffer)
    : parseDelimited(buffer.toString('utf8'));

  if (!rows.length) throw new FileParseError('Файл пустой или в нём только заголовки');
  return rows;
}
