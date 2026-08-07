'use client';

import PeriodBar, { type PeriodValue } from '@/components/expenses/PeriodBar';
import { INCOME_SOURCE_VALUES, sourceLabel } from '@/lib/expenses/labels';
import type { IncomeSource } from '@/lib/expenses/types';

/**
 * Доходные фильтры.
 *
 * Короче расходных на целый ряд, и это не недоделка: категорий у прихода нет —
 * разметки на доходной стороне не существует, а разрез идёт по плательщику из
 * самой выписки. Осталось то, что у дохода действительно есть, — банк.
 */
export interface IncomeFiltersValue {
  /** Пустая строка — фильтра нет. Роуты понимают `?source=` ровно так же. */
  source: IncomeSource | '';
}

export function getDefaultIncomeFilters(): IncomeFiltersValue {
  return { source: '' };
}

export default function IncomeFilters({
  period,
  onPeriodChange,
  value,
  onChange,
}: {
  period: PeriodValue;
  onPeriodChange: (next: PeriodValue) => void;
  value: IncomeFiltersValue;
  onChange: (next: IncomeFiltersValue) => void;
}) {
  return (
    <div className="glass-panel space-y-2 px-3 py-2.5">
      <PeriodBar value={period} onChange={onPeriodChange} />

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value.source}
          onChange={(e) => onChange({ source: e.target.value as IncomeSource | '' })}
          aria-label="Источник"
          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        >
          <option value="">Все источники</option>
          {INCOME_SOURCE_VALUES.map((source) => (
            <option key={source} value={source}>
              {sourceLabel(source)}
            </option>
          ))}
        </select>

        {value.source ? (
          <button
            type="button"
            onClick={() => onChange({ source: '' })}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
          >
            Сбросить фильтры
          </button>
        ) : null}

        <span className="text-[11px] text-zinc-400">
          Приход только по счетам в банках: карты и ручные записи бывают лишь на расходной стороне.
        </span>
      </div>
    </div>
  );
}
