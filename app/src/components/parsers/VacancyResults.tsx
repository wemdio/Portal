'use client';

import { useEffect, useRef, useState } from 'react';
import type { HHSearchConfig, HHVacancyRow, ParserJobStatus } from '@/types';
import { Download, ExternalLink, Copy, Check } from 'lucide-react';

type Props = {
  items: HHVacancyRow[];
  count: number;
  limit: number;
  offset: number;
  loading: boolean;
  actionsBusy: boolean;
  jobId?: string | null;
  jobStatus?: ParserJobStatus | null;
  jobActionBusy?: boolean;
  searchConfig?: HHSearchConfig | null;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onExportCsv: () => void;
  onExportExcel: () => void;
  onCopy: () => void;
  onStopJob?: () => void;
  onDeleteJob?: () => void;
};

const SEARCH_BASE_URL = 'https://hh.ru/search/vacancy';
const KNOWN_PARAM_KEYS = new Set([
  'text',
  'area',
  'salary',
  'salary_from',
  'currency',
  'date_from',
  'date_to',
  'per_page',
  'items_on_page',
  'page',
]);

function appendParam(params: URLSearchParams, key: string, value: string | string[]) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const trimmed = String(item).trim();
      if (trimmed) params.append(key, trimmed);
    }
    return;
  }
  const trimmed = String(value).trim();
  if (trimmed) params.append(key, trimmed);
}

function appendParams(params: URLSearchParams, extras?: Record<string, string | string[]>) {
  if (!extras) return;
  for (const [key, value] of Object.entries(extras)) {
    if (!key) continue;
    appendParam(params, key, value);
  }
}

function buildSearchUrl(config?: HHSearchConfig | null) {
  if (!config) return null;
  const params = new URLSearchParams();
  appendParams(params, config.params);
  for (const key of KNOWN_PARAM_KEYS) params.delete(key);

  if (config.text) params.set('text', config.text);
  if (config.salary_from !== undefined) params.set('salary', String(config.salary_from));
  if (config.currency) params.set('currency', config.currency);
  if (config.date_from) params.set('date_from', config.date_from);
  if (config.date_to) params.set('date_to', config.date_to);
  if (config.area) {
    if (Array.isArray(config.area)) {
      for (const area of config.area) {
        const trimmed = String(area).trim();
        if (trimmed) params.append('area', trimmed);
      }
    } else {
      const trimmed = String(config.area).trim();
      if (trimmed) params.set('area', trimmed);
    }
  }
  if (config.per_page !== undefined) {
    const key = config.params && Object.prototype.hasOwnProperty.call(config.params, 'items_on_page')
      ? 'items_on_page'
      : 'per_page';
    params.set(key, String(config.per_page));
  }

  const query = params.toString();
  if (!query) return null;
  return `${SEARCH_BASE_URL}?${query}`;
}

function formatArea(area?: string | string[]) {
  if (!area) return null;
  if (Array.isArray(area)) return area.join(', ');
  return area;
}

function buildFilters(config?: HHSearchConfig | null) {
  if (!config) return [];
  const filters: Array<{ label: string; value: string; tone?: 'yellow' }> = [];
  const text = config.text?.trim();
  if (text) filters.push({ label: 'Запрос', value: text });
  const area = formatArea(config.area);
  if (area) filters.push({ label: 'Регион', value: area });
  if (config.salary_from !== undefined) {
    const currency = config.currency ? ` ${config.currency}` : '';
    filters.push({ label: 'Зарплата от', value: `${config.salary_from}${currency}`.trim() });
  } else if (config.currency && config.params && Object.prototype.hasOwnProperty.call(config.params, 'currency')) {
    filters.push({ label: 'Валюта', value: config.currency });
  }
  if (config.date_from) filters.push({ label: 'Дата от', value: config.date_from });
  if (config.date_to) filters.push({ label: 'Дата до', value: config.date_to });
  if (config.per_page !== undefined) filters.push({ label: 'Per page', value: String(config.per_page) });
  if (config.fetch_employers) filters.push({ label: 'Работодатели', value: 'с деталями', tone: 'yellow' });
  return filters;
}

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
  jobId,
  jobStatus,
  jobActionBusy,
  searchConfig,
  currentPage,
  totalPages,
  onPageChange,
  onExportCsv,
  onExportExcel,
  onCopy,
  onStopJob,
  onDeleteJob,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);
  const hasItems = items.length > 0;
  const [emptyMessageIndex, setEmptyMessageIndex] = useState(0);
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  const emptyMessages = [
    'Ищем вакансии на HH.ru — первые результаты скоро появятся.',
    'Собираем результаты по заданным фильтрам.',
    'Парсинг в процессе, это может занять несколько минут.',
    'Обновляем список вакансий, ожидайте.',
    'Почти готово, осталось немного.',
    'Финализируем выдачу и готовим результаты.',
    'Синхронизируем данные с HH.ru.',
    'Обрабатываем найденные вакансии.',
    'Готовим результаты для отображения.',
    'Еще чуть-чуть — скоро все появится.',
  ];

  useEffect(() => {
    if (jobStatus !== 'running' || hasItems) return undefined;
    setEmptyMessageIndex(0);
    const intervalId = window.setInterval(() => {
      setEmptyMessageIndex((prev) => (prev + 1) % emptyMessages.length);
    }, 25000);
    return () => window.clearInterval(intervalId);
  }, [jobStatus, hasItems, emptyMessages.length]);

  const shownFrom = hasItems ? offset + 1 : 0;
  const shownTo = hasItems ? Math.min(count, offset + items.length) : 0;
  const shownLabel = count ? (hasItems ? `${shownFrom}–${shownTo} из ${count}` : `0 из ${count}`) : '—';
  const limitLabel = limit ? ` · по ${limit}` : '';
  const actionsDisabled = actionsBusy || (count === 0 && items.length === 0);
  const jobControlsDisabled = jobActionBusy || !jobId;
  const searchUrl = buildSearchUrl(searchConfig);
  const filters = buildFilters(searchConfig);
  const canPrev = currentPage > 1;
  const canNext = currentPage < totalPages;
  const maxButtons = 5;
  const pageButtons: Array<number | 'ellipsis'> = [];
  const start = Math.max(1, Math.min(currentPage - 2, totalPages - maxButtons + 1));
  const end = Math.min(totalPages, start + maxButtons - 1);

  if (start > 1) {
    pageButtons.push(1);
    if (start > 2) pageButtons.push('ellipsis');
  }
  for (let i = start; i <= end; i += 1) pageButtons.push(i);
  if (end < totalPages) {
    if (end < totalPages - 1) pageButtons.push('ellipsis');
    pageButtons.push(totalPages);
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Результаты</h3>
          <p className="text-sm text-gray-500">
            {shownLabel}{limitLabel}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {jobId ? (
            <>
              {jobStatus === 'running' ? (
                <button
                  onClick={() => onStopJob?.()}
                  disabled={jobControlsDisabled}
                  className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                >
                  Остановить
                </button>
              ) : null}
              <button
                onClick={() => onDeleteJob?.()}
                disabled={jobControlsDisabled}
                className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                Удалить
              </button>
            </>
          ) : null}
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

      {searchConfig ? (
        <div className="px-6 py-3 border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
          {searchUrl ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-gray-500 whitespace-nowrap">Ссылка поиска:</span>
              <a
                href={searchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline truncate min-w-0"
                title={searchUrl}
              >
                {searchUrl.length > 100 ? `${searchUrl.slice(0, 100)}…` : searchUrl}
              </a>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard?.writeText(searchUrl);
                    setCopied(true);
                    if (copiedTimeoutRef.current !== null) {
                      window.clearTimeout(copiedTimeoutRef.current);
                    }
                    copiedTimeoutRef.current = window.setTimeout(() => {
                      setCopied(false);
                      copiedTimeoutRef.current = null;
                    }, 5000);
                  } catch {
                    // ignore
                  }
                }}
                className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-300 ${
                  copied
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-100'
                }`}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 mr-1 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1" />
                )}
                {copied ? 'Скопировано' : 'Скопировать'}
              </button>
            </div>
          ) : null}
          <div className={`mt-2 flex flex-wrap gap-2 ${filters.length ? '' : 'text-gray-500'}`}>
            {filters.length ? (
              filters.map((item) => (
                <span
                  key={item.label}
                  className={`rounded-full border px-2 py-0.5 ${
                    item.tone === 'yellow'
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-gray-200 bg-white text-gray-700'
                  }`}
                >
                  {item.label}: {item.value}
                </span>
              ))
            ) : (
              <span>Фильтры не указаны</span>
            )}
          </div>
        </div>
      ) : null}

      {items.length === 0 ? (
        jobStatus === 'running' ? (
          <div className="px-6 py-12 text-center text-gray-500">
            <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
            <div className="text-sm">{emptyMessages[emptyMessageIndex]}</div>
          </div>
        ) : (
          <div className="px-6 py-10 text-center text-gray-500">Нет результатов</div>
        )
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

      <div className="px-6 py-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-4">
        <div className="text-sm text-gray-500">
          Страница {Math.min(currentPage, totalPages)} из {totalPages}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={!canPrev || loading}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Назад
          </button>
          {pageButtons.map((page, index) => (
            page === 'ellipsis' ? (
              <span key={`ellipsis-${index}`} className="px-1 text-gray-400">…</span>
            ) : (
              <button
                key={page}
                onClick={() => onPageChange(page)}
                disabled={loading}
                className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium ${
                  page === currentPage
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {page}
              </button>
            )
          ))}
          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={!canNext || loading}
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Вперёд
          </button>
        </div>
      </div>
    </div>
  );
}

