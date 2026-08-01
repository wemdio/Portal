'use client';

import { useCallback, useMemo, useState } from 'react';

/**
 * Общий механизм сортировки таблиц дашбордов (продления, первичка, расходы).
 *
 * Три состояния по клику на заголовок — не два: возрастание → убывание →
 * сброс к исходному порядку. Третье обязательно, иначе нет пути назад к
 * порядку, который автор таблицы выбрал не случайно (например, в продлениях
 * это «свежие сверху»); без сброса пользователь либо ловит второй столбец на
 * возрастание руками (не то же самое — при равных значениях порядок внутри
 * группы может быть другим), либо перезагружает страницу.
 *
 * Клиентская сортировка: `useSortableRows` держит и сортирует ВЕСЬ переданный
 * массив `rows` в памяти на каждый рендер с активной сортировкой (`useMemo`
 * пересчитывает при смене `rows`/`sort`/`columns`). Это верно, пока таблица
 * помещается в один ответ API целиком (сейчас — единицы-десятки строк:
 * продления дашборда, разбивки по вендорам/плательщикам). Как только источник
 * станет постраничным (тысячи строк, сервер отдаёт страницами), этот хук
 * перестаёт подходить: сортировка «на клиенте» будет сортировать только
 * загрученную страницу, а не весь набор — придётся переносить сортировку на
 * сервер (ORDER BY в запросе + сброс на первую страницу при смене колонки) и
 * оставлять этот хук только как источник состояния (`sort`, `toggleSort`) для
 * UI заголовков, без вызова `sortRows`.
 */

export type SortDirection = 'asc' | 'desc';

/** Что сортировать — колонка сама решает, как достать сравниваемое значение
 *  из строки и каким типом его считать. `null`/`undefined`/пустая строка —
 *  всегда трактуются как «неизвестно» и уходят в конец списка независимо от
 *  направления, это не часть `type`, а отдельное правило ниже. */
export type SortColumnType = 'string' | 'number' | 'date';

export type SortValue = string | number | null | undefined;

export type SortColumn<Row> = {
  type: SortColumnType;
  getValue: (row: Row) => SortValue;
};

/** Набор колонок, доступных для сортировки, по ключу колонки (совпадает с
 *  `sortKey`, который передаётся в `SortableTh`/`toggleSort`). */
export type SortColumns<Row> = Record<string, SortColumn<Row>>;

export type SortState = { key: string; direction: SortDirection } | null;

function isEmptySortValue(value: SortValue): value is null | undefined {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim() === '';
}

/** Сравнение двух непустых значений одного типа. Пустые сюда не попадают —
 *  их отфильтровывает `compareSortValues` до вызова. */
function compareByType(a: string | number, b: string | number, type: SortColumnType): number {
  if (type === 'number') {
    // `Number(...)` — подстраховка на случай, если getValue вернул строку для
    // числовой колонки; в норме числовая колонка отдаёт number|null. Строки
    // здесь НЕ сравниваются как строки ('100' < '20' лексикографически) —
    // именно этого просила задача избежать.
    const an = typeof a === 'number' ? a : Number(a);
    const bn = typeof b === 'number' ? b : Number(b);
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return an - bn;
  }
  if (type === 'date') {
    // Даты в проекте — строки `YYYY-MM-DD` (см. tableRows.ts), в этом формате
    // лексикографический порядок совпадает с хронологическим — отдельный
    // разбор в Date не нужен.
    const as = String(a);
    const bs = String(b);
    if (as === bs) return 0;
    return as < bs ? -1 : 1;
  }
  // 'string' — через localeCompare с русской локалью: обычное сравнение по
  // кодам символов расставляет 'Ё' и заглавные буквы не по алфавиту.
  return String(a).localeCompare(String(b), 'ru');
}

/**
 * Сравнивает два значения колонки для сортировки в заданном направлении.
 *
 * Пустое значение — не «меньше всех» и не «больше всех», а «неизвестно»,
 * поэтому уходит в конец при ЛЮБОМ направлении: проверка пустоты стоит до
 * применения множителя направления и не участвует в `direction === 'asc' ?
 * cmp : -cmp` — иначе при сортировке по убыванию пустые всплыли бы наверх.
 */
export function compareSortValues(
  a: SortValue,
  b: SortValue,
  type: SortColumnType,
  direction: SortDirection,
): number {
  const aEmpty = isEmptySortValue(a);
  const bEmpty = isEmptySortValue(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const cmp = compareByType(a as string | number, b as string | number, type);
  return direction === 'asc' ? cmp : -cmp;
}

/** Чистая сортировка массива строк по одной колонке. Не мутирует `rows`.
 *  Полагается на стабильность `Array.prototype.sort` (гарантирована ECMA-262
 *  с 2019 года, V8/Node ей соответствует) — строки с равным значением
 *  сохраняют относительный порядок друг относительно друга. */
export function sortRows<Row>(rows: readonly Row[], column: SortColumn<Row>, direction: SortDirection): Row[] {
  return [...rows].sort((a, b) => compareSortValues(column.getValue(a), column.getValue(b), column.type, direction));
}

export type UseSortableRowsResult<Row> = {
  /** Исходный `rows`, если сортировка не активна (третье состояние — сброс),
   *  иначе отсортированная копия. */
  sortedRows: Row[];
  sort: SortState;
  /** Клик по колонке `key`: возрастание → убывание → сброс (см. заголовок
   *  файла). Колонки, которых нет в `columns`, не сортируют. */
  toggleSort: (key: string) => void;
};

/**
 * Хук состояния сортировки таблицы. См. заголовок файла про клиент/сервер и
 * трёхкликовый цикл.
 *
 * `columns` желательно передавать стабильной ссылкой (объявлять вне
 * компонента или через `useMemo`) — иначе каждый рендер получает новый
 * объект, и `useMemo` ниже не экономит на пересчёте. Для таблиц в
 * десятки строк это не имеет практического значения (пересортировать такой
 * массив дешевле, чем сам рендер), поэтому это не требование, а совет.
 */
export function useSortableRows<Row>(rows: Row[], columns: SortColumns<Row>): UseSortableRowsResult<Row> {
  const [sort, setSort] = useState<SortState>(null);

  const sortedRows = useMemo(() => {
    if (sort === null) return rows;
    const column = columns[sort.key];
    if (!column) return rows;
    return sortRows(rows, column, sort.direction);
  }, [rows, sort, columns]);

  const toggleSort = useCallback((key: string) => {
    setSort((prev) => {
      if (prev === null || prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null; // третий клик — сброс к исходному порядку
    });
  }, []);

  return { sortedRows, sort, toggleSort };
}
