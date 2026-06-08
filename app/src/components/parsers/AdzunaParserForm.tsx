'use client';

import { useMemo, useState } from 'react';
import { Play, Loader2, Globe, Info } from 'lucide-react';
import type { AdzunaSearchConfig } from '@/types';
import { ADZUNA_COUNTRIES, ADZUNA_RECENCY_OPTIONS } from '@/lib/parsers/adzunaConfig';

type Props = {
  onStart: (config: AdzunaSearchConfig) => Promise<void>;
  busy: boolean;
};

export function AdzunaParserForm({ onStart, busy }: Props) {
  const [roles, setRoles] = useState('');
  const [countries, setCountries] = useState<string[]>(['us']);
  const [days, setDays] = useState<number>(30);
  const [pages, setPages] = useState('5');
  const [enrich, setEnrich] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  const toggleCountry = (code: string) =>
    setCountries((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const config: AdzunaSearchConfig = useMemo(() => {
    const pagesNum = Number(pages);
    return {
      text: roles.trim(),
      countries: countries.length ? countries : ['us'],
      posted_within_days: days,
      pages: Number.isFinite(pagesNum) ? Math.max(1, Math.trunc(pagesNum)) : 5,
      enrich,
    };
  }, [roles, countries, days, pages, enrich]);

  const canStart = Boolean(roles.trim()) && countries.length > 0;
  const submit = () => {
    if (!busy && canStart) void onStart(config);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" style={{ borderTop: '3px solid #7c3aed' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-violet-100 text-violet-600">
              <Globe className="h-4 w-4" />
            </span>
            EU/US · Весь рынок (Adzuna)
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Агрегатор всего рынка вакансий (как HH, но для EU/US). Тысячи компаний по роли — с доменами.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={submit}
            disabled={busy || !canStart}
            className="inline-flex items-center rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
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

      <div className="mt-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Роли / ключевые слова <span className="text-red-500">*</span>
          <span className="text-gray-400 font-normal"> — через запятую, ищем по вакансиям</span>
        </label>
        <input
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="напр.: marketing manager, head of marketing, demand generation"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-400 focus:border-violet-400"
        />
      </div>

      <div className="mt-5">
        <label className="block text-sm font-medium text-gray-700 mb-2">Страны</label>
        <div className="flex flex-wrap gap-2">
          {ADZUNA_COUNTRIES.map((c) => {
            const on = countries.includes(c.code);
            return (
              <button
                key={c.code}
                type="button"
                onClick={() => toggleCountry(c.code)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium border transition-colors ${
                  on
                    ? 'bg-violet-600 text-white border-violet-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-violet-400 hover:text-violet-700'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">
          Adzuna ищет по каждой выбранной стране отдельно (каждая страна × роль × страницы = запросы к API).
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Свежесть вакансий</label>
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 flex-wrap">
            {ADZUNA_RECENCY_OPTIONS.map((o) => {
              const on = days === o.days;
              return (
                <button
                  key={o.days}
                  type="button"
                  onClick={() => setDays(o.days)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${
                    on ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
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
            Страниц на роль <span className="text-gray-400 font-normal">(×50 вакансий, до 20)</span>
          </label>
          <input
            value={pages}
            onChange={(e) => setPages(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="5"
            className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-400 focus:border-violet-400"
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={enrich}
            onChange={(e) => setEnrich(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-400"
          />
          Определять домен компании
        </label>
      </div>

      <p className="mt-4 text-xs text-gray-400">
        Кадровые агентства (Robert Half, Randstad и т.п.) отфильтровываются автоматически. Домены подтягиваются для топ-компаний.
      </p>

      {showHelp ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Как работает Adzuna-парсер</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <p>
                Это аналог HH для EU/US: Adzuna агрегирует <span className="font-semibold">весь рынок</span> вакансий
                (миллионы объявлений), а не только tech-компании. По роли вернёт тысячи компаний.
              </p>
              <p>
                Задайте роли, страны и свежесть. Чем больше «страниц на роль» — тем больше охват (и дольше). Каждая
                компания обогащается доменом, чтобы результат сразу шёл в рассылку.
              </p>
              <p className="text-xs text-gray-500">
                Отличие от вкладки «Tech-компании»: там точечно ~10к карьерных страниц с чистыми доменами; здесь —
                массовый охват всего рынка.
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
