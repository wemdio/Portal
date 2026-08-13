'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AvailableSource } from '@/lib/firstSales/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

export type FiltersState = {
  from: string;
  to: string;
  groupBy: GroupBy;
  /** Ключи источников (`enum_id` строкой либо `none`). Пусто — фильтра нет. */
  sources: string[];
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
    sources: [],
  };
}

const GROUP_BY_OPTIONS: Array<{ id: GroupBy; label: string }> = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
];

export default function FiltersBar({
  value,
  sources,
  onChange,
}: {
  value: FiltersState;
  /** Доступные источники за период. Приходят из сводки и считаются ДО фильтра —
   *  иначе, выбрав один источник, добавить второй было бы нечем. */
  sources: AvailableSource[];
  onChange: (value: FiltersState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Закрытие по клику мимо и по Escape. Панель не модальная — фокус не
  // забираем, чтобы не мешать работе с полями дат рядом.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru-RU');
    if (!q) return sources;
    return sources.filter((s) => s.label.toLocaleLowerCase('ru-RU').includes(q));
  }, [sources, query]);

  const toggleSource = (key: string) => {
    const has = value.sources.includes(key);
    onChange({
      ...value,
      sources: has ? value.sources.filter((s) => s !== key) : [...value.sources, key],
    });
  };

  // Подпись кнопки: пусто — «все», один — его название, дальше — счёт. Имя
  // единственного выбранного полезнее, чем «выбрано 1».
  const selectedLabel =
    value.sources.length === 0
      ? 'все'
      : value.sources.length === 1
        ? (sources.find((s) => s.key === value.sources[0])?.label ?? '1')
        : `выбрано ${value.sources.length}`;

  const applyPreset = (preset: Preset) => {
    const now = mskNow();
    onChange({ ...value, from: toDateInputValue(preset.from(now)), to: toDateInputValue(now) });
  };

  return (
    // relative z-30 — чтобы выпадашка источников рисовалась поверх плиток, а не
    // под ними. У `.glass-tile`/`.glass-panel` стоит `backdrop-filter`, а он
    // создаёт собственный контекст наложения: z-index внутри панели действует
    // только внутри неё, и плитки — соседи ниже по разметке — перекрывали панель
    // целиком вместе с раскрытым списком. Поднимать надо контекст самой панели.
    <div className="glass-panel relative z-30 space-y-2 px-3 py-2.5">
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

      {/* источники */}
      <div className="flex flex-wrap items-center gap-2">
        <div ref={boxRef} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="listbox"
            className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            Источники: <span className="font-medium text-zinc-900">{selectedLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>

          {open && (
            <div
              role="listbox"
              className="absolute left-0 z-20 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-lg"
            >
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск источника"
                className="mb-1 w-full rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
              />
              <div className="max-h-64 overflow-y-auto">
                {visible.map((s) => {
                  const active = value.sources.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => toggleSource(s.key)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50"
                    >
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                          active ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300'
                        }`}
                      >
                        {active && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <span className="truncate">{s.label}</span>
                      <span className="ml-auto tabular-nums text-zinc-400">{s.leads}</span>
                    </button>
                  );
                })}
                {visible.length === 0 && (
                  <p className="px-2 py-3 text-center text-xs text-zinc-400">Ничего не найдено.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {value.sources.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...value, sources: [] })}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
          >
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}
