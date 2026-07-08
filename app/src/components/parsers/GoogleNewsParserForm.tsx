'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Globe, Play, Loader2, Settings2, Shield } from 'lucide-react';
import { GOOGLE_LANGUAGES, GOOGLE_REGIONS, ensureLocaleOption } from '@/lib/parsers/googleLocales';

export type GoogleNewsDateRange = 'any' | 'hour' | 'day' | 'week' | 'month' | 'year';

export type GoogleNewsFormValues = {
  queries: string;
  pagesLimit: number;
  country: string;
  language: string;
  dateRange: GoogleNewsDateRange;
  minDelayMs: number;
  maxDelayMs: number;
  proxies: string;
};

export type GoogleNewsParserFormProps = {
  initialValues?: Partial<GoogleNewsFormValues>;
  submitting?: boolean;
  onSubmit: (values: {
    queries: string[];
    pagesLimit: number;
    country: string;
    language: string;
    dateRange: GoogleNewsDateRange;
    minDelayMs: number;
    maxDelayMs: number;
    proxies: string[];
  }) => void;
};

const DEFAULTS: GoogleNewsFormValues = {
  queries: '',
  pagesLimit: 3,
  country: 'US',
  language: 'en',
  dateRange: 'any',
  minDelayMs: 1200,
  maxDelayMs: 2800,
  proxies: '',
};

const DATE_RANGE_OPTIONS: { value: GoogleNewsDateRange; label: string }[] = [
  { value: 'any', label: 'Любое время' },
  { value: 'hour', label: 'Последний час' },
  { value: 'day', label: 'Последний день' },
  { value: 'week', label: 'Последняя неделя' },
  { value: 'month', label: 'Последний месяц' },
  { value: 'year', label: 'Последний год' },
];

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function GoogleNewsParserForm({
  initialValues,
  submitting,
  onSubmit,
}: GoogleNewsParserFormProps) {
  const merged = useMemo<GoogleNewsFormValues>(
    () => ({ ...DEFAULTS, ...(initialValues ?? {}) }),
    [initialValues],
  );

  const [queries, setQueries] = useState(merged.queries);
  const [pagesLimit, setPagesLimit] = useState(merged.pagesLimit);
  const [country, setCountry] = useState(merged.country);
  const [language, setLanguage] = useState(merged.language);
  const [dateRange, setDateRange] = useState<GoogleNewsDateRange>(merged.dateRange);
  const [minDelayMs, setMinDelayMs] = useState(merged.minDelayMs);
  const [maxDelayMs, setMaxDelayMs] = useState(merged.maxDelayMs);
  const [proxies, setProxies] = useState(merged.proxies);

  // Keep max >= min in the UI (server also validates)
  useEffect(() => {
    if (maxDelayMs < minDelayMs) setMaxDelayMs(minDelayMs);
  }, [minDelayMs, maxDelayMs]);

  const queryCount = useMemo(
    () => queries.split('\n').map((s) => s.trim()).filter(Boolean).length,
    [queries],
  );
  const proxyCount = useMemo(
    () => proxies.split('\n').map((s) => s.trim()).filter(Boolean).length,
    [proxies],
  );

  const languageOptions = useMemo(() => ensureLocaleOption(GOOGLE_LANGUAGES, language), [language]);
  const countryOptions = useMemo(() => ensureLocaleOption(GOOGLE_REGIONS, country), [country]);

  const canSubmit = queryCount > 0 && !submitting;

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    const queriesArr = queries
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const proxiesArr = proxies
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    onSubmit({
      queries: queriesArr,
      pagesLimit: clampNumber(pagesLimit, 1, 10),
      country: country.trim() || DEFAULTS.country,
      language: language.trim() || DEFAULTS.language,
      dateRange,
      minDelayMs: clampNumber(minDelayMs, 300, 30000),
      maxDelayMs: clampNumber(maxDelayMs, Math.max(minDelayMs, 300), 60000),
      proxies: proxiesArr,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Queries + Parameters in one row (50/50 on lg) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Queries section */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-5 border-b border-gray-100 bg-gray-50/50">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-emerald-100 text-emerald-700">
                    <Globe className="h-3.5 w-3.5" />
                  </span>
                  Ключевые запросы, по строке
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  Каждая строка — отдельный поисковый запрос к Google News.
                </p>
              </div>
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-700/10 shrink-0">
                {queryCount} запр.
              </span>
            </div>
          </div>
          <div className="p-5 flex-1 flex">
            <textarea
              className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none text-sm font-mono min-h-[280px] p-3"
              placeholder="artificial intelligence layoffs&#10;startup funding round"
              value={queries}
              onChange={(e) => setQueries(e.target.value)}
            />
          </div>
        </div>

        {/* Settings section */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-gray-100 bg-gray-50/50">
            <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-violet-100 text-violet-600">
                <Settings2 className="h-3.5 w-3.5" />
              </span>
              Параметры
            </h3>
          </div>

          <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">
                Лимит страниц выдачи
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={pagesLimit}
                onChange={(e) => setPagesLimit(Number(e.target.value))}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none sm:text-sm px-3 py-2"
              />
              <p className="text-xs text-gray-500">1–10 страниц на запрос</p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Страна</label>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none sm:text-sm px-3 py-2"
              >
                {countryOptions.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label} ({opt.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Язык</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none sm:text-sm px-3 py-2"
              >
                {languageOptions.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label} ({opt.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Период</label>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as GoogleNewsDateRange)}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none sm:text-sm px-3 py-2"
              >
                {DATE_RANGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Мин. задержка, мс</label>
              <input
                type="number"
                min={300}
                max={30000}
                value={minDelayMs}
                onChange={(e) => setMinDelayMs(Number(e.target.value))}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none sm:text-sm px-3 py-2"
              />
              <p className="text-xs text-gray-500">300–30000 мс</p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Макс. задержка, мс</label>
              <input
                type="number"
                min={minDelayMs}
                max={60000}
                value={maxDelayMs}
                onChange={(e) => setMaxDelayMs(Number(e.target.value))}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none sm:text-sm px-3 py-2"
              />
              <p className="text-xs text-gray-500">Не меньше «мин. задержки», до 60000 мс</p>
            </div>
          </div>
        </div>
      </div>

      {/* Proxies section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-emerald-100 text-emerald-600">
                  <Shield className="h-3.5 w-3.5" />
                </span>
                Прокси (по одному на строку)
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                Необязательно. Формат: <code className="font-mono text-xs">http://user:pass@host:port</code>.
              </p>
            </div>
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-700/10 shrink-0">
              {proxyCount} прокси
            </span>
          </div>
        </div>
        <div className="p-5">
          <textarea
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none text-sm font-mono min-h-[80px] p-3"
            placeholder="http://user:pass@host:port"
            value={proxies}
            onChange={(e) => setProxies(e.target.value)}
          />
        </div>
      </div>

      {/* Submit */}
      <div className="flex items-center justify-between pt-2">
        <div className="text-sm text-gray-500">
          {queryCount > 0 ? <span>Итого: {queryCount} запросов</span> : null}
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-base font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {submitting ? 'Запуск...' : 'Запустить парсинг'}
        </button>
      </div>
    </form>
  );
}
