'use client';

import { useMemo, useState } from 'react';
import { BriefcaseBusiness, Loader2, Play } from 'lucide-react';
import type { EngHiringSearchConfig, EngHiringSource } from '@/types';
import { ATS_COUNTRIES, ATS_RECENCY_OPTIONS } from '@/lib/parsers/atsFilters';

type Props = {
  onStart: (config: EngHiringSearchConfig) => Promise<void>;
  busy: boolean;
};

const SOURCE_OPTIONS: { key: EngHiringSource; label: string }[] = [
  { key: 'greenhouse', label: 'Greenhouse' },
  { key: 'lever', label: 'Lever' },
  { key: 'ashby', label: 'Ashby' },
  { key: 'workable', label: 'Workable' },
  { key: 'bamboohr', label: 'BambooHR' },
  { key: 'recruitee', label: 'Recruitee' },
  { key: 'breezy', label: 'Breezy' },
  { key: 'workday', label: 'Workday' },
];

export function EngHiringParserForm({ onStart, busy }: Props) {
  const [roles, setRoles] = useState('');
  const [sources, setSources] = useState<EngHiringSource[]>(SOURCE_OPTIONS.map((option) => option.key));
  const [countries, setCountries] = useState<string[]>([]);
  const [days, setDays] = useState<number>(30);
  const [companiesLimit, setCompaniesLimit] = useState('1000');
  const [maxResults, setMaxResults] = useState('5000');
  const [cacheAge, setCacheAge] = useState('12');
  const [refreshCache, setRefreshCache] = useState(true);
  const [enrich, setEnrich] = useState(true);
  const [maximumCoverage, setMaximumCoverage] = useState(false);

  const toggleSource = (source: EngHiringSource) =>
    setSources((prev) => (prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source]));

  const toggleCountry = (code: string) =>
    setCountries((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const toggleMaximumCoverage = (checked: boolean) => {
    setMaximumCoverage(checked);
    if (checked) {
      setCompaniesLimit('0');
      setMaxResults('20000');
      setCacheAge('1');
      setRefreshCache(true);
    } else {
      setCompaniesLimit((prev) => (prev === '0' ? '1000' : prev));
    }
  };

  const config: EngHiringSearchConfig = useMemo(() => {
    const companies = Number(companiesLimit);
    const results = Number(maxResults);
    const age = Number(cacheAge);
    return {
      text: roles.trim(),
      sources,
      countries: countries.length ? countries : undefined,
      posted_within_days: days,
      companies_limit: maximumCoverage ? 0 : Number.isFinite(companies) ? Math.max(0, Math.trunc(companies)) : 1000,
      max_results: Number.isFinite(results) ? Math.max(1, Math.trunc(results)) : 5000,
      cache_max_age_hours: Number.isFinite(age) ? Math.max(1, Math.trunc(age)) : 12,
      refresh_cache: refreshCache,
      enrich,
      include_unknown_dates: maximumCoverage,
    };
  }, [roles, sources, countries, days, companiesLimit, maxResults, cacheAge, refreshCache, enrich, maximumCoverage]);

  const canStart = Boolean(roles.trim()) && sources.length > 0;
  const submit = () => {
    if (!busy && canStart) void onStart(config);
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm" style={{ borderTop: '3px solid #2563eb' }}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
              <BriefcaseBusiness className="h-4 w-4" />
            </span>
            ENG вакансии через ATS
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            First-party вакансии Greenhouse, Lever, Ashby, Workable, BambooHR и Recruitee с cache-first сбором: компания, сайт, описание, вакансия, зарплата и локация.
          </p>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !canStart}
          className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Запустить
        </button>
      </div>

      <div className="mt-6">
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Роли / ключевые слова <span className="text-red-500">*</span>
          <span className="font-normal text-gray-400"> - через запятую, ищем по названию вакансии</span>
        </label>
        <input
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="например: head of marketing, demand generation, account executive"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
      </div>

      <div className="mt-5">
        <label className="mb-2 block text-sm font-medium text-gray-700">
          Страны <span className="font-normal text-gray-400">(пусто = любые)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {ATS_COUNTRIES.map((country) => {
            const selected = countries.includes(country.code);
            return (
              <button
                key={country.code}
                type="button"
                onClick={() => toggleCountry(country.code)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                  selected
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300 bg-white text-gray-600 hover:border-blue-400 hover:text-blue-700'
                }`}
              >
                {country.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">Свежесть вакансий</label>
          <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-gray-50 p-1">
            {ATS_RECENCY_OPTIONS.map((option) => {
              const selected = days === option.days;
              return (
                <button
                  key={option.days}
                  type="button"
                  onClick={() => setDays(option.days)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    selected ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">Источники</label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {SOURCE_OPTIONS.map((option) => (
              <label key={option.key} className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={sources.includes(option.key)}
                  onChange={() => toggleSource(option.key)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg bg-blue-50 px-3 py-3 text-sm text-blue-950">
        <input
          type="checkbox"
          checked={maximumCoverage}
          onChange={(e) => toggleMaximumCoverage(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-400"
        />
        <span>
          <span className="block font-medium">Максимальное покрытие</span>
          <span className="block text-blue-800">
            Все известные boards по выбранным источникам, до 20 000 результатов, свежий кэш 1 час.
          </span>
        </span>
      </label>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Компаний на источник</span>
          {maximumCoverage ? (
            <div className="w-full rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800">
              Все известные
            </div>
          ) : (
            <input
              value={companiesLimit}
              onChange={(e) => setCompaniesLimit(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              placeholder="1000"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Макс. результатов</span>
          <input
            value={maxResults}
            onChange={(e) => setMaxResults(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="5000"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Свежий кэш, часов</span>
          <input
            value={cacheAge}
            onChange={(e) => setCacheAge(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="12"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={refreshCache}
            onChange={(e) => setRefreshCache(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
          />
          Обновлять кэш перед поиском
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={enrich}
            onChange={(e) => setEnrich(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
          />
          Определять сайты компаний
        </label>
      </div>
    </div>
  );
}
