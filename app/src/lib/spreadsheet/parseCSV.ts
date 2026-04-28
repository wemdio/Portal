/**
 * Lightweight RFC-4180-ish CSV parser supporting comma/semicolon/tab delimiters
 * and quoted cells. Used by the base constructor and the client launch wizard.
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',' || ch === ';' || ch === '\t') {
        current.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
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
    const { read, utils } = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const wb = read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: unknown[][] = utils.sheet_to_json(ws, { header: 1, defval: '' });
    return rows.map((r) => r.map((c) => (c == null ? '' : String(c))));
  }

  throw new Error('Поддерживаются форматы: CSV, TSV, XLSX, XLS');
}
