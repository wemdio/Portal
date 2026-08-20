/**
 * Авто-детект колонки с ИНН в распарсенной таблице (readSpreadsheetFile)
 * и извлечение уникальных валидных ИНН из неё.
 *
 * Эвристика: колонка-кандидат — та, где ≥80% непустых ячеек данных
 * нормализуются в ИНН. Строка 0 считается заголовком, если её ячейка в
 * этой колонке непустая и сама не ИНН. При равенстве validCount побеждает
 * колонка с заголовком «ИНН». Известный false-positive — колонка ОКПО
 * (10 цифр): UI даёт ручной выбор колонки, детект нужен как дефолт.
 */

import { dedupeInns, normalizeInn } from './inn';

export interface InnColumnDetection {
  /** -1, если подходящей колонки нет. */
  columnIndex: number;
  /** true, если строка 0 похожа на заголовок (непустая не-ИНН ячейка). */
  hasHeader: boolean;
  /** Сколько валидных ИНН в строках данных выбранной колонки. */
  validCount: number;
  /** Сколько строк данных участвовало в оценке выбранной колонки. */
  totalDataRows: number;
}

const MIN_VALID_RATIO = 0.8;
const SAMPLE_LIMIT = 1000;
const HEADER_HINT = /инн|inn/i;

interface ColumnScore {
  columnIndex: number;
  hasHeader: boolean;
  validCount: number;
  totalDataRows: number;
  headerHint: boolean;
}

function scoreColumn(rows: string[][], columnIndex: number): ColumnScore | null {
  const headerCell = (rows[0]?.[columnIndex] ?? '').trim();
  const hasHeader = headerCell !== '' && normalizeInn(headerCell) === null;
  const startRow = hasHeader ? 1 : 0;

  let nonEmpty = 0;
  let validCount = 0;
  const end = Math.min(rows.length, startRow + SAMPLE_LIMIT);
  for (let r = startRow; r < end; r += 1) {
    const cell = (rows[r]?.[columnIndex] ?? '').trim();
    if (cell === '') continue;
    nonEmpty += 1;
    if (normalizeInn(cell) !== null) validCount += 1;
  }

  if (nonEmpty === 0) return null;
  if (validCount / nonEmpty < MIN_VALID_RATIO) return null;

  return {
    columnIndex,
    hasHeader,
    validCount,
    totalDataRows: rows.length - startRow,
    headerHint: HEADER_HINT.test(headerCell),
  };
}

export function detectInnColumn(rows: string[][]): InnColumnDetection {
  const empty: InnColumnDetection = { columnIndex: -1, hasHeader: false, validCount: 0, totalDataRows: 0 };
  if (rows.length === 0) return empty;

  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let best: ColumnScore | null = null;

  for (let c = 0; c < maxCols; c += 1) {
    const score = scoreColumn(rows, c);
    if (!score) continue;
    if (
      !best ||
      score.validCount > best.validCount ||
      (score.validCount === best.validCount && score.headerHint && !best.headerHint)
    ) {
      best = score;
    }
  }

  return best ?? empty;
}

/**
 * Уникальные валидные ИНН из выбранной колонки в порядке строк.
 * invalidCount — непустые ячейки, не нормализовавшиеся в ИНН (пустые не
 * считаем: разряженная колонка — норма, мусор — нет).
 */
export function extractInns(
  rows: string[][],
  columnIndex: number,
  hasHeader: boolean,
): { inns: string[]; invalidCount: number } {
  const startRow = hasHeader ? 1 : 0;
  const valid: string[] = [];
  let invalidCount = 0;

  for (let r = startRow; r < rows.length; r += 1) {
    const cell = (rows[r]?.[columnIndex] ?? '').trim();
    if (cell === '') continue;
    const inn = normalizeInn(cell);
    if (inn === null) invalidCount += 1;
    else valid.push(inn);
  }

  return { inns: dedupeInns(valid), invalidCount };
}
