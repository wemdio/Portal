'use client';

import { useEffect, useRef, useState } from 'react';
import type { HHSearchConfig, HHVacancyRow, ParserJobStatus } from '@/types';
import { Download, ExternalLink, Copy, Check, ChevronLeft, ChevronRight, Database, Table2 } from 'lucide-react';
import { findRegionById } from '@/lib/parsers/hhArchive/regions';

type BusyAction = 'csv' | 'excel' | 'copy' | 'database' | null;

// Client view shows a short preview; the full base is available via the export.
const CLIENT_PREVIEW_LIMIT = 20;

type Props = {
  items: HHVacancyRow[];
  count: number;
  limit: number;
  offset: number;
  loading: boolean;
  actionsBusy: boolean;
  busyAction?: BusyAction;
  exportProgress?: string | null;
  addToDatabaseDisabled?: boolean;
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
  onAddToDatabase?: () => void;
  onStopJob?: () => void;
  onDeleteJob?: () => void;
  /** Client portal: hide operator plumbing — search URL, per-page, raw area ids, jargon chips. */
  clientMode?: boolean;
};

const RUNNING_EMPTY_MESSAGES = [
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
] as const;

function RunningEmptyState({ clientMode }: { clientMode?: boolean }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    // Clients get one honest line — no rotating carousel of contentless reassurances.
    if (clientMode) return;
    const intervalId = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % RUNNING_EMPTY_MESSAGES.length);
    }, 25000);
    return () => window.clearInterval(intervalId);
  }, [clientMode]);
  return (
    <div className="px-6 py-12 text-center text-gray-500">
      <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
      <div className="text-sm">
        {clientMode
          ? 'Идёт поиск вакансий на HH.ru. Это может занять несколько минут.'
          : RUNNING_EMPTY_MESSAGES[index]}
      </div>
    </div>
  );
}

function LoadingEmptyState() {
  return (
    <div className="px-6 py-12 text-center text-gray-500">
      <div className="mx-auto h-8 w-8 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
    </div>
  );
}

function getSearchBaseUrl(subdomain?: string) {
  if (subdomain) return `https://${subdomain}.hh.ru/search/vacancy`;
  return 'https://hh.ru/search/vacancy';
}
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
  return `${getSearchBaseUrl(config.subdomain)}?${query}`;
}

function formatArea(area?: string | string[]) {
  if (!area) return null;
  if (Array.isArray(area)) return area.join(', ');
  return area;
}

// Client view shows region NAMES, not raw HH area ids («Регион: 1» → «Москва»).
function regionNames(area?: string | string[]): string | null {
  if (!area) return null;
  const ids = Array.isArray(area) ? area : [area];
  const names = ids
    .map((id) => String(id).trim())
    .filter(Boolean)
    .map((id) => findRegionById(id)?.name ?? id);
  return names.length ? names.join(', ') : null;
}

function buildFilters(config?: HHSearchConfig | null, clientMode?: boolean) {
  if (!config) return [];
  const filters: Array<{ label: string; value: string; tone?: 'yellow' }> = [];
  const text = config.text?.trim();
  // Client: split the operator OR-pipe syntax «a|b|c» into a readable list.
  if (text) filters.push({ label: 'Запрос', value: clientMode ? text.replace(/\s*\|\s*/g, ', ') : text });
  const area = clientMode ? regionNames(config.area) : formatArea(config.area);
  if (area) filters.push({ label: 'Регион', value: area });
  if (config.salary_from !== undefined) {
    const currency = config.currency ? ` ${config.currency}` : '';
    filters.push({ label: 'Зарплата от', value: `${config.salary_from}${currency}`.trim() });
  } else if (!clientMode && config.currency && config.params && Object.prototype.hasOwnProperty.call(config.params, 'currency')) {
    filters.push({ label: 'Валюта', value: config.currency });
  }
  if (config.date_from) filters.push({ label: 'Дата от', value: config.date_from });
  if (config.date_to) filters.push({ label: 'Дата до', value: config.date_to });
  // Operator-only telemetry — meaningless to a client.
  if (!clientMode && config.per_page !== undefined) filters.push({ label: 'Per page', value: String(config.per_page) });
  if (!clientMode && config.fetch_employers) filters.push({ label: 'Работодатели', value: 'с деталями', tone: 'yellow' });
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
  busyAction = null,
  exportProgress,
  addToDatabaseDisabled,
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
  onAddToDatabase,
  onStopJob,
  onDeleteJob,
  clientMode,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);
  const [pageDraft, setPageDraft] = useState<string>(() => String(currentPage));
  const hasItems = items.length > 0;
  const hasJob = Boolean(jobId);
  const statsReady = hasJob && (!loading || count > 0);
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setPageDraft(String(currentPage));
  }, [currentPage]);

  const shownFrom = hasItems ? offset + 1 : 0;
  const shownTo = hasItems ? Math.min(count, offset + items.length) : 0;
  const shownLabel = statsReady
    ? clientMode
      ? (hasItems ? `Показаны первые ${Math.min(count, CLIENT_PREVIEW_LIMIT)} из ${count}` : `0 из ${count}`)
      : (hasItems ? `${shownFrom}–${shownTo} из ${count}` : `0 из ${count}`)
    : '';
  const limitLabel = !clientMode && statsReady && limit ? ` · по ${limit}` : '';
  const actionsDisabled = actionsBusy || (count === 0 && items.length === 0);
  const addToDbDisabled = actionsDisabled || !onAddToDatabase || Boolean(addToDatabaseDisabled);
  const jobControlsDisabled = jobActionBusy || !jobId;
  const searchUrl = buildSearchUrl(searchConfig);
  const filters = buildFilters(searchConfig, clientMode);
  const canPrev = currentPage > 1;
  const canNext = currentPage < totalPages;
  const isDatabaseBusy = busyAction === 'database';
  const isCsvBusy = busyAction === 'csv';
  const isExcelBusy = busyAction === 'excel';
  const isCopyBusy = busyAction === 'copy';
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

  const commitPageDraft = (value: string) => {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next)) {
      setPageDraft(String(currentPage));
      return;
    }
    const clamped = Math.min(Math.max(next, 1), totalPages);
    setPageDraft(String(clamped));
    if (!loading && clamped !== currentPage) onPageChange(clamped);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-gray-200">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                {!clientMode && (
                  <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-100 text-emerald-600">
                    <Table2 className="h-4 w-4" />
                  </span>
                )}
                Результаты
              </h3>
              {jobId ? (
                <div className="flex items-center gap-2 flex-shrink-0">
                  {jobStatus === 'running' ? (
                    <button
                      type="button"
                      onClick={() => onStopJob?.()}
                      disabled={jobControlsDisabled}
                      className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      Остановить
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onDeleteJob?.()}
                    disabled={jobControlsDisabled}
                    className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    Удалить
                  </button>
                </div>
              ) : null}
            </div>
            <p className="text-sm text-gray-500">
              {shownLabel}{limitLabel}
            </p>
            {clientMode && hasItems && count > CLIENT_PREVIEW_LIMIT ? (
              <p className="text-xs text-gray-400 mt-0.5">
                Вся база ({count}) — в выгрузке CSV или Excel.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-4 gap-2 w-full sm:flex sm:w-auto sm:flex-wrap sm:justify-end sm:gap-2 sm:items-center">
            {exportProgress ? (
              <div className="col-span-4 flex min-h-9 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 text-xs text-gray-600 sm:col-span-1 sm:mr-1">
                <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-300 border-t-transparent animate-spin flex-shrink-0" />
                <span className="whitespace-nowrap">{exportProgress}</span>
              </div>
            ) : null}
            {onAddToDatabase ? (
            <button
              type="button"
              onClick={onAddToDatabase}
              disabled={addToDbDisabled}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
              title="Откроет “Базы” и добавит результаты новой вкладкой"
              aria-busy={isDatabaseBusy}
            >
              {isDatabaseBusy ? (
                <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
              ) : (
                <Database className="h-4 w-4" />
              )}
              В базу
            </button>
            ) : null}
            <button
              type="button"
              onClick={onExportCsv}
              disabled={actionsDisabled}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
              aria-busy={isCsvBusy}
            >
              {isCsvBusy ? (
                <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              CSV
            </button>
            <button
              type="button"
              onClick={onExportExcel}
              disabled={actionsDisabled}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
              aria-busy={isExcelBusy}
            >
              {isExcelBusy ? (
                <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Excel
            </button>
            <button
              type="button"
              onClick={onCopy}
              disabled={actionsDisabled}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
              aria-busy={isCopyBusy}
            >
              {isCopyBusy ? (
                <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Копировать
            </button>
          </div>
        </div>
      </div>

      {searchConfig ? (
        <div className="px-6 py-3 border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
          {!clientMode && searchUrl ? (
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
          <RunningEmptyState key={jobId ?? 'running'} clientMode={clientMode} />
        ) : (!hasJob || loading) ? (
          <LoadingEmptyState />
        ) : (
          <div className="px-6 py-10 text-center text-gray-500">Нет результатов</div>
        )
      ) : (
        <div className={clientMode ? 'overflow-auto max-h-[400px]' : 'overflow-x-auto'}>
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {/* Client: align headers to their columns (text left, numbers right).
                    Operators keep the original centered headers. */}
                {([
                  { label: 'Вакансия', align: 'left' },
                  { label: 'Компания', align: 'left' },
                  { label: 'Регион', align: 'left' },
                  { label: 'ЗП', align: 'right' },
                  { label: 'Дата', align: 'right' },
                ] as const).map(({ label, align }) => (
                  <th
                    key={label}
                    className={`${clientMode ? 'px-3 py-2' : 'px-4 py-3'} text-xs font-semibold uppercase tracking-wider text-gray-500 sticky top-0 bg-gray-50 ${
                      clientMode ? (align === 'right' ? 'text-right' : 'text-left') : 'text-center'
                    }`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(clientMode ? items.slice(0, CLIENT_PREVIEW_LIMIT) : items).map((v) => (
                <tr key={v.vacancy_id} className="hover:bg-gray-50">
                  <td className={clientMode ? 'px-3 py-1.5' : 'px-4 py-3'}>
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`font-medium text-blue-600 hover:underline inline-flex items-start gap-1 ${clientMode ? 'text-xs' : 'text-sm'}`}
                      title={v.name}
                    >
                      <span className={clientMode ? 'line-clamp-1' : 'line-clamp-2'}>{v.name}</span>
                      {!clientMode && <ExternalLink className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
                    </a>
                  </td>
                  <td className={`text-gray-700 ${clientMode ? 'px-3 py-1.5 text-xs' : 'px-4 py-3 text-sm'}`}>
                    {v.company_site_url || v.company_url ? (
                      <div className="inline-flex items-center gap-2 max-w-full">
                        <span className={clientMode ? 'truncate max-w-[150px]' : ''} title={v.company_name}>{v.company_name}</span>
                        <a
                          href={v.company_site_url ?? v.company_url ?? '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-xs text-blue-600 hover:underline"
                          title={v.company_site_url ? 'Открыть сайт компании' : 'Открыть страницу компании на hh.ru'}
                        >
                          {/* Client: label honestly — «сайт» only for a real site;
                              the HH employer page (fallback) is labelled «hh.ru». */}
                          {clientMode && !v.company_site_url ? 'hh.ru' : 'сайт'}
                        </a>
                      </div>
                    ) : (
                      <span className={clientMode ? 'inline-block truncate max-w-[150px] align-bottom' : ''} title={v.company_name}>{v.company_name}</span>
                    )}
                  </td>
                  <td className={`text-gray-700 ${clientMode ? 'px-3 py-1.5 text-xs whitespace-nowrap' : 'px-4 py-3 text-sm'}`} title={v.area}>
                    {v.area}
                  </td>
                  <td className={`text-gray-700 text-right whitespace-nowrap ${clientMode ? 'px-3 py-1.5 text-xs' : 'px-4 py-3 text-sm'}`}>{formatSalary(v)}</td>
                  <td className={`text-gray-700 text-right whitespace-nowrap ${clientMode ? 'px-3 py-1.5 text-xs' : 'px-4 py-3 text-sm'}`}>{formatDate(v.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={clientMode ? 'hidden' : 'px-4 sm:px-6 py-3 sm:py-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3'}>
        <div className="hidden sm:block text-sm text-gray-500 whitespace-nowrap">
          Страница {Math.min(currentPage, totalPages)} из {totalPages}
        </div>
        {/* Mobile pagination */}
        <div className="flex w-full items-center gap-2 sm:hidden">
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={!canPrev || loading}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" />
            Назад
          </button>

          <div className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
            <span className="text-xs text-gray-500">стр.</span>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="Номер страницы"
              value={pageDraft}
              onChange={(e) => setPageDraft(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={() => commitPageDraft(pageDraft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPageDraft(pageDraft);
                if (e.key === 'Escape') setPageDraft(String(currentPage));
              }}
              disabled={loading || totalPages <= 1}
              className="w-12 bg-transparent text-center text-sm font-medium text-gray-900 outline-none disabled:opacity-50"
            />
            <span className="text-xs text-gray-500">/ {totalPages}</span>
          </div>

          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={!canNext || loading}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Вперёд
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Desktop/tablet pagination */}
        <div className="hidden sm:flex flex-wrap items-center gap-2">
          <button
            type="button"
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
                type="button"
                key={page}
                onClick={() => onPageChange(page)}
                disabled={loading}
                aria-current={page === currentPage ? 'page' : undefined}
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
            type="button"
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

