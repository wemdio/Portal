'use client';

import type { HHVacancyRow } from '@/types';
import { Download, ExternalLink, Loader2, Copy } from 'lucide-react';

type Props = {
  items: HHVacancyRow[];
  count: number;
  limit: number;
  offset: number;
  loading: boolean;
  actionsBusy: boolean;
  onLoadMore: () => void;
  onExportCsv: () => void;
  onExportExcel: () => void;
  onCopy: () => void;
};

function formatSalary(v: HHVacancyRow) {
  const from = v.salary_from ?? null;
  const to = v.salary_to ?? null;
  const cur = v.salary_currency ?? '';

  if (from == null && to == null) return '—';
  if (from != null && to != null) return `${from}–${to} ${cur}`.trim();
  if (from != null) return `от ${from} ${cur}`.trim();
  return `до ${to} ${cur}`.trim();
}

function formatDate(dateStr?: string | null) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('ru-RU');
  } catch {
    return dateStr;
  }
}

export function VacancyResults({
  items,
  count,
  limit,
  offset,
  loading,
  actionsBusy,
  onLoadMore,
  onExportCsv,
  onExportExcel,
  onCopy,
}: Props) {
  const hasItems = items.length > 0;
  const shownFrom = hasItems ? offset + 1 : 0;
  const shownTo = hasItems ? Math.min(count, offset + items.length) : 0;
  const shownLabel = count ? (hasItems ? `${shownFrom}–${shownTo} из ${count}` : `0 из ${count}`) : '—';
  const limitLabel = limit ? ` · по ${limit}` : '';
  const actionsDisabled = actionsBusy || (count === 0 && items.length === 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Результаты</h3>
          <p className="text-sm text-gray-500">
            {shownLabel}{limitLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onExportCsv}
            disabled={actionsDisabled}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            <Download className="h-4 w-4 mr-2" />
            CSV
          </button>
          <button
            onClick={onExportExcel}
            disabled={actionsDisabled}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            <Download className="h-4 w-4 mr-2" />
            Excel
          </button>
          <button
            onClick={onCopy}
            disabled={actionsDisabled}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            <Copy className="h-4 w-4 mr-2" />
            Копировать
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-6 py-10 text-center text-gray-500">Нет результатов</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-50">Вакансия</th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-50">Компания</th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-50">Регион</th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-50">ЗП</th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-50">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((v) => (
                <tr key={v.vacancy_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-blue-600 hover:underline inline-flex items-start gap-1"
                      title={v.name}
                    >
                      <span className="line-clamp-2">{v.name}</span>
                      <ExternalLink className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    </a>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {v.company_site_url || v.company_url ? (
                      <div className="inline-flex items-center gap-2">
                        <span title={v.company_name}>{v.company_name}</span>
                        <a
                          href={v.company_site_url ?? v.company_url ?? '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                          title="Открыть сайт компании"
                        >
                          сайт
                        </a>
                      </div>
                    ) : (
                      <span title={v.company_name}>{v.company_name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700" title={v.area}>
                    {v.area}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">{formatSalary(v)}</td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">{formatDate(v.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-center">
        <button
          onClick={onLoadMore}
          disabled={loading || offset + items.length >= count}
          className="inline-flex items-center rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Загрузить ещё
        </button>
      </div>
    </div>
  );
}

