import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { LEAD_QUALITY_OPTIONS } from './leadQuality';

/**
 * Парсинг файлов импорта лидов (CSV / XLSX) для гостевой таблицы.
 * Источник файлов — Google Sheets, которые спецы вели вручную: русские
 * заголовки как в скриншотах (Контакт, Email, Имя, Организация, Сайт,
 * Запрос клиента, Качество лида, Комментарий, Из какой кампании,
 * После какого письма пришел лид, Дата лида, Взяли в работу; иногда + ИНН).
 * Неизвестные колонки игнорируются и перечисляются в ignoredColumns.
 */

export interface BoardImportRow {
  lead_email: string | null;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
  website: string | null;
  request_text: string | null;
  campaign_name: string | null;
  step_number: number | null;
  reply_timestamp: string | null;
  quality: string | null;
  comment: string | null;
  taken: boolean;
  /** Номер строки данных в файле (1-based) — для отчёта о пропусках; в БД не пишется. */
  sourceIndex?: number;
}

export interface SkippedRow {
  index: number; // номер строки данных (1-based, без заголовка)
  reason: string;
}

export interface ParseResult {
  rows: BoardImportRow[];
  skipped: SkippedRow[];
  warnings: string[];
  ignoredColumns: string[];
}

const HEADER_MAP: Record<string, keyof BoardImportRow | 'date'> = {
  'контакт': 'phone',
  'телефон': 'phone',
  'email': 'lead_email',
  'e-mail': 'lead_email',
  'почта': 'lead_email',
  'имя': 'lead_name',
  'организация': 'company_name',
  'компания': 'company_name',
  'сайт': 'website',
  'запрос клиента': 'request_text',
  'запрос': 'request_text',
  'качество лида': 'quality',
  'качество': 'quality',
  'комментарий': 'comment',
  'комментарии': 'comment',
  'из какой кампании': 'campaign_name',
  'кампания': 'campaign_name',
  'после какого письма пришел лид': 'step_number',
  'после какого письма пришёл лид': 'step_number',
  'после какого письма': 'step_number',
  'дата лида': 'date',
  'дата': 'date',
  'взяли в работу': 'taken',
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/\s+/g, ' ').trim();
}

function clean(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  return s || null;
}

const QUALITY_BY_LOWER = new Map(LEAD_QUALITY_OPTIONS.map((q) => [q.toLowerCase(), q]));

function parseQuality(raw: string | null, warnings: string[], index: number): string | null {
  if (!raw) return null;
  const q = QUALITY_BY_LOWER.get(raw.toLowerCase());
  if (!q) warnings.push(`строка ${index}: неизвестное «Качество лида» «${raw}» → пусто`);
  return q ?? null;
}

function parseTaken(raw: string | null): boolean {
  return /^(true|1|да|x|х|✓|✔|yes)$/i.test((raw ?? '').trim());
}

function parseStep(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** dd.mm.yyyy / dd/mm/yyyy / dd.mm.yy / yyyy-mm-dd → ISO timestamptz-строка. */
export function parseImportDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function mapDataRow(
  cells: string[],
  colKeys: (keyof BoardImportRow | 'date' | null)[],
  index: number,
  warnings: string[],
): BoardImportRow | null {
  const get = (key: string): string | null => {
    const i = colKeys.indexOf(key as keyof BoardImportRow | 'date');
    return i >= 0 ? clean(cells[i]) : null;
  };
  const email = get('lead_email');
  const phone = get('phone');
  if (!email && !phone) return null; // мусорная строка — нет ни email, ни контакта
  return {
    lead_email: email,
    lead_name: get('lead_name'),
    company_name: get('company_name'),
    phone,
    website: get('website'),
    request_text: get('request_text'),
    campaign_name: get('campaign_name'),
    step_number: parseStep(get('step_number')),
    reply_timestamp: parseImportDate(get('date')),
    quality: parseQuality(get('quality'), warnings, index),
    comment: get('comment'),
    taken: parseTaken(get('taken')),
  };
}

export const IMPORT_MAX_ROWS = 1000;

function rowsToObjects(grid: string[][], result: ParseResult): void {
  if (grid.length === 0) {
    result.warnings.push('файл пуст');
    return;
  }
  const headers = grid[0].map((h) => normalizeHeader(h ?? ''));
  const colKeys = headers.map((h) => HEADER_MAP[h] ?? null);
  result.ignoredColumns = grid[0]
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => h.trim() && colKeys[i] === null)
    .map(({ h }) => h.trim());
  if (!colKeys.some(Boolean)) {
    result.warnings.push(
      `не найдено ни одной знакомой колонки в заголовке: «${grid[0].join(' | ')}»`,
    );
    return;
  }
  const dataRows = grid.slice(1).filter((r) => r.some((c) => (c ?? '').trim()));
  if (dataRows.length > IMPORT_MAX_ROWS) {
    result.warnings.push(`файл обрезан до первых ${IMPORT_MAX_ROWS} строк (было ${dataRows.length})`);
  }
  dataRows.slice(0, IMPORT_MAX_ROWS).forEach((cells, i) => {
    const row = mapDataRow(cells, colKeys, i + 1, result.warnings);
    if (row) {
      row.sourceIndex = i + 1;
      result.rows.push(row);
    } else {
      result.skipped.push({ index: i + 1, reason: 'нет email и контакта' });
    }
  });
}

export function parseImportedCsv(text: string): ParseResult {
  const result: ParseResult = { rows: [], skipped: [], warnings: [], ignoredColumns: [] };
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  rowsToObjects(parsed.data ?? [], result);
  return result;
}

export function parseImportedXlsx(buf: Buffer): ParseResult {
  const result: ParseResult = { rows: [], skipped: [], warnings: [], ignoredColumns: [] };
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    result.warnings.push('xlsx без листов');
    return result;
  }
  const grid = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  rowsToObjects(grid, result);
  return result;
}

export function parseImportedFile(filename: string, buf: Buffer): ParseResult {
  const name = filename.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return parseImportedXlsx(buf);
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
    return parseImportedCsv(buf.toString('utf8'));
  }
  // Формат не по расширению: пробуем CSV (Sheet-экспорт без расширения).
  return parseImportedCsv(buf.toString('utf8'));
}
