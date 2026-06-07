'use client';

import { useMemo, useState } from 'react';
import { Play, Loader2, Building2, Info } from 'lucide-react';
import type { AtsSearchConfig, AtsType } from '@/types';
import { ATS_COUNTRIES, ATS_RECENCY_OPTIONS } from '@/lib/parsers/atsFilters';

type Props = {
  onStart: (config: AtsSearchConfig) => Promise<void>;
  busy: boolean;
};

const ATS_OPTIONS: { key: AtsType; label: string }[] = [
  { key: 'greenhouse', label: 'Greenhouse' },
  { key: 'lever', label: 'Lever' },
  { key: 'ashby', label: 'Ashby' },
];

export function AtsParserForm({ onStart, busy }: Props) {
  const [roles, setRoles] = useState('');
  const [ats, setAts] = useState<AtsType[]>(['greenhouse', 'lever', 'ashby']);
  const [countries, setCountries] = useState<string[]>([]);
  const [days, setDays] = useState<number>(30);
  const [limit, setLimit] = useState('150');
  const [enrich, setEnrich] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  const toggleAts = (key: AtsType) =>
    setAts((prev) => (prev.includes(key) ? prev.filter((a) => a !== key) : [...prev, key]));
  const toggleCountry = (code: string) =>
    setCountries((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const config: AtsSearchConfig = useMemo(() => {
    const limitNum = Number(limit);
    return {
      text: roles.trim(),
      ats,
      countries: countries.length ? countries : undefined,
      posted_within_days: days,
      companies_limit: Number.isFinite(limitNum) ? Math.max(0, Math.trunc(limitNum)) : 150,
      enrich,
    };
  }, [roles, ats, countries, days, limit, enrich]);

  const canStart = Boolean(roles.trim()) && ats.length > 0;
  const submit = () => {
    if (!busy && canStart) void onStart(config);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" style={{ borderTop: '3px solid #0ea5e9' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-sky-100 text-sky-600">
              <Building2 className="h-4 w-4" />
            </span>
            ATS парсер (EU/US)
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Компании, которые нанимают на англоязычных рынках, через карьерные страницы Greenhouse / Lever / Ashby.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={submit}
            disabled={busy || !canStart}
            className="inline-flex items-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            Запустить
          </button>
          <button
            type="button"
            onClick={() => setShowHelp(true)}
            className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 border border-amber-200 hover:bg-amber-100"
          >
            <Info className="h-3.5 w-3.5 mr-1" />
            Как работает
          </button>
        </div>
      </div>

      {/* Roles — the primary signal */}
      <div className="mt-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Роли / ключевые слова <span className="text-red-500">*</span>
          <span className="text-gray-400 font-normal"> — через запятую, ищем по названию вакансии</span>
        </label>
        <input
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="напр.: head of marketing, demand generation, account executive"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 focus:border-sky-400"
        />
      </div>

      {/* Countries */}
      <div className="mt-5">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Страны <span className="text-gray-400 font-normal">(ничего не выбрано = любая)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {ATS_COUNTRIES.map((c) => {
            const on = countries.includes(c.code);
            return (
              <button
                key={c.code}
                type="button"
                onClick={() => toggleCountry(c.code)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium border transition-colors ${
                  on
                    ? 'bg-sky-600 text-white border-sky-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-sky-400 hover:text-sky-700'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">
          Фильтр по локации вакансии. Best-effort: Ashby отдаёт страну точно, Greenhouse обычно в тексте, Lever часто без страны.
        </p>
      </div>

      {/* Recency + depth + enrich */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Свежесть вакансий</label>
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 flex-wrap">
            {ATS_RECENCY_OPTIONS.map((o) => {
              const on = days === o.days;
              return (
                <button
                  key={o.days}
                  type="button"
                  onClick={() => setDays(o.days)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${
                    on ? 'bg-sky-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Компаний на источник <span className="text-gray-400 font-normal">(0 = все)</span>
          </label>
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="150"
            className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 focus:border-sky-400"
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700">Источники:</span>
          {ATS_OPTIONS.map((o) => (
            <label key={o.key} className="inline-flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={ats.includes(o.key)}
                onChange={() => toggleAts(o.key)}
                className="h-4 w-4 rounded border-gray-300 text-sky-600 focus:ring-sky-400"
              />
              {o.label}
            </label>
          ))}
        </div>

        <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={enrich}
            onChange={(e) => setEnrich(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-sky-600 focus:ring-sky-400"
          />
          Определять домен компании
        </label>
      </div>

      <p className="mt-4 text-xs text-gray-400">
        На выходе: компании с доменами, ролями-сигналами и ссылками на вакансии. Большой лимит = дольше (тысячи запросов).
      </p>

      {showHelp ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Как работает ATS парсер</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <p>
                Англоязычный аналог HH-парсера: открытая вакансия = сигнал к покупке, нанимающая компания = лид.
                Источник — карьерные страницы самих компаний на Greenhouse, Lever и Ashby.
              </p>
              <p>
                Настраивается тремя реальными фильтрами: <span className="font-semibold">роли</span> (по названию
                вакансии), <span className="font-semibold">страна</span> (по локации) и{' '}
                <span className="font-semibold">свежесть</span> (по дате публикации). «Ниш/отраслей» у этих
                источников нет — поэтому только то, что в данных действительно есть.
              </p>
              <p className="text-xs text-gray-500">
                Списки компаний берутся из открытого датасета. «Определять домен» подтягивает сайт компании, чтобы
                результат можно было добавить в Базы и в рассылку.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Понятно
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
