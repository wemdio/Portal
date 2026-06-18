/**
 * Serialise a 2D array of cells to CSV, matching EXACTLY the format the base
 * constructor used to build client-side (BaseConstructorView.downloadCSV):
 * every cell wrapped in double quotes, inner quotes doubled, comma-separated,
 * newline-joined. The caller prepends a BOM (﻿) when writing a file.
 *
 * Kept as a pure standalone fn so the server download route and any future
 * client path stay byte-identical (covered by rowsToCsv.test.ts).
 */
export function rowsToCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

/**
 * CSV ready to be written as a downloadable file: a UTF-8 BOM (so Excel detects
 * UTF-8) followed by the rowsToCsv body. Kept here — not inlined in the download
 * route — so the BOM is covered by tests (rowsToCsv.test.ts).
 */
export function rowsToCsvFile(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return '﻿' + rowsToCsv(rows);
}
