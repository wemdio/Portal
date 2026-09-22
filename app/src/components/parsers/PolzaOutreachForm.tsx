'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Play, Send } from 'lucide-react';
import type { PolzaOutreachConfig } from '@/types';
import { POLZA_OUTREACH_DEFAULT_COUNTRIES } from '@/lib/polzaOutreach/types';

type Props = {
  onStart: (config: PolzaOutreachConfig) => Promise<void>;
  busy: boolean;
};

const GEO_OPTIONS: { code: string; label: string }[] = [
  { code: 'us', label: 'USA' },
  { code: 'ca', label: 'Канада' },
  { code: 'gb', label: 'UK' },
  { code: 'de', label: 'Германия' },
  { code: 'nl', label: 'Нидерланды' },
  { code: 'fr', label: 'Франция' },
  { code: 'se', label: 'Швеция' },
  { code: 'ie', label: 'Ирландия' },
  { code: 'es', label: 'Испания' },
  { code: 'ch', label: 'Швейцария' },
  { code: 'be', label: 'Бельгия' },
  { code: 'dk', label: 'Дания' },
  { code: 'no', label: 'Норвегия' },
  { code: 'fi', label: 'Финляндия' },
  { code: 'at', label: 'Австрия' },
  { code: 'it', label: 'Италия' },
  { code: 'pl', label: 'Польша' },
  { code: 'pt', label: 'Португалия' },
  { code: 'cz', label: 'Чехия' },
];

const RECENCY_OPTIONS = [
  { days: 7, label: '7 дней' },
  { days: 14, label: '14 дней' },
  { days: 30, label: '30 дней' },
  { days: 45, label: '45 дней' },
];

export function PolzaOutreachForm({ onStart, busy }: Props) {
  const [countries, setCountries] = useState<string[]>([...POLZA_OUTREACH_DEFAULT_COUNTRIES]);
  const [days, setDays] = useState<number>(30);
  const [limit, setLimit] = useState('100');
  const [geoOpen, setGeoOpen] = useState(false);
  const geoRef = useRef<HTMLDivElement>(null);

  // Список закрывается по клику мимо и по Esc — как любое выпадающее меню.
  useEffect(() => {
    if (!geoOpen) return undefined;
    const onPointer = (e: PointerEvent) => {
      if (geoRef.current && !geoRef.current.contains(e.target as Node)) setGeoOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGeoOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [geoOpen]);

  const geoSummary = useCallback(() => {
    if (countries.length === 0) return 'Страны не выбраны';
    if (countries.length === GEO_OPTIONS.length) return 'Все страны';
    return GEO_OPTIONS.filter((option) => countries.includes(option.code))
      .map((option) => option.label)
      .join(', ');
  }, [countries]);

  const toggleCountry = (code: string) =>
    setCountries((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const config: PolzaOutreachConfig = useMemo(() => {
    const parsed = Number(limit);
    return {
      countries: countries.length ? countries : [...POLZA_OUTREACH_DEFAULT_COUNTRIES],
      posted_within_days: days,
      limit: Number.isFinite(parsed) ? Math.max(1, Math.min(1000, Math.trunc(parsed))) : 100,
    };
  }, [countries, days, limit]);

  const canStart = countries.length > 0;
  const submit = () => {
    if (!busy && canStart) void onStart(config);
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm" style={{ borderTop: '3px solid #7c3aed' }}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
              <Send className="h-4 w-4" />
            </span>
            Polza аутрич
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            IT-компании, которые прямо сейчас нанимают SDR/BDR: домен, ICP-фильтр, гео продаж из текста вакансии
            с цитатой-доказательством, корпоративная почта и готовая цепочка из 4 писем. Без отправки — только
            генерация и выгрузка.
          </p>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !canStart}
          className="inline-flex items-center justify-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Запустить
        </button>
      </div>

      {/* Девятнадцать кнопок-стран занимали две строки и тянули на себя всё
          внимание формы, хотя меняют их редко: обычно один-два раза под задачу.
          Выпадающий список держит выбор в одной строке и показывает его
          словами, а не набором подсвеченных кнопок, которые надо пересчитывать
          глазами. */}
      <div className="mt-5" ref={geoRef}>
        <label className="mb-2 block text-sm font-medium text-gray-700">Гео вакансий</label>
        <div className="relative">
          <button
            type="button"
            onClick={() => setGeoOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-800 transition hover:border-violet-400"
          >
            <span className="min-w-0 truncate">{geoSummary()}</span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
              {countries.length ? `${countries.length} из ${GEO_OPTIONS.length}` : null}
              <ChevronDown className={`h-4 w-4 transition-transform ${geoOpen ? 'rotate-180' : ''}`} />
            </span>
          </button>

          {geoOpen ? (
            <div className="absolute left-0 right-0 z-30 mt-1 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs uppercase tracking-wide text-gray-500">Откуда берём вакансии</span>
                <button
                  type="button"
                  onClick={() =>
                    setCountries((prev) =>
                      prev.length === GEO_OPTIONS.length ? [] : GEO_OPTIONS.map((option) => option.code),
                    )
                  }
                  className="rounded-md px-1.5 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-50"
                >
                  {countries.length === GEO_OPTIONS.length ? 'Снять все' : 'Выбрать все'}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {GEO_OPTIONS.map((option) => {
                  const selected = countries.includes(option.code);
                  return (
                    <button
                      key={option.code}
                      type="button"
                      onClick={() => toggleCountry(option.code)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          selected ? 'border-violet-600 bg-violet-600 text-white' : 'border-gray-300'
                        }`}
                      >
                        {selected ? <Check className="h-3 w-3" /> : null}
                      </span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">Свежесть вакансий</label>
          <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-gray-50 p-1">
            {RECENCY_OPTIONS.map((option) => {
              const selected = days === option.days;
              return (
                <button
                  key={option.days}
                  type="button"
                  onClick={() => setDays(option.days)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    selected ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Компаний (лимит, 1–1000)</span>
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            inputMode="numeric"
            placeholder="100"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
          />
        </label>
      </div>
    </div>
  );
}
