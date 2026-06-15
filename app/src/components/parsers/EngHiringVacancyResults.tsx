'use client';

import type { EngHiringVacancyRow, ParserJobStatus } from '@/types';
import { Copy, Database, Download, ExternalLink, Loader2, Square, Trash2 } from 'lucide-react';

type Props = {
  items: EngHiringVacancyRow[];
  count: number;
  loading: boolean;
  jobStatus: ParserJobStatus | null;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  actionsBusy: boolean;
  exportProgress: string | null;
  onExportCsv: () => void;
  onCopy: () => void;
  onAddToDatabase?: () => void;
  onStopJob?: () => void;
  onDeleteJob?: () => void;
};

function formatDate(value?: string | null) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return value;
  }
}

function formatSalary(row: EngHiringVacancyRow) {
  if (row.salary_from == null && row.salary_to == null) return '—';
  const currency = row.salary_currency ? ` ${row.salary_currency}` : '';
  if (row.salary_from != null && row.salary_to != null) return `${row.salary_from} - ${row.salary_to}${currency}`;
  if (row.salary_from != null) return `от ${row.salary_from}${currency}`;
  return `до ${row.salary_to}${currency}`;
}

function formatLocation(row: EngHiringVacancyRow) {
  const parts = [row.city, row.country_code?.toUpperCase() ?? row.country, row.location]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(', ') || '—';
}

export function EngHiringVacancyResults({
  items,
  count,
  loading,
  jobStatus,
  currentPage,
  totalPages,
  onPageChange,
  actionsBusy,
  exportProgress,
  onExportCsv,
  onCopy,
  onAddToDatabase,
  onStopJob,
  onDeleteJob,
}: Props) {
  const running = jobStatus === 'running' || jobStatus === 'pending';
  const hasItems = items.length > 0;

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-gray-900">Вакансии ({count})</h3>
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : null}
          {exportProgress ? <span className="text-xs text-gray-500">{exportProgress}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onExportCsv}
            disabled={actionsBusy || !hasItems}
            className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="mr-1.5 h-4 w-4" /> CSV
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={actionsBusy || !hasItems}
            className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Copy className="mr-1.5 h-4 w-4" /> Копировать
          </button>
          {onAddToDatabase ? (
            <button
              type="button"
              onClick={onAddToDatabase}
              disabled={actionsBusy || !hasItems}
              className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Database className="mr-1.5 h-4 w-4" /> В Базы
            </button>
          ) : null}
          {running && onStopJob ? (
            <button
              type="button"
              onClick={onStopJob}
              className="inline-flex items-center rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
            >
              <Square className="mr-1.5 h-4 w-4" /> Стоп
            </button>
          ) : null}
          {onDeleteJob ? (
            <button
              type="button"
              onClick={onDeleteJob}
              className="inline-flex items-center rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              aria-label="Удалить запуск"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {!hasItems ? (
        <div className="px-6 py-12 text-center text-gray-500">
          {running ? 'Идет сбор. Первые результаты появятся после фильтрации кэша.' : loading ? 'Загрузка...' : 'Нет результатов'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Компания</th>
                <th className="px-4 py-3">Вакансия</th>
                <th className="px-4 py-3">Сайт</th>
                <th className="px-4 py-3">Salary</th>
                <th className="px-4 py-3">Локация</th>
                <th className="px-4 py-3">Источник</th>
                <th className="px-4 py-3">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <div className="max-w-[220px] truncate" title={row.company_name}>
                      {row.company_name}
                    </div>
                    {row.company_description ? (
                      <div className="mt-1 max-w-[260px] truncate text-xs font-normal text-gray-400" title={row.company_description}>
                        {row.company_description}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[360px]">
                      <a
                        href={row.vacancy_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 text-blue-700 hover:underline"
                        title={row.vacancy_title}
                      >
                        <span className="truncate">{row.vacancy_title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 text-gray-400" />
                      </a>
                      {row.vacancy_description ? (
                        <div className="mt-1 line-clamp-2 text-xs text-gray-400" title={row.vacancy_description}>
                          {row.vacancy_description}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.company_site_url ? (
                      <a
                        href={row.company_site_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {row.company_site_url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                      </a>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-600">{formatSalary(row)}</td>
                  <td className="px-4 py-3 text-gray-500">
                    <div className="max-w-[240px] truncate" title={formatLocation(row)}>
                      {formatLocation(row)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{row.source}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">{formatDate(row.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-gray-200 px-6 py-3 text-sm">
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Назад
          </button>
          <span className="text-gray-500">
            Стр. {currentPage} из {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Вперед
          </button>
        </div>
      ) : null}
    </div>
  );
}
