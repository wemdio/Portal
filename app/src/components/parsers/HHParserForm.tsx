'use client';

import { useMemo, useState } from 'react';
import type { HHSearchConfig } from '@/types';
import { Play, Loader2 } from 'lucide-react';

type Props = {
  onStart: (config: HHSearchConfig) => Promise<void>;
  busy: boolean;
};

function parseArea(value: string): string | string[] | undefined {
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return cleaned;
}

export function HHParserForm({ onStart, busy }: Props) {
  const [text, setText] = useState('');
  const [area, setArea] = useState('');
  const [salaryFrom, setSalaryFrom] = useState('');
  const [currency, setCurrency] = useState('RUR');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [perPage, setPerPage] = useState('50');

  const config: HHSearchConfig = useMemo(() => {
    const salary_from = salaryFrom.trim() ? Number(salaryFrom) : undefined;
    const per_page = perPage.trim() ? Number(perPage) : undefined;

    return {
      text,
      area: parseArea(area),
      salary_from: Number.isFinite(salary_from) ? salary_from : undefined,
      currency: currency || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      per_page: Number.isFinite(per_page) ? per_page : undefined,
    };
  }, [area, currency, dateFrom, dateTo, perPage, salaryFrom, text]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">HH.ru парсер</h2>
          <p className="text-sm text-gray-500 mt-1">Запуск поиска вакансий через официальный API HH.ru</p>
        </div>
        <button
          onClick={() => onStart(config)}
          disabled={busy || !text.trim()}
          className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          Запустить
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Текст поиска *</label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="например: sales, маркетолог, b2b"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Регион (area id)</label>
          <input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="например: 1 или 1,2,3"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Зарплата от</label>
          <input
            value={salaryFrom}
            onChange={(e) => setSalaryFrom(e.target.value)}
            inputMode="numeric"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="например: 150000"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Валюта</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
          >
            <option value="RUR">RUR</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Дата от (YYYY-MM-DD)</label>
          <input
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="2026-01-01"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Дата до (YYYY-MM-DD)</label>
          <input
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="2026-01-28"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Per page</label>
          <input
            value={perPage}
            onChange={(e) => setPerPage(e.target.value)}
            inputMode="numeric"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="50"
          />
        </div>
      </div>
    </div>
  );
}

