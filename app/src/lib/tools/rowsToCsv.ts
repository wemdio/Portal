/**
 * Serialise a 2D array of cells to CSV, matching EXACTLY the format the base
 * constructor used to build client-side (BaseConstructorView.downloadCSV):
 * every cell wrapped in double quotes, inner quotes doubled, comma-separated,
 * newline-joined. The caller prepends a UTF-8 BOM (U+FEFF) when writing a file.
 *
 * Kept as pure standalone fns so the server download route and any future
 * client path stay byte-identical (covered by rowsToCsv.test.ts).
 */

/** One CSV line: every cell quoted, inner double-quotes doubled, comma-joined. */
export function csvLine(row: ReadonlyArray<unknown>): string {
  return row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',');
}

export function rowsToCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map(csvLine).join('\n');
}

/**
 * CSV ready to be written as a downloadable file: a UTF-8 BOM (so Excel detects
 * UTF-8) followed by the rowsToCsv body. Kept here — not inlined in the download
 * route — so the BOM is covered by tests (rowsToCsv.test.ts).
 */
export function rowsToCsvFile(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return '﻿' + rowsToCsv(rows);
}

/**
 * Streaming variant: yields the SAME bytes as rowsToCsvFile, but split into
 * chunks of `chunkRows` rows (BOM yielded first). Concatenating every yielded
 * string is byte-identical to rowsToCsvFile(rows) — locked in rowsToCsv.test.ts.
 *
 * Why: the download route used to build the entire (tens-of-MB) CSV string in
 * one synchronous pass and return it in a single response — which blocks the
 * shared portal Node event loop and, under load, stretched a 14MB export to
 * ~60s (reproduced). Streaming chunk-by-chunk (with the ReadableStream applying
 * backpressure) keeps memory flat and never monopolises the event loop.
 */
export function* rowsToCsvChunks(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  chunkRows = 1000,
): Generator<string> {
  yield '﻿';
  const step = Math.max(1, Math.floor(chunkRows) || 1);
  for (let i = 0; i < rows.length; i += step) {
    const part = rows.slice(i, i + step).map(csvLine).join('\n');
    // The very first body chunk has no leading newline; every later chunk gets
    // one, so the concatenation reproduces rows.map(csvLine).join('\n') exactly.
    yield i === 0 ? part : '\n' + part;
  }
}
