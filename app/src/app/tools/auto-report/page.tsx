'use client';

import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { FileText, ExternalLink, Loader2, Download, ListFilter, Search, FileSpreadsheet, Check } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabaseClient';

const ROW_HEIGHT = 44;
const OVERSCAN = 8;
const INSTANTLY_ANALYTICS_URL_BASE = 'https://app.instantly.ai/app/campaign/';

interface InstantlyCampaignItem {
  id: string;
  name: string;
  status?: number;
}

const CampaignRow = memo(function CampaignRow({
  campaign,
  isChecked,
  onToggle,
}: {
  campaign: InstantlyCampaignItem;
  isChecked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <li>
      <label
        htmlFor={`camp-${campaign.id}`}
        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors h-[38px] box-border ${
          isChecked
            ? 'bg-indigo-50 border border-indigo-100'
            : 'bg-gray-50/80 border border-transparent hover:bg-gray-100/90 hover:border-gray-200'
        }`}
      >
        <input
          type="checkbox"
          id={`camp-${campaign.id}`}
          checked={isChecked}
          onChange={() => onToggle(campaign.id)}
          className="sr-only"
        />
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
            isChecked ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-transparent'
          }`}
        >
          <Check className="h-3 w-3 stroke-[3]" />
        </span>
        <span className="flex-1 min-w-0 text-sm font-medium text-gray-800 break-words truncate">
          {campaign.name || campaign.id}
        </span>
        <a
          href={`${INSTANTLY_ANALYTICS_URL_BASE}${campaign.id}/analytics`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-200 hover:text-indigo-600 transition-colors"
          title="Открыть аналитику в Instantly"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </label>
    </li>
  );
});

const RESULTS_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1I4mQLI2evf1049-pJmX5YU8jwNnOMK5fRz1X6EymRW0/edit?usp=sharing';

const INSTANTLY_ANALYTICS_URL = (id: string) =>
  `https://app.instantly.ai/app/campaign/${id}/analytics`;

interface ReportSummary {
  totalCampaigns: number;
  totalContacts: number;
  totalEmailsSent: number;
  totalOpened: number;
  totalReplies: number;
  totalLeads: number;
  totalBounced: number;
  conversion: { openPctAllEmails: string; replyPctByLeads: string };
}

interface ReportResponse {
  tableText: string;
  csvText: string;
  rows: (string | number)[][];
  summary: ReportSummary;
  campaignData: Record<string, unknown>;
}

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? '';
}

function downloadCsv(csvText: string, filename: string) {
  const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function tableTextToRows(tableText: string): string[][] {
  return tableText.split('\n').map((line) => line.split('\t'));
}

function getColumnWidths(rows: (string | number)[][]): { wch: number }[] {
  if (!rows.length) return [];
  const numCols = rows.reduce((max, r) => (r.length > max ? r.length : max), 0);
  const widths: number[] = Array.from({ length: numCols }, () => 10);
  for (const row of rows) {
    row.forEach((cell, c) => {
      const len = String(cell).length;
      if (c < widths.length && len > widths[c]) widths[c] = Math.min(len, 65);
    });
  }
  return widths.map((w) => ({ wch: Math.max(w + 2, 12) }));
}

function setSheetColumnWidths(ws: XLSX.WorkSheet, rows: (string | number)[][]) {
  const cols = getColumnWidths(rows);
  if (cols.length) ws['!cols'] = cols;
}

function downloadExcel(tableText: string, summaryRows: (string | number)[][], filename: string) {
  const wb = XLSX.utils.book_new();
  const fullReportRows = tableTextToRows(tableText);
  const wsReport = XLSX.utils.aoa_to_sheet(fullReportRows);
  setSheetColumnWidths(wsReport, fullReportRows);
  XLSX.utils.book_append_sheet(wb, wsReport, 'Отчёт');
  if (summaryRows.length > 0) {
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    setSheetColumnWidths(wsSummary, summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Сводка');
  }
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export default function AutoReportPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);

  const [campaignsList, setCampaignsList] = useState<InstantlyCampaignItem[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsFetched, setCampaignsFetched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const filteredCampaigns = useMemo(() => {
    const q = normalizeForSearch(searchQuery);
    if (!q) return campaignsList;
    return campaignsList.filter((c) => normalizeForSearch(c.name || '').includes(q));
  }, [campaignsList, searchQuery]);

  const { startIndex, endIndex, totalHeight, visibleCampaigns } = useMemo(() => {
    const list = filteredCampaigns;
    const total = list.length;
    if (total === 0) return { startIndex: 0, endIndex: 0, totalHeight: 0, visibleCampaigns: [] };
    const containerHeight = 28 * 16;
    const rowCount = Math.ceil(containerHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(total, start + rowCount);
    return {
      startIndex: start,
      endIndex: end,
      totalHeight: total * ROW_HEIGHT,
      visibleCampaigns: list.slice(start, end),
    };
  }, [filteredCampaigns, scrollTop]);

  const loadCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setError('');
    try {
      const token = await getToken();
      if (!token) {
        setError('Нужна авторизация. Войдите в аккаунт.');
        setCampaignsLoading(false);
        return;
      }
      const res = await fetch('/api/tools/auto-report/campaigns', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as { campaigns?: InstantlyCampaignItem[]; error?: string };
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`);
        setCampaignsLoading(false);
        return;
      }
      setCampaignsList(data.campaigns ?? []);
      setSelectedIds(new Set());
      setCampaignsFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки кампаний');
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  const toggleCampaign = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllCampaigns = () => {
    setSelectedIds(new Set(filteredCampaigns.map((c) => c.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setReport(null);
    const token = await getToken();
    if (!token) {
      setError('Нужна авторизация. Войдите в аккаунт.');
      return;
    }

    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setError('Выберите хотя бы одну кампанию для отчёта.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/tools/auto-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ campaignIds: ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data.error as string) || `Ошибка ${res.status}`);
        setLoading(false);
        return;
      }
      setReport(data as ReportResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса');
    } finally {
      setLoading(false);
    }
  };

  const getReportFilenamePrefix = () => {
    const d = new Date();
    const date = d.toISOString().slice(0, 10);
    const time = `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
    return `instantly-report-${date}-${time}`;
  };

  const handleDownloadCsv = () => {
    if (!report?.csvText) return;
    downloadCsv(report.csvText, `${getReportFilenamePrefix()}.csv`);
  };

  const handleDownloadExcel = () => {
    if (!report?.tableText) return;
    downloadExcel(report.tableText, report.rows ?? [], `${getReportFilenamePrefix()}.xlsx`);
  };

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Автоотчёт по email-кампаниям</h1>
        <p className="text-sm text-gray-500 mt-1">
          Сформируйте отчёт по кампаниям Instantly: статистика по кампаниям, общая сводка и
          детализация по письмам. Подгрузите кампании, найдите по названию и выберите для отчёта.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <FileText className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Сформировать отчёт</h2>
            <p className="text-sm text-gray-600 mt-0.5">
              Подгрузите список кампаний из Instantly, найдите нужные по названию и выберите проекты для отчёта.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={loadCampaigns}
                disabled={campaignsLoading || loading}
                className="inline-flex items-center gap-2 px-3 py-2 border border-indigo-300 bg-indigo-50 text-indigo-700 text-sm font-medium rounded-lg hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
              >
                {campaignsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ListFilter className="h-4 w-4" />
                )}
                {campaignsLoading ? 'Загрузка…' : 'Подгрузить кампании'}
              </button>
              {campaignsList.length > 0 && (
                <div className="inline-flex items-center gap-2">
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={filteredCampaigns.length > 0 && selectedIds.size === filteredCampaigns.length}
                      onChange={(e) => (e.target.checked ? selectAllCampaigns() : clearSelection())}
                      className="sr-only"
                    />
                    <span className="text-sm font-medium text-indigo-600">Выбрать все</span>
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
                        filteredCampaigns.length > 0 && selectedIds.size === filteredCampaigns.length
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-gray-300 bg-white text-transparent'
                      }`}
                    >
                      <Check className="h-3 w-3 stroke-[3]" />
                    </span>
                  </label>
                  <span className="text-sm text-gray-600">
                    Выбрано: {selectedIds.size} из {campaignsList.length}
                  </span>
                </div>
              )}
            </div>

            {campaignsFetched && campaignsList.length === 0 && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Кампаний не найдено. Убедитесь, что API-ключ Instantly v2 с правом <code className="bg-amber-100 px-1 rounded">campaigns:read</code> и в workspace есть кампании.
              </p>
            )}

            {campaignsList.length > 0 && (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Поиск по названию кампании (например: База Snabb_Руспрофайл_ОКВЭД)"
                    className="block w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  {searchQuery && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                      Найдено: {filteredCampaigns.length}
                    </span>
                  )}
                </div>
                <div
                  ref={listContainerRef}
                  onScroll={() => setScrollTop(listContainerRef.current?.scrollTop ?? 0)}
                  className="max-h-[28rem] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1.5 w-full min-w-0 shadow-inner"
                >
                  {filteredCampaigns.length === 0 && searchQuery ? (
                    <p className="text-sm text-gray-500 py-6 text-center">По запросу «{searchQuery}» ничего не найдено</p>
                  ) : filteredCampaigns.length > 0 ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                      <ul
                        className="space-y-0.5 absolute left-0 right-0 px-0 list-none"
                        style={{ top: startIndex * ROW_HEIGHT, margin: 0, paddingLeft: 2, paddingRight: 2 }}
                      >
                        {visibleCampaigns.map((c) => (
                          <CampaignRow
                            key={c.id}
                            campaign={c}
                            isChecked={selectedIds.has(c.id)}
                            onToggle={toggleCampaign}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={loading || selectedIds.size === 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Формирую отчёт…
                </>
              ) : (
                'Сформировать отчёт'
              )}
            </button>
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        {report && (
          <div className="mt-6 space-y-4 border-t border-gray-200 pt-6">
            <h3 className="font-semibold text-gray-900">Результат</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Кампаний</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalCampaigns}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Контактов</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalContacts}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Отправлено писем</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalEmailsSent}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">% открытий</div>
                <div className="text-lg font-semibold text-gray-900">
                  {report.summary.conversion.openPctAllEmails}%
                </div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Ответов</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalReplies}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">% ответов</div>
                <div className="text-lg font-semibold text-gray-900">
                  {report.summary.conversion.replyPctByLeads}%
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleDownloadCsv}
                className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
              >
                <Download className="h-4 w-4" />
                Скачать CSV
              </button>
              <button
                type="button"
                onClick={handleDownloadExcel}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Скачать Excel
              </button>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-900">
                Показать таблицу
              </summary>
              <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
                <pre className="p-3 text-xs text-gray-700 whitespace-pre-wrap font-sans">
                  {report.tableText}
                </pre>
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
