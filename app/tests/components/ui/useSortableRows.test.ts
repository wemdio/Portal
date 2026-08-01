import { act, renderHook } from '@testing-library/react';
import { compareSortValues, sortRows, useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';

type Row = { id: string; name: string | null; amount: number | null; date: string | null };

function row(over: Partial<Row> = {}): Row {
  return { id: 'r', name: null, amount: null, date: null, ...over };
}

const columns: SortColumns<Row> = {
  name: { type: 'string', getValue: (r) => r.name },
  amount: { type: 'number', getValue: (r) => r.amount },
  date: { type: 'date', getValue: (r) => r.date },
};

describe('useSortableRows — цикл направлений и сброс', () => {
  it('без клика отдаёт исходный порядок как есть', () => {
    const rows = [row({ id: 'b', amount: 2 }), row({ id: 'a', amount: 1 })];
    const { result } = renderHook(() => useSortableRows(rows, columns));
    expect(result.current.sort).toBeNull();
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('первый клик — возрастание, второй — убывание, третий — сброс к исходному порядку', () => {
    const rows = [row({ id: 'b', amount: 2 }), row({ id: 'a', amount: 1 })];
    const { result } = renderHook(() => useSortableRows(rows, columns));

    act(() => result.current.toggleSort('amount'));
    expect(result.current.sort).toEqual({ key: 'amount', direction: 'asc' });
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['a', 'b']);

    act(() => result.current.toggleSort('amount'));
    expect(result.current.sort).toEqual({ key: 'amount', direction: 'desc' });
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['b', 'a']);

    act(() => result.current.toggleSort('amount'));
    expect(result.current.sort).toBeNull();
    // Тот же порядок, что был до первого клика — не пересчитанный «asc» и не
    // «desc», а именно исходный массив.
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(result.current.sortedRows).toBe(rows);
  });

  it('клик по другой колонке сбрасывает предыдущую и стартует с возрастания', () => {
    const rows = [row({ id: 'a', amount: 1, name: 'б' }), row({ id: 'b', amount: 2, name: 'а' })];
    const { result } = renderHook(() => useSortableRows(rows, columns));

    act(() => result.current.toggleSort('amount'));
    act(() => result.current.toggleSort('amount')); // amount -> desc
    act(() => result.current.toggleSort('name')); // переключились на другую колонку

    expect(result.current.sort).toEqual({ key: 'name', direction: 'asc' });
    expect(result.current.sortedRows.map((r) => r.id)).toEqual(['b', 'a']); // 'а' < 'б'
  });
});

describe('sortRows — пустые значения всегда в конце', () => {
  const rows = [row({ id: 'mid', amount: 20 }), row({ id: 'empty', amount: null }), row({ id: 'low', amount: 5 })];

  it('по возрастанию пустые всё равно последние', () => {
    expect(sortRows(rows, columns.amount, 'asc').map((r) => r.id)).toEqual(['low', 'mid', 'empty']);
  });

  it('по убыванию пустые всё равно последние, а не первые', () => {
    expect(sortRows(rows, columns.amount, 'desc').map((r) => r.id)).toEqual(['mid', 'low', 'empty']);
  });

  it('пустая строка ("") тоже считается пустой, а не строкой', () => {
    const withBlank = [row({ id: 'blank', name: '' }), row({ id: 'value', name: 'а' })];
    expect(sortRows(withBlank, columns.name, 'asc').map((r) => r.id)).toEqual(['value', 'blank']);
    expect(sortRows(withBlank, columns.name, 'desc').map((r) => r.id)).toEqual(['value', 'blank']);
  });

  it('несколько пустых значений между собой не переставляются местами беспорядочно', () => {
    const rowsWithTwoEmpty = [row({ id: 'e1', amount: null }), row({ id: 'val', amount: 1 }), row({ id: 'e2', amount: null })];
    const sorted = sortRows(rowsWithTwoEmpty, columns.amount, 'asc');
    expect(sorted[0].id).toBe('val');
    expect(sorted.slice(1).map((r) => r.id).sort()).toEqual(['e1', 'e2']);
  });
});

describe('compareSortValues — числа сравниваются как числа, а не как строки', () => {
  it('100 больше 20: строковое сравнение дало бы обратный результат', () => {
    const rows = [row({ id: 'twenty', amount: 20 }), row({ id: 'hundred', amount: 100 })];
    expect(sortRows(rows, columns.amount, 'asc').map((r) => r.id)).toEqual(['twenty', 'hundred']);
    expect(compareSortValues(100, 20, 'number', 'asc')).toBeGreaterThan(0);
    expect(compareSortValues('100', '20', 'number', 'asc')).toBeGreaterThan(0);
  });
});

describe('compareSortValues — русские строки сортируются по алфавиту', () => {
  it('учитывает «Ё» и регистр, как ожидает русскоязычный пользователь', () => {
    const rows = [
      row({ id: 'yozh', name: 'Ёж' }),
      row({ id: 'apple', name: 'яблоко' }),
      row({ id: 'apricot', name: 'Абрикос' }),
      row({ id: 'banana', name: 'банан' }),
    ];
    // Абрикос(А) < банан(Б) < Ёж(Ё) < яблоко(Я) — обычный алфавитный порядок,
    // а не порядок кодов символов (где заглавная 'А' и строчная 'б' разошлись
    // бы иначе, а 'Ё' улетела бы в конец после 'я', так как код U+0401 больше
    // всех кодов U+0430–U+044F).
    expect(sortRows(rows, columns.name, 'asc').map((r) => r.id)).toEqual(['apricot', 'banana', 'yozh', 'apple']);
  });

  it('направление убывания переворачивает алфавитный порядок', () => {
    const rows = [row({ id: 'a', name: 'а' }), row({ id: 'b', name: 'б' })];
    expect(sortRows(rows, columns.name, 'desc').map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('compareSortValues — тип "date" сравнивает как строку YYYY-MM-DD', () => {
  it('лексикографический порядок совпадает с хронологическим', () => {
    const rows = [row({ id: 'new', date: '2026-07-15' }), row({ id: 'old', date: '2025-01-01' })];
    expect(sortRows(rows, columns.date, 'asc').map((r) => r.id)).toEqual(['old', 'new']);
    expect(sortRows(rows, columns.date, 'desc').map((r) => r.id)).toEqual(['new', 'old']);
  });
});
