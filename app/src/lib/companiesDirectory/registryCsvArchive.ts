import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Papa from 'papaparse';

import type { SbisDirectoryInputRow } from '@/lib/companiesDirectory/sbisImportPlan';

// unzipper 0.10 has no bundled TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as {
  Open: {
    buffer(value: Buffer): Promise<{
      files: Array<{
        path: string;
        type: string;
        compressedSize: number;
        uncompressedSize: number;
        buffer(): Promise<Buffer>;
      }>;
    }>;
  };
};

type CsvRow = Record<string, string>;
export type RegistryV2Schema = 'legal-entity' | 'entrepreneur';

export interface RegistryV2FilteredStatus {
  rowNumber: number;
  inn: string | null;
  status: string;
}

export interface RegistryV2ArchiveResult {
  archiveName: string;
  entryName: string;
  archiveBytes: number;
  uncompressedBytes: number;
  archiveSha256: string;
  csvSha256: string;
  schema: RegistryV2Schema;
  headers: string[];
  inputRows: number;
  activeRows: SbisDirectoryInputRow[];
  filteredStatuses: RegistryV2FilteredStatus[];
}

export interface RegistryV2CsvFileResult {
  sourceFile: string;
  fileBytes: number;
  fileSha256: string;
  schema: RegistryV2Schema;
  headers: string[];
  inputRows: number;
  activeRows: SbisDirectoryInputRow[];
  filteredStatuses: RegistryV2FilteredStatus[];
}

export interface ReadRegistryV2ArchiveOptions {
  sourceArchiveName?: string;
  maxArchiveBytes?: number;
  maxUncompressedBytes?: number;
  maxCompressionRatio?: number;
}

export class RegistryV2ArchiveError extends Error {
  constructor(
    readonly code: 'empty_archive',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryV2ArchiveError';
  }
}

const DEFAULT_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 250;

const LEGAL_CORE_HEADERS = [
  'Сокращенное наименование',
  'Полное наименование',
  'ОГРН',
  'ИНН',
  'КПП',
  'Телефоны',
  'Email',
  'Веб-сайт',
  'Статус',
  'Дата регистрации',
  'Регион',
  'Юридический адрес',
  'Код ОКВЭД-2',
  'Основной вид деятельности',
  'Руководитель',
  'Должность',
  'ИНН руководителя',
  'ССЧ',
  'Реестр МСП',
  'Уставный капитал',
  'Специальные налоговые режимы',
  'Уплаченные налоги',
  'Сумма контрактов - заказчик',
  'Сумма контрактов - поставщик',
] as const;

const ENTREPRENEUR_HEADERS = [
  'Тип',
  'ФИО',
  'ОГРНИП',
  'ИНН',
  'Email',
  'Статус',
  'Дата регистрации',
  'Регион',
  'Населенный пункт',
  'Код ОКВЭД-2',
  'Основной вид деятельности',
  'Реестр МСП',
  'Специальные налоговые режимы',
  'Сумма контрактов - заказчик',
  'Сумма контрактов - поставщик',
] as const;

const FINANCE_HEADER_PATTERN = /^(Капитал|Выручка|Чистая прибыль) \((\d{4})\)$/;

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return result;
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function validateHeaders(headers: string[]): RegistryV2Schema {
  if (headers.length === 0 || new Set(headers).size !== headers.length) {
    throw new Error('Registry CSV headers are empty or duplicated');
  }
  const headerSet = new Set(headers);
  const isEntrepreneur = ENTREPRENEUR_HEADERS.every((header) => headerSet.has(header));
  if (isEntrepreneur) {
    if (headers.length !== ENTREPRENEUR_HEADERS.length) {
      throw new Error('Entrepreneur registry CSV has unexpected columns');
    }
    return 'entrepreneur';
  }

  const missingLegal = LEGAL_CORE_HEADERS.filter((header) => !headerSet.has(header));
  if (missingLegal.length > 0) {
    throw new Error(`Legal-entity registry CSV is missing headers: ${missingLegal.join(', ')}`);
  }
  const financeHeaders = headers.filter((header) => !LEGAL_CORE_HEADERS.includes(
    header as typeof LEGAL_CORE_HEADERS[number],
  ));
  const financeByYear = new Map<string, Set<string>>();
  for (const header of financeHeaders) {
    const match = header.match(FINANCE_HEADER_PATTERN);
    if (!match) throw new Error(`Unexpected registry CSV header: ${header}`);
    const fields = financeByYear.get(match[2]) ?? new Set<string>();
    fields.add(match[1]);
    financeByYear.set(match[2], fields);
  }
  if (
    financeByYear.size < 2
    || [...financeByYear.values()].some((fields) => fields.size !== 3)
  ) {
    throw new Error('Legal-entity registry CSV finance-year columns are incomplete');
  }
  return 'legal-entity';
}

function parseCsv(value: Buffer, source: string): {
  schema: RegistryV2Schema;
  headers: string[];
  rows: CsvRow[];
} {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Registry CSV is not valid UTF-8 (${source}): ${message}`);
  }
  const parsed = Papa.parse<CsvRow>(text.replace(/^\uFEFF/, ''), {
    header: true,
    delimiter: ';',
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) {
    throw new Error(
      `Registry CSV parse error (${source}): ${JSON.stringify(parsed.errors.slice(0, 5))}`,
    );
  }
  const headers = parsed.meta.fields ?? [];
  return {
    schema: validateHeaders(headers),
    headers,
    rows: parsed.data,
  };
}

function splitPersonName(value: unknown): {
  director_last_name: string | null;
  director_first_name: string | null;
  director_middle_name: string | null;
} {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    director_last_name: parts[0] ?? null,
    director_first_name: parts[1] ?? null,
    director_middle_name: parts.slice(2).join(' ') || null,
  };
}

function latestRevenue(row: CsvRow): string | null {
  const years = Object.keys(row)
    .map((header) => header.match(/^Выручка \((\d{4})\)$/)?.[1] ?? null)
    .filter((year): year is string => Boolean(year))
    .sort((left, right) => Number(right) - Number(left));
  for (const year of years) {
    const value = normalizeText(row[`Выручка (${year})`]);
    if (value) return value;
  }
  return null;
}

function sourceActivity(row: CsvRow): string | null {
  const code = normalizeText(row['Код ОКВЭД-2']);
  const activity = normalizeText(row['Основной вид деятельности']);
  return [code, activity].filter(Boolean).join(' - ') || null;
}

function toInput(
  row: CsvRow,
  schema: RegistryV2Schema,
  rowNumber: number,
): SbisDirectoryInputRow {
  const activity = normalizeText(row['Основной вид деятельности']);
  const okvedCodeExact = normalizeText(row['Код ОКВЭД-2']);
  if (schema === 'entrepreneur') {
    const type = normalizeText(row['Тип']);
    const name = normalizeText(row['ФИО']);
    return {
      rowNumber,
      name: [type, name].filter(Boolean).join(' ') || null,
      inn: row['ИНН'],
      address: [normalizeText(row['Регион']), normalizeText(row['Населенный пункт'])]
        .filter(Boolean)
        .join(', ') || null,
      activity_type: activity,
      source_activity: sourceActivity(row),
      okved_code_exact: okvedCodeExact,
      email: row['Email'],
      ogrn: row['ОГРНИП'],
    };
  }
  return {
    rowNumber,
    name: normalizeText(row['Сокращенное наименование'])
      ?? normalizeText(row['Полное наименование']),
    inn: row['ИНН'],
    kpp: row['КПП'],
    address: row['Юридический адрес'],
    ...splitPersonName(row['Руководитель']),
    activity_type: activity,
    source_activity: sourceActivity(row),
    okved_code_exact: okvedCodeExact,
    employees_count: row['ССЧ'],
    phones: row['Телефоны'],
    email: row['Email'],
    revenue: latestRevenue(row),
    website: row['Веб-сайт'],
    ogrn: row['ОГРН'],
  };
}

function activeStatus(schema: RegistryV2Schema): string {
  return schema === 'legal-entity' ? 'Действующее' : 'Действующий ИП';
}

function classifyRows(parsed: {
  schema: RegistryV2Schema;
  rows: CsvRow[];
}): {
  activeRows: SbisDirectoryInputRow[];
  filteredStatuses: RegistryV2FilteredStatus[];
} {
  const activeRows: SbisDirectoryInputRow[] = [];
  const filteredStatuses: RegistryV2FilteredStatus[] = [];
  const expectedStatus = activeStatus(parsed.schema);
  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2;
    const status = normalizeText(row['Статус']) ?? '';
    if (status === expectedStatus) {
      activeRows.push(toInput(row, parsed.schema, rowNumber));
    } else {
      filteredStatuses.push({
        rowNumber,
        inn: normalizeText(row['ИНН']),
        status,
      });
    }
  }
  return { activeRows, filteredStatuses };
}

function assertRootCsvEntry(entryName: string): void {
  if (
    !entryName.toLowerCase().endsWith('.csv')
    || entryName.includes('/')
    || entryName.includes('\\')
    || entryName === '.'
    || entryName === '..'
  ) {
    throw new Error(`Registry archive must contain one root CSV: ${entryName}`);
  }
}

export async function readRegistryV2Archive(
  archivePath: string,
  options: ReadRegistryV2ArchiveOptions = {},
): Promise<RegistryV2ArchiveResult> {
  const maxArchiveBytes = positiveLimit(
    options.maxArchiveBytes,
    DEFAULT_MAX_ARCHIVE_BYTES,
    'maxArchiveBytes',
  );
  const maxUncompressedBytes = positiveLimit(
    options.maxUncompressedBytes,
    DEFAULT_MAX_UNCOMPRESSED_BYTES,
    'maxUncompressedBytes',
  );
  const maxCompressionRatio = positiveLimit(
    options.maxCompressionRatio,
    DEFAULT_MAX_COMPRESSION_RATIO,
    'maxCompressionRatio',
  );
  const archiveBytes = await readFile(path.resolve(archivePath));
  if (archiveBytes.length < 1 || archiveBytes.length > maxArchiveBytes) {
    throw new Error(`Registry archive size is outside the safety limit: ${archiveBytes.length} bytes`);
  }

  let directory: Awaited<ReturnType<typeof unzipper.Open.buffer>>;
  try {
    directory = await unzipper.Open.buffer(archiveBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid registry archive: ${message}`);
  }
  if (directory.files.length === 0) {
    throw new RegistryV2ArchiveError(
      'empty_archive',
      'Registry archive is empty',
    );
  }
  if (directory.files.length !== 1) {
    throw new Error(
      `Registry archive must contain exactly one CSV file; found ${directory.files.length}`,
    );
  }
  const entry = directory.files[0];
  if (entry.type !== 'File') {
    throw new Error(`Registry archive entry is not a file: ${entry.path}`);
  }
  assertRootCsvEntry(entry.path);
  if (
    !Number.isSafeInteger(entry.uncompressedSize)
    || entry.uncompressedSize < 1
    || entry.uncompressedSize > maxUncompressedBytes
  ) {
    throw new Error(`Registry CSV entry size is too large or invalid: ${entry.uncompressedSize} bytes`);
  }
  if (
    !Number.isSafeInteger(entry.compressedSize)
    || entry.compressedSize < 1
    || entry.uncompressedSize / entry.compressedSize > maxCompressionRatio
  ) {
    throw new Error('Registry archive compression ratio exceeds the safety limit');
  }

  const csvBytes = await entry.buffer();
  if (csvBytes.length !== entry.uncompressedSize || csvBytes.length > maxUncompressedBytes) {
    throw new Error('Registry CSV extracted size does not match the ZIP directory');
  }
  const parsed = parseCsv(csvBytes, entry.path);
  const { activeRows, filteredStatuses } = classifyRows(parsed);

  return {
    archiveName: options.sourceArchiveName?.trim() || path.basename(archivePath),
    entryName: entry.path,
    archiveBytes: archiveBytes.length,
    uncompressedBytes: csvBytes.length,
    archiveSha256: sha256(archiveBytes),
    csvSha256: sha256(csvBytes),
    schema: parsed.schema,
    headers: parsed.headers,
    inputRows: parsed.rows.length,
    activeRows,
    filteredStatuses,
  };
}

export async function readRegistryV2CsvFile(
  filePath: string,
  options: { sourceFile?: string; maxBytes?: number } = {},
): Promise<RegistryV2CsvFileResult> {
  const maxBytes = positiveLimit(
    options.maxBytes,
    DEFAULT_MAX_UNCOMPRESSED_BYTES,
    'maxBytes',
  );
  const fileBytes = await readFile(path.resolve(filePath));
  if (fileBytes.length < 1 || fileBytes.length > maxBytes) {
    throw new Error(`Registry CSV file size is outside the safety limit: ${fileBytes.length} bytes`);
  }
  const parsed = parseCsv(fileBytes, path.basename(filePath));
  const { activeRows, filteredStatuses } = classifyRows(parsed);
  return {
    sourceFile: options.sourceFile?.trim() || path.basename(filePath),
    fileBytes: fileBytes.length,
    fileSha256: sha256(fileBytes),
    schema: parsed.schema,
    headers: parsed.headers,
    inputRows: parsed.rows.length,
    activeRows,
    filteredStatuses,
  };
}
