/**
 * Excel-логика Ctrl+стрелка для таблицы баз: прыжок к краю блока данных.
 * Чистые функции без React — вся навигация тестируется без рендера
 * 13-тысячестрочного DatabaseSpreadsheet.
 */

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export const isArrowKey = (key: string): key is ArrowKey =>
  key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';

/** Первая непустая позиция начиная со start (включительно). Нет такой — граница. */
const scanToFirstFilled = (
  start: number,
  last: number,
  step: 1 | -1,
  isFilled: (position: number) => boolean,
) => {
  let position = start;
  while (position >= 0 && position <= last) {
    if (isFilled(position)) return position;
    position += step;
  }
  return step === 1 ? last : 0;
};

/**
 * Прыжок вдоль одной оси, в «позициях». Позиция — не обязательно индекс
 * строки: при активных фильтрах это индекс в списке видимых строк, чтобы
 * скрытые строки в прыжке не участвовали.
 *
 * Правила 1:1 с Excel:
 *  - текущая ячейка пустая → к ближайшей непустой в этом направлении;
 *  - текущая непустая, следующая пустая → перепрыгиваем «дыру» к следующей непустой;
 *  - текущая и следующая непустые → к последней непустой сплошного блока.
 * Непустых впереди нет → к границе таблицы (Excel так же уходит в последнюю
 * строку листа).
 */
export const findJumpPosition = (
  from: number,
  last: number,
  step: 1 | -1,
  isFilled: (position: number) => boolean,
) => {
  const next = from + step;
  if (last < 0 || next < 0 || next > last) return from;

  if (isFilled(from) && isFilled(next)) {
    let position = next;
    while (position + step >= 0 && position + step <= last && isFilled(position + step)) {
      position += step;
    }
    return position;
  }

  return scanToFirstFilled(next, last, step, isFilled);
};

export interface JumpContext {
  data: string[][];
  /** Порядок обхода строк: null — все строки, массив — только видимые (фильтры). */
  rowSequence: number[] | null;
  from: { row: number; col: number };
}

/**
 * Куда встанет курсор по Ctrl+стрелке. Возвращает null, если двигаться некуда
 * (пустая таблица) — вызывающему тогда ничего делать не нужно.
 */
export const resolveJumpTarget = (
  key: ArrowKey,
  { data, rowSequence, from }: JumpContext,
): { row: number; col: number } | null => {
  if (data.length === 0) return null;
  const { row, col } = from;

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const rowValues = data[row] ?? [];
    const lastCol = (data[0]?.length ?? 1) - 1;
    const nextCol = findJumpPosition(
      col,
      lastCol,
      key === 'ArrowRight' ? 1 : -1,
      (position) => String(rowValues[position] ?? '').trim().length > 0,
    );
    return { row, col: nextCol };
  }

  const step = key === 'ArrowDown' ? 1 : -1;
  const lastPosition = (rowSequence ? rowSequence.length : data.length) - 1;
  const isFilled = (position: number) => {
    const dataRow = rowSequence ? rowSequence[position] : position;
    return String(data[dataRow]?.[col] ?? '').trim().length > 0;
  };

  const fromPosition = rowSequence ? rowSequence.indexOf(row) : row;
  let toPosition: number;

  if (fromPosition >= 0) {
    toPosition = findJumpPosition(fromPosition, lastPosition, step, isFilled);
  } else {
    if (!rowSequence) return null;
    // Курсор стоит на строке, скрытой фильтром (обычной стрелкой туда попасть
    // можно). Такой строки нет в порядке обхода, поэтому просто уходим к
    // ближайшей видимой непустой по ходу движения — правило Excel «из пустой
    // ячейки к ближайшей непустой».
    const firstBelow = rowSequence.findIndex((index) => index > row);
    const startPosition = firstBelow < 0
      ? lastPosition
      : (step === 1 ? firstBelow : firstBelow - 1);
    if (startPosition < 0) return null;
    toPosition = scanToFirstFilled(startPosition, lastPosition, step, isFilled);
  }

  const nextRow = rowSequence ? rowSequence[toPosition] : toPosition;
  if (nextRow === undefined) return null;
  return { row: nextRow, col };
};
