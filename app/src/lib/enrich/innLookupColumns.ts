/**
 * Resolve target column indices for the "Найти ИНН" feature.
 *
 * Returns existing column indices if the headers are already present, or
 * pre-computes the indices that will be assigned to newly appended columns.
 *
 * Critical: indices MUST be computed synchronously (not inside a React
 * setState updater callback) so that subsequent batch writes know exactly
 * which column to populate. Mutating shared state inside an updater is
 * unsafe because React 18 may defer the updater past the next statements.
 */
export type InnLookupColumns = {
  innCol: number;
  compCol: number;
  /** Labels (in append order) that need to be added as new header cells. */
  missingLabels: string[];
};

export function resolveInnLookupColumns(
  headerRow: readonly unknown[],
  innLabel: string,
  companyLabel: string,
): InnLookupColumns {
  const existing = headerRow.map((h) => String(h ?? '').trim());

  let innCol = existing.indexOf(innLabel);
  let compCol = existing.indexOf(companyLabel);

  const missingLabels: string[] = [];
  let nextCol = headerRow.length;

  if (innCol === -1) {
    innCol = nextCol;
    nextCol += 1;
    missingLabels.push(innLabel);
  }
  if (compCol === -1) {
    compCol = nextCol;
    nextCol += 1;
    missingLabels.push(companyLabel);
  }

  return { innCol, compCol, missingLabels };
}
