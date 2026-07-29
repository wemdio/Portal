export type DeduplicateRowsByKeyResult = {
  rows: string[][];
  duplicateCount: number;
  missingKeyCount: number;
};

const countFilledCells = (row: string[]) =>
  row.reduce((count, cell) => count + (cell.trim().length > 0 ? 1 : 0), 0);

export function deduplicateRowsByKey(
  rows: string[][],
  getKey: (row: string[]) => string | null,
): DeduplicateRowsByKeyResult {
  const bestRowByKey = new Map<string, { row: string[]; score: number }>();
  let duplicateCount = 0;
  let missingKeyCount = 0;

  for (const row of rows) {
    const key = getKey(row);
    if (!key) {
      missingKeyCount += 1;
      continue;
    }

    const score = countFilledCells(row);
    const existing = bestRowByKey.get(key);
    if (existing) duplicateCount += 1;
    if (!existing || score > existing.score) {
      bestRowByKey.set(key, { row, score });
    }
  }

  return {
    rows: [...bestRowByKey.values()].map(({ row }) => row),
    duplicateCount,
    missingKeyCount,
  };
}
