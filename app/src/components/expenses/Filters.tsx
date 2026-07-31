'use client';

import { endOfMonth, format, parseISO, startOfMonth, startOfYear, subDays, subMonths } from 'date-fns';

import { mskToday } from '@/lib/expenses/client';
import {
  EXPENSE_CATEGORY_VALUES,
  EXPENSE_SOURCE_VALUES,
  SOURCE_LABELS,
  categoryLabel,
} from '@/lib/expenses/labels';
import type { GroupBy } from '@/lib/expenses/period';
import type { ExpenseCategory, ExpenseSource } from '@/lib/expenses/types';

export interface FiltersValue {
  from: string;
  to: string;
  groupBy: GroupBy;
  /** Пустая строка — фильтра нет. Роуты понимают `?source=` ровно так же. */
  source: ExpenseSource | '';
  category: ExpenseCategory | '';
}

const iso = (value: Date) => format(value, 'yyyy-MM-dd');

/**
 * Арифметика периодов ведётся от московской даты, а не от локальной даты
 * браузера: витрина раскладывает траты по московским суткам, и в поясе
 * восточнее Москвы «этот месяц» вечером первого числа уехал бы на месяц вперёд.
 */
function mskTodayDate(): Date {
  return parseISO(mskToday());
}

interface Preset {
  id: string;
  label: string;
  /** Пресет задаёт и группировку: год по дням — это 365 столбцов, читать нечего. */
  build: (today: Date) => { from: string; to: string; groupBy: GroupBy };
}

export const PRESETS: Preset[] = [
  {
    id: 'this-month',
    label: 'Этот месяц',
    build: (today) => ({ from: iso(startOfMonth(today)), to: iso(today), groupBy: 'day' }),
  },
  {
    id: 'prev-month',
    label: 'Прошлый месяц',
    build: (today) => {
      const prev = subMonths(today, 1);
      return { from: iso(startOfMonth(prev)), to: iso(endOfMonth(prev)), groupBy: 'day' };
    },
  },
  {
    id: '30d',
    label: '30 дней',
    build: (today) => ({ from: iso(subDays(today, 29)), to: iso(today), groupBy: 'day' }),
  },
  {
    id: 'quarter',
    label: 'Квартал',
    build: (today) => ({ from: iso(subDays(today, 89)), to: iso(today), groupBy: 'week' }),
  },
  {
    id: 'year',
    label: 'Год',
    build: (today) => ({ from: iso(startOfYear(today)), to: iso(today), groupBy: 'month' }),
  },
];

const GROUP_BY_OPTIONS: Array<{ id: GroupBy; label: string }> = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
];

/** Дефолт страницы — текущий месяц по дням. */
export function getDefaultFilters(): FiltersValue {
  const preset = PRESETS[0]!.build(mskTodayDate());
  return { ...preset, source: '', category: '' };
}

export default function Filters({
  value,
  onChange,
}: {
  value: FiltersValue;
  onChange: (next: FiltersValue) => void;
}) {
  const set = (patch: Partial<FiltersValue>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => set(preset.build(mskTodayDate()))}
              className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.from}
            max={value.to}
            onChange={(e) => set({ from: e.target.value })}
            aria-label="Начало периода"
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
          <span className="text-xs text-zinc-400">—</span>
          <input
            type="date"
            value={value.to}
            min={value.from}
            onChange={(e) => set({ to: e.target.value })}
            aria-label="Конец периода"
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
        </div>

        <div className="ml-auto flex items-center gap-1">
          {GROUP_BY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => set({ groupBy: option.id })}
              aria-pressed={value.groupBy === option.id}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                value.groupBy === option.id ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

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
