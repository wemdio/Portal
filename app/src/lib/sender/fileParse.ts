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

export interface ParsedFile {
  rows: FileRow[];
  /** Сколько строк с данными было в файле до обреза лимитом. */
  totalRows: number;
}

const MAX_ROWS = 20_000;

function cleanValue(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeRows(raw: Record<string, unknown>[]): ParsedFile {
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
  // Обрез молча подменял «загрузил 50 000» на «загрузил 20 000»: оператор
  // узнавал об этом никогда. Считаем исходный размер и отдаём наверх.
  const totalRows = raw.filter((row) => Object.values(row).some((value) => cleanValue(value))).length;
  return { rows: out, totalRows };
}

function parseDelimited(text: string): ParsedFile {
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

function parseWorkbook(buffer: Buffer): ParsedFile {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = book.SheetNames[0];
  if (!sheetName) throw new FileParseError('В файле нет ни одного листа');
  const sheet = book.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
  return normalizeRows(raw);
}

/** CSV/TSV/XLSX → строки. Формат определяется по расширению имени файла. */
export function parseMailboxFile(fileName: string, buffer: Buffer): ParsedFile {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const parsed = ext === 'xlsx' || ext === 'xls'
    ? parseWorkbook(buffer)
    : parseDelimited(buffer.toString('utf8'));

  if (!parsed.rows.length) throw new FileParseError('Файл пустой или в нём только заголовки');
  return parsed;
}
