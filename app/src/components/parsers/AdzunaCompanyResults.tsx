'use client';

import type { AdzunaCompanyRow, ParserJobStatus } from '@/types';
import { Download, Copy, Database, Square, Trash2, Loader2 } from 'lucide-react';

type Props = {
  items: AdzunaCompanyRow[];
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

const ROLE_LABELS: Record<string, string> = { marketing: 'маркетинг', b2b_sales: 'продажи' };

function formatDate(value?: string | null) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return value;
  }
}

export function AdzunaCompanyResults({
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
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-gray-900">Компании ({count})</h3>
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : null}
          {exportProgress ? <span className="text-xs text-gray-500">{exportProgress}</span> : null}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onExportCsv}
            disabled={actionsBusy || !hasItems}
            className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="h-4 w-4 mr-1.5" /> CSV
          </button>
          <button
            onClick={onCopy}
            disabled={actionsBusy || !hasItems}
            className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Copy className="h-4 w-4 mr-1.5" /> Копировать
          </button>
          {onAddToDatabase ? (
            <button
              onClick={onAddToDatabase}
              disabled={actionsBusy || !hasItems}
              className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Database className="h-4 w-4 mr-1.5" /> В Базы
            </button>
          ) : null}
          {running && onStopJob ? (
            <button
              onClick={onStopJob}
              className="inline-flex items-center rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
            >
              <Square className="h-4 w-4 mr-1.5" /> Стоп
            </button>
          ) : null}
          {onDeleteJob ? (
            <button
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
          {running ? 'Идёт сбор — результаты появятся здесь…' : loading ? 'Загрузка…' : 'Нет результатов'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Компания</th>
                <th className="px-4 py-3">Домен</th>
                <th className="px-4 py-3">Страна</th>
                <th className="px-4 py-3">Роли</th>
                <th className="px-4 py-3 text-right">Вакансий</th>
                <th className="px-4 py-3">Города</th>
                <th className="px-4 py-3">Обновлено</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{c.company}</td>
                  <td className="px-4 py-3">
                    {c.domain ? (
                      <a
                        href={`https://${c.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-600 hover:underline"
                      >
                        {c.domain}
                      </a>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 uppercase">{c.country || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(c.roles_found ?? []).map((r) => (
                        <span key={r} className="rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-700">
                          {ROLE_LABELS[r] ?? r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{c.job_count}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[220px] truncate" title={(c.cities ?? []).join(', ')}>
                    {(c.cities ?? []).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(c.latest_posted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between text-sm">
          <button
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
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Вперёд
          </button>
        </div>
      ) : null}
    </div>
  );
}
