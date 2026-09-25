'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Play } from 'lucide-react';
import type { PolzaOutreachConfig } from '@/types';
import { POLZA_OUTREACH_DEFAULT_COUNTRIES } from '@/lib/polzaOutreach/types';
import { SidePanel } from '@/components/ui/SidePanel';

type Props = {
  busy: boolean;
  /** Настройки прошлого запуска — приходят из кнопки «Повторить». */
  initial?: PolzaOutreachConfig | null;
  onClose: () => void;
  onStart: (config: PolzaOutreachConfig) => Promise<void>;
};

const GEO_OPTIONS: { code: string; label: string }[] = [
  { code: 'us', label: 'USA' },
  { code: 'ca', label: 'Канада' },
  { code: 'gb', label: 'UK' },
  { code: 'de', label: 'Германия' },
  { code: 'nl', label: 'Нидерланды' },
  { code: 'sg', label: 'Сингапур' },
  { code: 'au', label: 'Австралия' },
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

const inputCls =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';
const labelCls = 'mb-1 block text-sm font-medium text-gray-700';
const sectionCls = 'mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500';

/**
 * Форма запуска английского автоаутрича в выезжающей панели.
 *
 * Раньше висела раскрытым блоком над списком запусков и занимала первый экран
 * целиком, хотя её трогают раз в запуск. Часто меняемое — гео, сколько
 * компаний, свежесть и источники — осталось наверху; батч YC, размер компании
 * и порог Lead Score убраны в «Тонкую настройку».
 */
export function PolzaOutreachLaunchPanel({ busy, initial, onClose, onStart }: Props) {
  const [countries, setCountries] = useState<string[]>(initial?.countries ?? [...POLZA_OUTREACH_DEFAULT_COUNTRIES]);
  const [days, setDays] = useState<number>(initial?.posted_within_days ?? 30);
  const [limit, setLimit] = useState(String(initial?.limit ?? 500));
  const [geoOpen, setGeoOpen] = useState(false);
  const [sources, setSources] = useState<Array<'hiring' | 'yc'>>(initial?.sources ?? ['hiring', 'yc']);
  const [ycFrom, setYcFrom] = useState(String(initial?.yc_batch_from_year ?? 2023));
  const [minEmp, setMinEmp] = useState(String(initial?.min_employees ?? 3));
  const [maxEmp, setMaxEmp] = useState(String(initial?.max_employees ?? 200));
  const [writeT, setWriteT] = useState(String(initial?.write_threshold ?? 75));
  const [advanced, setAdvanced] = useState(false);
  const geoRef = useRef<HTMLDivElement>(null);

  const toggleSource = (s: 'hiring' | 'yc') => setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  // Список закрывается по клику мимо. Esc здесь не перехватываем: панель
  // закрывается по Esc сама, и два обработчика на одну клавишу дали бы
  // закрытие выпадашки вместе со всей формой.
  useEffect(() => {
    if (!geoOpen) return undefined;
    const onPointer = (e: PointerEvent) => {
      if (geoRef.current && !geoRef.current.contains(e.target as Node)) setGeoOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
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
      limit: Number.isFinite(parsed) ? Math.max(1, Math.min(1000, Math.trunc(parsed))) : 500,
      sources,
      yc_batch_from_year: Number(ycFrom) || 2023,
      min_employees: Number(minEmp) || 3,
      max_employees: Number(maxEmp) || 200,
      write_threshold: Number(writeT) || 75,
    };
  }, [countries, days, limit, sources, ycFrom, minEmp, maxEmp, writeT]);

  const canStart = countries.length > 0 && sources.length > 0;
  const submit = () => {
    if (busy || !canStart) return;
    void onStart(config);
    onClose();
  };

  return (
    <SidePanel
      open
      title={initial ? 'Повторить запуск' : 'Новый запуск'}
      hint="Без отправки: на выходе таблица, CSV и Excel с готовыми цепочками."
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">
            {!canStart ? 'Нужны хотя бы одна страна и один источник' : `${countries.length} стран · ${sources.length} источника`}
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">
              Отмена
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !canStart}
              className="inline-flex items-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Запустить
            </button>
          </span>
        </div>
      }
    >
      <p className="text-sm text-gray-600">
        B2B-компании с поводом написать: найм в sales/GTM или стартап YC. Сайт, размер и отрасль → Lead Score (fit, размер, повод, полнота
        данных) → почта только у «write now» → кейс по отрасли → цепочка из 4 писем. Сколько закажете готовых — столько и соберём, пока
        хватает кандидатов.
      </p>

      <div className="mt-5">
        <div className={sectionCls}>Основное</div>

        <div className="min-w-0" ref={geoRef}>
          <span className={labelCls}>Гео вакансий</span>
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
                    onClick={() => setCountries((prev) => (prev.length === GEO_OPTIONS.length ? [] : GEO_OPTIONS.map((o) => o.code)))}
                    className="rounded-md px-1.5 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-50"
                  >
                    {countries.length === GEO_OPTIONS.length ? 'Снять все' : 'Выбрать все'}
                  </button>
                </div>
                <div className="grid max-h-80 grid-cols-2 gap-x-2 overflow-y-auto sm:grid-cols-3">
                  {GEO_OPTIONS.map((option) => {
                    const selected = countries.includes(option.code);
                    return (
                      <button
                        key={option.code}
                        type="button"
                        onClick={() => toggleCountry(option.code)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                      >
                        <span
                          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${
                            selected ? 'border-violet-600 bg-violet-600 text-white' : 'border-gray-300'
                          }`}
                        >
                          {selected ? <Check className="h-3.5 w-3.5" /> : null}
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

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            {/* Число про выход, а не про выборку: конвейер добирает кандидатов
                волнами, пока не наберёт столько готовых компаний. */}
            <span className={labelCls}>Готовых компаний (1–1000)</span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              inputMode="numeric"
              placeholder="500"
              className={inputCls}
            />
          </label>

          <div>
            <span className={labelCls}>Свежесть вакансий</span>
            <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-gray-50 p-1">
              {RECENCY_OPTIONS.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  onClick={() => setDays(option.days)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    days === option.days ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <span className={labelCls}>Источники</span>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={sources.includes('hiring')} onChange={() => toggleSource('hiring')} />
              Вакансии sales/GTM
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={sources.includes('yc')} onChange={() => toggleSource('yc')} />
              Стартапы YC
            </label>
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 hover:text-gray-900"
        >
          {advanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Тонкая настройка
        </button>
        {!advanced && <p className="mt-1 text-xs text-gray-500">Батч YC, размер компании и порог Lead Score.</p>}

        {advanced && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={labelCls}>YC: батч не старше</span>
              <input value={ycFrom} onChange={(e) => setYcFrom(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Lead Score: пишем от</span>
              <input value={writeT} onChange={(e) => setWriteT(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputCls} />
            </label>
            <div className="sm:col-span-2">
              <span className={labelCls}>Сотрудников от / до</span>
              <div className="flex gap-2 sm:max-w-xs">
                <input value={minEmp} onChange={(e) => setMinEmp(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputCls} />
                <input value={maxEmp} onChange={(e) => setMaxEmp(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={inputCls} />
              </div>
            </div>
          </div>
        )}
      </div>
    </SidePanel>
  );
}
