'use client';

import { FIRST_SALES_CHANNELS, CHANNEL_LABELS, type FirstSalesChannel } from '@/lib/firstSales/sourceChannels';
import type { GroupBy } from '@/lib/firstSales/buckets';

export type FiltersState = {
  from: string;
  to: string;
  groupBy: GroupBy;
  channels: FirstSalesChannel[];
};

// Дашборд живёт в МСК (та же зона, что buckets.ts/params.ts на сервере), а
// `toISOString().slice(0, 10)` режет дату по UTC. Вечером в Москве (после
// 21:00 UTC-часов, то есть после полуночи МСК ещё нет, а UTC-сутки уже
// сменились) пресет «сегодня» тихо укажет на завтрашний день. Сдвигаем
// таймстемп на +3 часа и дальше читаем через getUTC* — тот же приём, что
// `toMsk` в buckets.ts, — чтобы получить именно московские сутки.
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

function shiftDays(mskShifted: Date, days: number): Date {
  return new Date(Date.UTC(
    mskShifted.getUTCFullYear(),
    mskShifted.getUTCMonth(),
    mskShifted.getUTCDate() + days,
  ));
}

function shiftMonths(mskShifted: Date, months: number): Date {
  return new Date(Date.UTC(
    mskShifted.getUTCFullYear(),
    mskShifted.getUTCMonth() + months,
    mskShifted.getUTCDate(),
  ));
}

type Preset = { id: string; label: string; from: (now: Date) => Date };

const PRESETS: Preset[] = [
  { id: '30d', label: '30 дней', from: (now) => shiftDays(now, -29) },
  { id: 'quarter', label: 'Квартал', from: (now) => shiftMonths(now, -3) },
  { id: 'year', label: 'Год', from: (now) => shiftMonths(now, -12) },
];

/** Дефолт страницы — последние 30 дней в МСК, группировка по дням, без
 *  фильтра по каналам. Вынесено сюда, а не задано инлайн в FirstSalesView,
 *  чтобы арифметика границ периода жила в одном месте с пресетами. */
export function getDefaultFilters(): FiltersState {
  const now = mskNow();
  return {
    from: toDateInputValue(PRESETS[0]!.from(now)),
    to: toDateInputValue(now),
    groupBy: 'day',
    channels: [],
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
  const applyPreset = (preset: Preset) => {
    const now = mskNow();
    onChange({ ...value, from: toDateInputValue(preset.from(now)), to: toDateInputValue(now) });
  };

  const toggleChannel = (channel: FirstSalesChannel) => {
    const has = value.channels.includes(channel);
    onChange({
      ...value,
      channels: has ? value.channels.filter((c) => c !== channel) : [...value.channels, channel],
    });
  };

  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
      {/* период */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
            >
              {p.label}
            </button>
          ))}
        </div>
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

      {/* каналы */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FIRST_SALES_CHANNELS.map((channel) => {
          const active = value.channels.includes(channel);
          return (
            <button
              key={channel}
              type="button"
              onClick={() => toggleChannel(channel)}
              aria-pressed={active}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                active
                  ? 'border-zinc-900 bg-zinc-900 text-white'
                  : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50'
              }`}
            >
              {CHANNEL_LABELS[channel]}
            </button>
          );
        })}
        {value.channels.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...value, channels: [] })}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
          >
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}
