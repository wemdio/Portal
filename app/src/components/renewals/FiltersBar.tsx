'use client';

import type { GroupBy } from '@/lib/firstSales/buckets';

export type FiltersState = {
  from: string;
  to: string;
  groupBy: GroupBy;
  /** Строки, а не числа — поле ввода должно допускать промежуточное
   *  состояние (пусто, «-», незаконченный ввод) без немедленного NaN. Пустая
   *  строка означает «граница не задана», разбор в число — только на выходе
   *  из компонента (см. RenewalsView). */
  kpiMin: string;
  kpiMax: string;
};

// Дашборд живёт в МСК — тот же приём, что в first-sales/FiltersBar.tsx:
// `toISOString().slice(0, 10)` режет по UTC и вечером в Москве может тихо
// указать на завтра. Сдвигаем на +3 часа и читаем через getUTC*.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function mskNow(): Date {
  return new Date(Date.now() + MSK_OFFSET_MS);
}

function toDateInputValue(mskShifted: Date): string {
  const y = mskShifted.getUTCFullYear();
  const m = String(mskShifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(mskShifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Начало «всей истории» продлений: раньше самого раннего продления, которое
 * есть в базе на момент написания (2025-07-25, см. план дашборда). Диапазон
 * дат на этой странице управляет только KPI-плитками и графиком — таблица
 * ниже от него не зависит (см. tableRows.ts) — но дефолт всё равно должен
 * показывать значимые цифры, а не «0 продлений» из-за случайного отрезания
 * истории. Фиксированная дата, а не плавающее окно «N лет назад от сегодня»:
 * при всего 32 продлениях за полтора года плавающее окно рано или поздно
 * отрежет самые старые записи молча, а фиксированная граница — нет (правда,
 * её придётся подвинуть руками, если найдётся более старая запись раньше
 * 2025-01-01 — тот же компромисс, что у остальных зашитых фактов плана).
 */
const ALL_TIME_FROM = '2025-01-01';

/** Дефолт страницы — «вся история» (единственный содержательный выбор при 32
 *  продлениях за всё время, см. отчёт по задаче), группировка по месяцам:
 *  дневная и недельная сетка на таком объёме дают в основном пустые
 *  столбики, а таблица ниже и так показывает каждую сделку по отдельности. */
export function getDefaultFilters(): FiltersState {
  return {
    from: ALL_TIME_FROM,
    to: toDateInputValue(mskNow()),
    groupBy: 'month',
    kpiMin: '',
    kpiMax: '',
  };
}

const GROUP_BY_OPTIONS: Array<{ id: GroupBy; label: string }> = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
];

export default function FiltersBar({
  value,
  onChange,
}: {
  value: FiltersState;
  onChange: (value: FiltersState) => void;
}) {
  const resetToAllTime = () => {
    onChange({ ...value, from: ALL_TIME_FROM, to: toDateInputValue(mskNow()) });
  };

  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={resetToAllTime}
          className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          Всё время
        </button>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.from}
            max={value.to}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
          <span className="text-xs text-zinc-400">—</span>
          <input
            type="date"
            value={value.to}
            min={value.from}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {GROUP_BY_OPTIONS.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onChange({ ...value, groupBy: g.id })}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                value.groupBy === g.id ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-400">KPI-факт:</span>
        <input
          type="number"
          inputMode="decimal"
          placeholder="от"
          value={value.kpiMin}
          onChange={(e) => onChange({ ...value, kpiMin: e.target.value })}
          className="w-20 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        />
        <span className="text-xs text-zinc-400">—</span>
        <input
          type="number"
          inputMode="decimal"
          placeholder="до"
          value={value.kpiMax}
          onChange={(e) => onChange({ ...value, kpiMax: e.target.value })}
          className="w-20 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
        />
        {(value.kpiMin !== '' || value.kpiMax !== '') && (
          <button
            type="button"
            onClick={() => onChange({ ...value, kpiMin: '', kpiMax: '' })}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
          >
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}
