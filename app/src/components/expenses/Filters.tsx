'use client';

import PeriodBar, { type PeriodValue } from '@/components/expenses/PeriodBar';
import {
  EXPENSE_CATEGORY_VALUES,
  EXPENSE_SOURCE_VALUES,
  SOURCE_LABELS,
  categoryLabel,
} from '@/lib/expenses/labels';
import type { ExpenseCategory, ExpenseSource } from '@/lib/expenses/types';

/**
 * Расходные фильтры.
 *
 * Периода здесь нет: он общий у обеих сторон раздела и живёт выше, в
 * `MoneyView` — иначе переключение «Расходы ⇄ Доходы» сбрасывало бы выбранный
 * месяц. Здесь остаётся только то, чего у дохода не бывает: источник (включая
 * карты и ручной ввод) и категория разметки.
 */
export interface FiltersValue {
  /** Пустая строка — фильтра нет. Роуты понимают `?source=` ровно так же. */
  source: ExpenseSource | '';
  category: ExpenseCategory | '';
}

export function getDefaultFilters(): FiltersValue {
  return { source: '', category: '' };
}

export default function Filters({
  period,
  onPeriodChange,
  value,
  onChange,
}: {
  period: PeriodValue;
  onPeriodChange: (next: PeriodValue) => void;
  value: FiltersValue;
  onChange: (next: FiltersValue) => void;
}) {
  const set = (patch: Partial<FiltersValue>) => onChange({ ...value, ...patch });

  return (
    <div className="glass-panel space-y-2 px-3 py-2.5">
      <PeriodBar value={period} onChange={onPeriodChange} />

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value.source}
          onChange={(e) => set({ source: e.target.value as ExpenseSource | '' })}
          aria-label="Источник"
          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        >
          <option value="">Все источники</option>
          {EXPENSE_SOURCE_VALUES.map((source) => (
            <option key={source} value={source}>
              {SOURCE_LABELS[source]}
            </option>
          ))}
        </select>

        <select
          value={value.category}
          onChange={(e) => set({ category: e.target.value as ExpenseCategory | '' })}
          aria-label="Категория"
          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        >
          <option value="">Все категории</option>
          {EXPENSE_CATEGORY_VALUES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(category)}
            </option>
          ))}
        </select>

        {value.source || value.category ? (
          <button
            type="button"
            onClick={() => set({ source: '', category: '' })}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
          >
            Сбросить фильтры
          </button>
        ) : null}

        {value.category ? (
          // Под фильтром по категории «не размечено» всегда 0 — у неразмеченной
          // строки категории нет по определению. Молча показывать ноль нельзя:
          // читается как «всё размечено».
          <span className="text-[11px] text-zinc-400">
            Под фильтром по категории неразмеченное не показывается — у него категории нет.
          </span>
        ) : null}
      </div>
    </div>
  );
}
