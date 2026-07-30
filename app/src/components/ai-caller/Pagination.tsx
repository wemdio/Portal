'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Единый размер страницы для всех списков AI-звонилки */
export const AI_CALLER_PAGE_SIZE = 30;

/**
 * Номера страниц с многоточиями: `1 … 4 5 6 … 12`.
 * До 7 страниц показываем все — многоточие там только мешает.
 */
export function pageWindow(page: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const wanted = [1, page - 1, page, page + 1, totalPages]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);

  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of wanted) {
    if (p === prev) continue;
    if (prev && p - prev > 1) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Нарезает список на страницы.
 *
 * `resetKey` — то, при смене чего листание начинается заново (фильтр,
 * выбранная кампания, сортировка). Без него после фильтрации можно было бы
 * остаться на пустой седьмой странице.
 */
export function usePagination<T>(
  items: T[],
  resetKey?: unknown,
  pageSize: number = AI_CALLER_PAGE_SIZE,
) {
  const [page, setPage] = useState(1);
  const [lastKey, setLastKey] = useState(resetKey);

  // Сброс на первую страницу при смене фильтра — рекомендованный React способ
  // «поправить state при изменении входных данных», без useEffect
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  // Список мог укоротиться (удалили запись, сменился фильтр) — не показываем пустоту
  const current = resetKey !== lastKey ? 1 : Math.min(page, totalPages);

  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize],
  );

  return { page: current, setPage, pageItems, totalPages, total: items.length, pageSize };
}

type Props = {
  page: number;
  totalPages: number;
  total: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
  /** Подпись единицы измерения: «записей», «звонков», «контактов» */
  unit?: string;
};

const BTN =
  'inline-flex items-center justify-center rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors';

export function Pagination({
  page,
  totalPages,
  total,
  pageSize = AI_CALLER_PAGE_SIZE,
  onPageChange,
  unit = 'записей',
}: Props) {
  if (totalPages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap pt-1 text-sm">
      <span className="text-gray-500">
        Показано {from}–{to} из {total} {unit}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Предыдущая страница"
          className={BTN}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {pageWindow(page, totalPages).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="px-1.5 text-gray-400">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? 'page' : undefined}
              className={
                p === page
                  ? 'inline-flex items-center justify-center rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 font-medium text-blue-600'
                  : `${BTN} px-3`
              }
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Следующая страница"
          className={BTN}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
