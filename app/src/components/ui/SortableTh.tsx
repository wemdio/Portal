'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { SortState } from '@/components/ui/useSortableRows';

/**
 * Заголовок сортируемого столбца таблицы.
 *
 * - `aria-sort` стоит на самом `<th>` (по спеке WAI-ARIA это его место, не
 *   кнопки внутри) и принимает `'ascending'|'descending'|'none'`.
 * - Клик — на `<button>` внутри `<th>`, не на самом `<th>`: так столбец
 *   получает фокус и клавиатурную активацию (Enter/Space) бесплатно, без
 *   ручных `tabIndex`/`role`/`onKeyDown`.
 * - Индикатор направления виден всегда (не только при наведении) — блёклые
 *   двусторонние стрелки на несортированной колонке сигналят «здесь можно
 *   сортировать», иначе кликабельность заголовков ничем не выдана.
 * - `title` на кнопке проговаривает механику трёх кликов: сама она не
 *   очевидна (сброс третьим кликом — не то, что пользователь ждёт от
 *   обычного тумблера возрастание/убывание).
 */
export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: React.ReactNode;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const isActive = sort !== null && sort.key === sortKey;
  const direction = isActive ? sort.direction : null;
  const ariaSort: 'ascending' | 'descending' | 'none' =
    direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';

  return (
    <th scope="col" aria-sort={ariaSort} className={`select-none px-3 py-2 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title="Клик — по возрастанию, ещё раз — по убыванию, третий клик — исходный порядок"
        className={`inline-flex items-center gap-1 hover:text-zinc-600 ${
          align === 'right' ? 'w-full flex-row-reverse' : ''
        } ${isActive ? 'text-zinc-600' : 'text-zinc-400'}`}
      >
        <span>{label}</span>
        {direction === 'asc' && <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />}
        {direction === 'desc' && <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />}
        {direction === null && <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden />}
      </button>
    </th>
  );
}

export default SortableTh;
