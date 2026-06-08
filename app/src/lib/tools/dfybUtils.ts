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

  const colCount = data.reduce((max, row) => (row.length > max ? row.length : max), 0);
  const emailCounts = Array.from({ length: colCount }, () => 0);
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < colCount; c++) {
      if (EMAIL_REGEX.test(data[r][c] ?? '')) emailCounts[c]++;
    }
  }
  const maxCount = emailCounts.reduce((max, c) => (c > max ? c : max), 0);
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

  return [header, ...afterEmailDedup];
}

export function findColumnIndex(header: string[], ...names: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

const PRIMARY_SITE_HEADERS = [
  'company_site_url',
  'company site url',
  'company website',
  'company_website',
  'company site',
  'company domain',
  'company_domain',
  'сайт компании',
  'сайт_компании',
  'url сайта компании',
];

const GENERIC_SITE_HEADERS = ['сайт', 'site', 'website', 'домен', 'domain'];
const LEGACY_URL_HEADERS = ['url'];

export function findPreferredSiteColumnIndexes(header: string[]): number[] {
  const lower = header.map((h) => h.trim().toLowerCase());
  const indexes: number[] = [];

  for (const group of [PRIMARY_SITE_HEADERS, GENERIC_SITE_HEADERS, LEGACY_URL_HEADERS]) {
    for (const name of group) {
      const idx = lower.indexOf(name.toLowerCase());
      if (idx >= 0 && !indexes.includes(idx)) indexes.push(idx);
    }
  }

  return indexes;
}

function parseUrlForLookup(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

export function isRejectedSiteLookupUrl(value: string): boolean {
  const url = parseUrlForLookup(value);
  if (!url) return false;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const isHhHost = host === 'hh.ru' || host.endsWith('.hh.ru') || host === 'headhunter.ru' || host.endsWith('.headhunter.ru');
  if (!isHhHost) return false;

  const pathname = url.pathname.toLowerCase();
  return pathname.startsWith('/vacancy') || pathname.startsWith('/employer') || pathname.startsWith('/search/vacancy');
}

export function getPreferredSiteUrl(row: string[], siteColumnIndexes: number[]): string {
  for (const idx of siteColumnIndexes) {
    const value = (row[idx] ?? '').trim();
    if (!value || isRejectedSiteLookupUrl(value)) continue;
    return value;
  }
  return '';
}

export interface ProcessInPoolOptions<T, R> {
  /**
   * Hard ceiling per task (ms). After this the worker abandons the in-flight
   * promise and writes a sentinel into the slot — keeps the pool moving when
   * an item silently hangs (e.g. tarpit proxy that holds the TCP socket open
   * without responding).
   *
   * NB: this does NOT cancel the underlying work — for that, `fn` itself must
   * accept and honor an AbortSignal. We pass one via `fn(item, i, signal)` so
   * implementations can wire it into their own fetch/AbortController.
   *
   * Defaults to no timeout (legacy behavior) when not set.
   */
  taskTimeoutMs?: number;
  /**
   * Sentinel value written into `results[i]` when the timeout fires.
   * Must return an `R` so the result array stays well-typed. Default: returns
   * `undefined as R` — fine for callers that already mutate side-state inside
   * `fn` (most enrich/scrape callsites do).
   */
  onTimeout?: (item: T, index: number) => R;
}

export async function processInPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  opts?: ProcessInPoolOptions<T, R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const taskTimeoutMs = opts?.taskTimeoutMs ?? 0;
  const onTimeout = opts?.onTimeout;
  let nextIdx = 0;

  async function runOne(i: number): Promise<R> {
    if (taskTimeoutMs <= 0) return fn(items[i], i);

    const controller = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<R>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        const sentinel = onTimeout ? onTimeout(items[i], i) : (undefined as unknown as R);
        resolve(sentinel);
      }, taskTimeoutMs);
    });
    try {
      const winner = await Promise.race([
        fn(items[i], i, controller.signal),
        timeoutPromise,
      ]);
      return winner;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async function worker() {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      try {
        results[i] = await runOne(i);
      } catch {
        // Task threw — keep its slot undefined so the caller's own
        // try/catch inside `fn` is the source of truth for per-item errors.
        // We still must catch here, otherwise one bad task kills the pool.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
