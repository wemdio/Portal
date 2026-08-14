/**
 * @jest-environment node
 */

import { resolveJumpTarget } from '@/lib/databases/gridNavigation';

// Строка 0 — шапка, дальше блок данных, дыра, ещё блок, хвост пустых строк —
// ровно та форма, на которой Ctrl+стрелка ведёт себя нетривиально.
const DATA = [
  ['Компания', 'Сайт', 'ИНН'], // 0
  ['Альфа', 'alfa.ru', '7700000001'], // 1
  ['Бета', 'beta.ru', '7700000002'], // 2
  ['Гамма', 'gamma.ru', '7700000003'], // 3
  ['', '', ''], // 4 — дыра
  ['Дельта', 'delta.ru', '7700000004'], // 5
  ['Эпсилон', 'epsilon.ru', '7700000005'], // 6
  ['', '', ''], // 7 — хвост
  ['', '', ''], // 8
];

const at = (row: number, col: number) => ({ data: DATA, rowSequence: null, from: { row, col } });

describe('resolveJumpTarget — вертикаль', () => {
  it('из шапки прыгает на конец сплошного блока', () => {
    expect(resolveJumpTarget('ArrowDown', at(0, 0))).toEqual({ row: 3, col: 0 });
  });

  it('с последней заполненной строки блока перепрыгивает дыру к следующей непустой', () => {
    expect(resolveJumpTarget('ArrowDown', at(3, 0))).toEqual({ row: 5, col: 0 });
  });

  it('из пустой ячейки идёт к ближайшей непустой', () => {
    expect(resolveJumpTarget('ArrowDown', at(4, 0))).toEqual({ row: 5, col: 0 });
  });

  it('если непустых впереди нет — уходит в последнюю строку таблицы (как Excel)', () => {
    expect(resolveJumpTarget('ArrowDown', at(6, 0))).toEqual({ row: 8, col: 0 });
  });

  it('вверх работает симметрично', () => {
    expect(resolveJumpTarget('ArrowUp', at(6, 0))).toEqual({ row: 5, col: 0 });
    expect(resolveJumpTarget('ArrowUp', at(5, 0))).toEqual({ row: 3, col: 0 });
    expect(resolveJumpTarget('ArrowUp', at(3, 0))).toEqual({ row: 0, col: 0 });
  });

  it('на границе таблицы остаётся на месте', () => {
    expect(resolveJumpTarget('ArrowUp', at(0, 0))).toEqual({ row: 0, col: 0 });
    expect(resolveJumpTarget('ArrowDown', at(8, 0))).toEqual({ row: 8, col: 0 });
  });
});

describe('resolveJumpTarget — горизонталь', () => {
  it('идёт до последней заполненной колонки строки', () => {
    expect(resolveJumpTarget('ArrowRight', at(1, 0))).toEqual({ row: 1, col: 2 });
  });

  it('в пустой строке уходит к границе', () => {
    expect(resolveJumpTarget('ArrowRight', at(4, 0))).toEqual({ row: 4, col: 2 });
    expect(resolveJumpTarget('ArrowLeft', at(4, 2))).toEqual({ row: 4, col: 0 });
  });

  it('строку не меняет', () => {
    expect(resolveJumpTarget('ArrowLeft', at(6, 2))).toEqual({ row: 6, col: 0 });
  });
});

describe('resolveJumpTarget — с активными фильтрами', () => {
  // Фильтр оставил строки 1, 3, 5 (плюс шапку — она всегда видима).
  const rowSequence = [0, 1, 3, 5];

  it('ходит только по видимым строкам, скрытые не участвуют', () => {
    expect(
      resolveJumpTarget('ArrowDown', { data: DATA, rowSequence, from: { row: 0, col: 0 } }),
    ).toEqual({ row: 5, col: 0 });
  });

  it('вверх тоже держится видимых строк', () => {
    expect(
      resolveJumpTarget('ArrowUp', { data: DATA, rowSequence, from: { row: 5, col: 0 } }),
    ).toEqual({ row: 0, col: 0 });
  });

  it('с курсора на скрытой строке стартует от ближайшей видимой', () => {
    // Строка 4 скрыта фильтром — обычной стрелкой туда попасть можно.
    expect(
      resolveJumpTarget('ArrowDown', { data: DATA, rowSequence, from: { row: 4, col: 0 } }),
    ).toEqual({ row: 5, col: 0 });
    expect(
      resolveJumpTarget('ArrowUp', { data: DATA, rowSequence, from: { row: 4, col: 0 } }),
    ).toEqual({ row: 3, col: 0 });
  });
});

describe('resolveJumpTarget — вырожденные случаи', () => {
  it('пустая таблица — двигаться некуда', () => {
    expect(resolveJumpTarget('ArrowDown', { data: [], rowSequence: null, from: { row: 0, col: 0 } }))
      .toBeNull();
  });

  it('одна строка — остаёмся на месте', () => {
    const data = [['a', 'b']];
    expect(resolveJumpTarget('ArrowDown', { data, rowSequence: null, from: { row: 0, col: 0 } }))
      .toEqual({ row: 0, col: 0 });
  });

  it('пробелы считаются пустой ячейкой', () => {
    const data = [['a'], ['   '], ['b']];
    expect(resolveJumpTarget('ArrowDown', { data, rowSequence: null, from: { row: 0, col: 0 } }))
      .toEqual({ row: 2, col: 0 });
  });
});
