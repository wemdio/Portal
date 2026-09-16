/**
 * Lightweight RFC-4180-ish CSV parser supporting comma/semicolon/tab
 * delimiters and quoted cells. Used by the base constructor and the
 * client launch wizard.
 *
 * Delimiter handling: RFC-4180 says a CSV file uses ONE delimiter,
 * uniformly. The historical version of this parser split on `,` AND
 * `;` AND `\t` simultaneously — that was an attempt to «just work»
 * with comma-CSVs / EU-CSVs / TSVs without configuration, but it
 * silently broke any file where a non-delimiter character appeared
 * UNQUOTED inside a cell. Concrete real-world break:
 *
 *   ATSAL,B2B,...,Консалтинговые услуги;Кадровые агентства,...
 *
 * Two industries joined by `;` inside an otherwise comma-CSV file.
 * The cell is not quoted because RFC-4180 doesn't require it (`;`
 * isn't a special char in CSV). Old parser split the cell on `;`
 * and shifted every column to the right of it — the «email» column
 * ended up with vacancy text, etc.
 *
 * Fix: detect the delimiter from the FIRST ROW (looking at unquoted
 * occurrences only) and use only that one delimiter for the whole
 * file. The header is short and clean, so this is reliable.
 */

export type CsvDelimiter = ',' | ';' | '\t';

/**
 * Строка-подсказка Excel в начале файла: `sep=;`.
 *
 * Её кладут выгрузки, рассчитанные на открытие в Excel двойным щелчком —
 * например парсер 2ГИС. Для CSV это не данные и не заголовок, а служебное
 * объявление разделителя, и разбор обязан снять её до всего остального.
 *
 * 09.09.2026 конструктор баз из-за неё видел в файле ровно одну колонку с
 * именем «sep=»: строка становилась заголовком, а настоящие name, website,
 * phone уезжали в данные. Оператор при этом смотрел на тот же файл в Google
 * Sheets, где всё разложено правильно, и причину найти не мог.
 *
 * Заодно берём из неё разделитель: это её прямое назначение и источник
 * надёжнее, чем подсчёт символов в заголовке.
 */
const SEP_HINT = /^\ufeff?sep=([^\r\n]?)[^\r\n]*\r?\n/i;

export interface SeparatorHint {
  /** Текст без строки-подсказки. */
  text: string;
  /** Разделитель, если он объявлен и мы его понимаем. */
  delimiter?: CsvDelimiter;
}

export function stripSeparatorHint(text: string): SeparatorHint {
  const match = SEP_HINT.exec(text ?? '');
  if (!match) return { text: text ?? '' };
  const declared = match[1];
  const delimiter = declared === ',' || declared === ';' || declared === '	'
    ? (declared as CsvDelimiter)
    : undefined;
  return { text: (text ?? '').slice(match[0].length), delimiter };
}

/**
 * Убрать строку-подсказку из уже разобранных строк.
 *
 * Нужно для xlsx: там разбор делает библиотека, и до текста мы не добираемся, а
 * `sep=` приезжает обычной первой строкой с единственной заполненной ячейкой.
 */
export function dropSeparatorHintRow(rows: string[][]): string[][] {
  const first = rows[0];
  if (!first) return rows;
  const filled = first.filter((c) => (c ?? '').trim().length > 0);
  if (filled.length === 1 && /^sep=/i.test(filled[0].trim())) return rows.slice(1);
  return rows;
}


/**
 * Inspect the first row only (terminated by the first unquoted newline)
 * and pick the candidate delimiter that appears most often outside quoted
 * cells. Tie / all-zero → defaults to `,`. Exposed for tests and for
 * callers that already know the delimiter and want to skip detection.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // RFC-4180 escaping: doubled `""` means a literal quote.
        if (text[i + 1] === '"') {
          i += 1;
          continue;
        }
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') break;
    if (ch === ',' || ch === ';' || ch === '\t') {
      counts[ch as CsvDelimiter] += 1;
    }
  }
  // Highest count wins. Tiebreak preference: comma > semicolon > tab
  // (we encounter comma-CSVs the most). All-zero case (single-column
  // file with no delimiters in the header) → default to comma so subsequent
  // rows with a delimiter still split into the right number of cells.
  let best: CsvDelimiter = ',';
  let bestCount = counts[','];
  for (const d of [';', '\t'] as CsvDelimiter[]) {
    if (counts[d] > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  }
  return best;
}

export function parseCSV(rawText: string, delimiterOverride?: CsvDelimiter): string[][] {
  // Подсказку снимаем до всего: иначе она станет заголовком, а объявленный
  // в ней разделитель пропадёт.
  const hint = stripSeparatorHint(rawText);
  const text = hint.text;
  const delimiter = delimiterOverride ?? hint.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        current.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        current.push(cell);
        cell = '';
        if (current.some((c) => c.trim())) rows.push(current);
        current = [];
      } else {
        cell += ch;
      }
    }
  }

  current.push(cell);
  if (current.some((c) => c.trim())) rows.push(current);

  return rows;
}

type XlsxCell = {
  t?: string;
  v?: unknown;
  w?: string;
  z?: string | number;
};

function formatXlsxCell(cell: XlsxCell | undefined, ssf: typeof import('xlsx').SSF): string {
  if (!cell || cell.v == null) return '';

  if (cell.t === 'n' && typeof cell.v === 'number') {
    const format = typeof cell.z === 'string' ? cell.z : '';
    if (format && ssf.is_date(format)) {
      return ssf.format(format, cell.v);
    }
    return Number.isFinite(cell.v) ? String(cell.v) : '';
  }

  if (cell.t === 'd' && cell.v instanceof Date) {
    return cell.w || cell.v.toISOString().slice(0, 10);
  }

  return String(cell.v);
}

export async function readXlsxRows(buffer: ArrayBuffer): Promise<string[][]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array', cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const ref = ws?.['!ref'];
  if (!ws || !ref) return [];

  const range = XLSX.utils.decode_range(ref);
  const rows: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      row.push(formatXlsxCell(ws[address] as XlsxCell | undefined, XLSX.SSF));
    }
    rows.push(row);
  }
  // Та же подсказка Excel, но пришедшая уже строкой таблицы: файл из парсера
  // сохранили как xlsx вместе с ней. Снимаем здесь, а не у каждого читателя, —
  // читателей четыре, и пропустить один значит вернуть ту же поломку.
  return dropSeparatorHintRow(rows);
}

/**
 * Read a File (CSV/TSV/TXT/XLSX/XLS) into a 2D string array (header + rows).
 * Throws on unsupported format or empty file.
 */
export async function readSpreadsheetFile(file: File): Promise<string[][]> {
  const ext = file.name.split('.').pop()?.toLowerCase();

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = await file.text();
    return parseCSV(text);
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const buffer = await file.arrayBuffer();
    return readXlsxRows(buffer);
  }

  throw new Error('Поддерживаются форматы: CSV, TSV, XLSX, XLS');
}
