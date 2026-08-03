'use client';

import { endOfMonth, format, parseISO, startOfMonth, startOfYear, subDays, subMonths } from 'date-fns';

import { mskToday } from '@/lib/expenses/client';
import type { GroupBy } from '@/lib/expenses/period';

/**
 * Период и группировка — общая часть управления обеими сторонами раздела
 * «Деньги».
 *
 * Вынесено из `Filters` целиком, а не скопировано: пресеты задают ещё и
 * группировку («Год» по дням — 365 столбцов, читать нечего), и две копии этой
 * таблицы разъехались бы при первой же правке. Всё, что различается между
 * расходом и доходом, живёт в соседних рядах фильтров и сюда не заходит.
 */

export interface PeriodValue {
  from: string;
  to: string;
  groupBy: GroupBy;
}

const iso = (value: Date) => format(value, 'yyyy-MM-dd');

/**
 * Арифметика периодов ведётся от московской даты, а не от локальной даты
 * браузера: витрина раскладывает операции по московским суткам, и в поясе
 * восточнее Москвы «этот месяц» вечером первого числа уехал бы на месяц вперёд.
 */
function mskTodayDate(): Date {
  return parseISO(mskToday());
}

interface Preset {
  id: string;
  label: string;
  /** Пресет задаёт и группировку: год по дням — это 365 столбцов, читать нечего. */
  build: (today: Date) => PeriodValue;
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
export function getDefaultPeriod(): PeriodValue {
  return PRESETS[0]!.build(mskTodayDate());
}

export default function PeriodBar({
  value,
  onChange,
}: {
  value: PeriodValue;
  onChange: (next: PeriodValue) => void;
}) {
  const set = (patch: Partial<PeriodValue>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChange(preset.build(mskTodayDate()))}
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
  );
}
