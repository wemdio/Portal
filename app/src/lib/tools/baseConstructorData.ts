/**
 * Constructor steps operate on text, but Bench accepts numeric/null cells and
 * older checkpoints retain them. Normalize at both boundaries, before header
 * mapping or any step runs. Preserve strings verbatim (including leading zeros).
 */
export function normalizeConstructorRows(rows: unknown): string[][] {
  if (!Array.isArray(rows)) {
    throw new Error('Данные конструктора должны быть массивом строк таблицы');
  }

  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(`Строка ${rowIndex + 1} должна быть массивом ячеек`);
    }

    // Most jobs already contain text. Copy only rows that need conversion,
    // without mutating the API payload or the saved checkpoint.
    let normalized = row;
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const cell: unknown = row[columnIndex];
      if (typeof cell === 'string') continue;

      let text: string;
      if (cell == null) {
        text = '';
      } else if (typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell))) {
        text = String(cell);
      } else {
        // Never silently turn a malformed object/array into "[object Object]".
        throw new Error(`Недопустимый тип ячейки: строка ${rowIndex + 1}, столбец ${columnIndex + 1}`);
      }

      if (normalized === row) normalized = row.slice();
      normalized[columnIndex] = text;
    }
    return normalized as string[];
  });
}
