const EMAIL_HEADER_REGEX = /(e-?mail|email|почта|mail)/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function hasHeaderRow(data: string[][]): boolean {
  const firstRow = data[0] ?? [];
  return firstRow.some((cell) => EMAIL_HEADER_REGEX.test(cell.trim().toLowerCase()));
}

export function isRowEmpty(row: string[]): boolean {
  return row.every((cell) => cell.trim().length === 0);
}

export function countFilledCells(row: string[]): number {
  return row.reduce((acc, cell) => acc + (cell.trim().length > 0 ? 1 : 0), 0);
}

export function extractEmail(value: string): string | null {
  const match = value.match(EMAIL_REGEX);
  return match ? match[0].trim().toLowerCase() : null;
}

export function detectEmailColumns(data: string[][]): number[] {
  if (data.length === 0) return [];
  const firstRow = data[0];
  const headerMatches = firstRow
    .map((cell, idx) => (EMAIL_HEADER_REGEX.test(cell.trim().toLowerCase()) ? idx : -1))
    .filter((idx) => idx >= 0);
  if (headerMatches.length > 0) return headerMatches;

  const colCount = Math.max(...data.map((row) => row.length));
  const emailCounts = Array.from({ length: colCount }, () => 0);
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < colCount; c++) {
      if (EMAIL_REGEX.test(data[r][c] ?? '')) emailCounts[c]++;
    }
  }
  const maxCount = Math.max(0, ...emailCounts);
  if (maxCount === 0) return [];
  return emailCounts.map((count, idx) => (count === maxCount ? idx : -1)).filter((idx) => idx >= 0);
}

function getRowEmail(row: string[], emailColumns: number[]): string | null {
  for (const col of emailColumns) {
    const email = extractEmail(row[col] ?? '');
    if (email) return email;
  }
  for (const cell of row) {
    const email = extractEmail(cell ?? '');
    if (email) return email;
  }
  return null;
}

export function removeEmptyRowsAndCols(data: string[][]): string[][] {
  if (data.length <= 1) return data;
  const header = data[0];
  const body = data.slice(1).filter((row) => !isRowEmpty(row));
  const colCount = header.length;
  const nonEmptyCols: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const hasData = body.some((row) => (row[c] ?? '').trim().length > 0);
    const hasHeader = (header[c] ?? '').trim().length > 0;
    if (hasData || hasHeader) nonEmptyCols.push(c);
  }
  const pick = (row: string[]) => nonEmptyCols.map((c) => row[c] ?? '');
  return [pick(header), ...body.map(pick)];
}

export function deduplicateRows(data: string[][]): string[][] {
  if (data.length <= 1) return data;
  const header = data[0];
  const body = data.slice(1);
  const seen = new Set<string>();
  const next: string[][] = [];
  for (const row of body) {
    const key = row.join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(row);
  }
  return [header, ...next];
}

export function deduplicateByEmail(data: string[][]): string[][] {
  if (data.length <= 1) return data;
  const header = data[0];
  const body = data.slice(1);
  const emailColumns = detectEmailColumns(data);

  const emailMap = new Map<string, { row: string[]; score: number }>();
  const rowsWithoutEmail: string[][] = [];

  for (const row of body) {
    const email = getRowEmail(row, emailColumns);
    if (!email) {
      rowsWithoutEmail.push(row);
      continue;
    }
    const score = countFilledCells(row);
    const existing = emailMap.get(email);
    if (!existing || score > existing.score) {
      emailMap.set(email, { row, score });
    }
  }

  const afterEmailDedup = [
    ...Array.from(emailMap.values()).map((item) => item.row),
    ...rowsWithoutEmail,
  ];

  if (emailColumns.length === 0) return [header, ...afterEmailDedup];

  const ignoreSet = new Set(emailColumns);
  const rowMap = new Map<string, { row: string[]; score: number }>();
  for (const row of afterEmailDedup) {
    const keyParts = row.filter((_, idx) => !ignoreSet.has(idx)).map((c) => c.trim());
    const hasNonEmail = keyParts.some((v) => v.length > 0);
    const key = hasNonEmail ? keyParts.join('\u0001') : row.join('\u0001');
    const score = countFilledCells(row);
    const existing = rowMap.get(key);
    if (!existing || score > existing.score) {
      rowMap.set(key, { row, score });
    }
  }
  return [header, ...Array.from(rowMap.values()).map((item) => item.row)];
}

export function findColumnIndex(header: string[], ...names: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

export async function processInPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
