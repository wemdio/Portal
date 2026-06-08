'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Search, Download, Copy, Database, ExternalLink } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';
import {
  type PdlCompanyRow,
  SIZE_BUCKETS,
  EU_US_COUNTRIES,
  industryLabelRu,
  sizeLabelRu,
  countryLabelRu,
  synthDescription,
} from '@/lib/companyBase/labels';

type Facet = { value: string; count: number };
type FacetsResponse = { industries: Facet[]; countries: Facet[]; sizes: Facet[] };
type SearchResponse = { items: PdlCompanyRow[]; count: number; limit: number; offset: number };

const PAGE = 50;
const EXPORT_PAGE = 1000;
const MAX_DB_ROWS = 8000;
const LIMIT_OPTIONS = [100, 200, 500, 1000];

const EXPORT_HEADER = ['Company', 'Site', 'Industry', 'Size', 'Country', 'City', 'Description', 'Source'];

function descriptionOf(r: PdlCompanyRow): string {
  return r.description || synthDescription(r);
}

function exportRow(r: PdlCompanyRow): string[] {
  return [
    r.name,
    r.website ?? '',
    industryLabelRu(r.industry),
    sizeLabelRu(r.size),
    countryLabelRu(r.country),
    r.locality ?? '',
    descriptionOf(r),
    'pdl',
  ];
}

function csvCell(v: unknown) {
  const t = String(v ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ');
  return `"${t.replaceAll('"', '""')}"`;
}

function downloadBlob(content: string, mime: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await authFetch(path, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text || `Request failed: ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j?.error) message = j.error;
    } catch {
      /* keep */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function buildQuery(f: {
  industry: string[];
  size: string[];
  country: string[];
  name: string;
  limit: number;
  offset: number;
}) {
  const p = new URLSearchParams();
  if (f.industry.length) p.set('industry', f.industry.join(','));
  if (f.size.length) p.set('size', f.size.join(','));
  if (f.country.length) p.set('country', f.country.join(','));
  if (f.name.trim()) p.set('name', f.name.trim());
  p.set('limit', String(f.limit));
  p.set('offset', String(f.offset));
  return p.toString();
}

export function EuUsCompanyBaseView() {
  const [facets, setFacets] = useState<FacetsResponse | null>(null);
  const [industry, setIndustry] = useState<string[]>([]);
  const [size, setSize] = useState<string[]>([]);
  const [country, setCountry] = useState<string[]>(['united states']);
  const [name, setName] = useState('');
  const [maxRows, setMaxRows] = useState(200);
  const [industrySearch, setIndustrySearch] = useState('');

  const [items, setItems] = useState<PdlCompanyRow[]>([]);
  const [count, setCount] = useState(0);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);

  // Load facets once.
  useEffect(() => {
    void (async () => {
      try {
        setFacets(await apiFetch<FacetsResponse>('/api/company-base/facets'));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки фильтров');
      }
    })();
  }, []);

  const filters = useMemo(
    () => ({ industry, size, country, name }),
    [industry, size, country, name],
  );

  // Debounced live match-count preview.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const data = await apiFetch<SearchResponse>(
            `/api/company-base/search?${buildQuery({ ...filters, limit: 1, offset: 0 })}`,
          );
          setPreviewCount(data.count);
        } catch {
          setPreviewCount(null);
        }
      })();
    }, 450);
    return () => window.clearTimeout(t);
  }, [filters]);

  const runSearch = useCallback(
    async (toPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const offset = (toPage - 1) * PAGE;
        const data = await apiFetch<SearchResponse>(
          `/api/company-base/search?${buildQuery({ ...filters, limit: PAGE, offset })}`,
        );
        setItems(data.items);
        setCount(data.count);
        setPage(toPage);
        setSearched(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка поиска');
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const fetchAllMatched = useCallback(async (): Promise<PdlCompanyRow[]> => {
    const cap = Math.min(maxRows, MAX_DB_ROWS);
    const all: PdlCompanyRow[] = [];
    let offset = 0;
    while (all.length < cap) {
      const data = await apiFetch<SearchResponse>(
        `/api/company-base/search?${buildQuery({ ...filters, limit: EXPORT_PAGE, offset })}`,
      );
      all.push(...data.items);
      setExportProgress(`Загрузка: ${Math.min(all.length, data.count)} / ${Math.min(data.count, cap)}`);
      if (data.items.length === 0 || all.length >= data.count) break;
      offset += data.items.length;
    }
    return all.slice(0, cap);
  }, [filters, maxRows]);

  const totalPages = Math.max(1, Math.ceil(count / PAGE));
  const toggle = (arr: string[], setArr: (v: string[]) => void, v: string) =>
    setArr(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const industryOptions = useMemo(() => {
    const list = facets?.industries ?? [];
    const q = industrySearch.trim().toLowerCase();
    return list.filter((f) => !q || industryLabelRu(f.value).toLowerCase().includes(q) || f.value.includes(q)).slice(0, 200);
  }, [facets, industrySearch]);

  const presentCountryCodes = useMemo(
    () => new Set((facets?.countries ?? []).map((c) => c.value)),
    [facets],
  );

  const exportCsv = useCallback(async () => {
    setActionsBusy(true);
    setExportProgress('CSV: подготовка');
    try {
      const rows = await fetchAllMatched();
      if (!rows.length) {
        setToast({ tone: 'error', message: 'Нет данных' });
        return;
      }
      const lines = [EXPORT_HEADER.join(',')];
      for (const r of rows) lines.push(exportRow(r).map(csvCell).join(','));
      lines.push(csvCell('Company data: People Data Labs, CC BY 4.0'));
      downloadBlob('﻿' + lines.join('\n'), 'text/csv;charset=utf-8', 'eu_us_companies.csv');
      setToast({ tone: 'success', message: `CSV: ${rows.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [fetchAllMatched]);

  const copyResults = useCallback(async () => {
    setActionsBusy(true);
    setExportProgress('Копирование');
    try {
      const rows = await fetchAllMatched();
      if (!rows.length) return;
      const lines = [EXPORT_HEADER.join('\t'), ...rows.map((r) => exportRow(r).join('\t'))];
      await navigator.clipboard.writeText(lines.join('\n'));
      setToast({ tone: 'success', message: `Скопировано: ${rows.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка копирования');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [fetchAllMatched]);

  const addToDatabase = useCallback(async () => {
    setActionsBusy(true);
    setExportProgress('Базы: подготовка');
    try {
      const rows = await fetchAllMatched();
      if (!rows.length) {
        setToast({ tone: 'error', message: 'Нет данных' });
        return;
      }
      const dbRows: string[][] = [EXPORT_HEADER, ...rows.map(exportRow)];
      const { id } = writePendingDbImport({ title: 'EU/US база компаний', rows: dbRows });
      setToast({ tone: 'success', message: `Добавлено в «Базы» (${rows.length})`, href: buildDatabasesImportUrl(id) });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка' });
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [fetchAllMatched]);

  return (
    <div className="space-y-6">
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          <div className="flex items-center gap-3">
            <span className="min-w-0">{toast.message}</span>
            {toast.href ? (
              <a href={toast.href} className="shrink-0 rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-900 hover:bg-emerald-50">
                Перейти
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Filter form */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" style={{ borderTop: '3px solid #16a34a' }}>
        <h2 className="text-lg font-semibold text-gray-900">EU/US · База компаний</h2>
        <p className="text-sm text-gray-500 mt-1">
          Выбери нишу, размер и страну — получишь компании с сайтами. Источник: People Data Labs (CC BY 4.0).
        </p>

        {!facets ? (
          <div className="mt-6 flex items-center gap-2 text-gray-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка фильтров…
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Страны</label>
              <div className="flex flex-wrap gap-2">
                {EU_US_COUNTRIES.filter((c) => presentCountryCodes.has(c.code)).map((c) => {
                  const on = country.includes(c.code);
                  return (
                    <button key={c.code} type="button" onClick={() => toggle(country, setCountry, c.code)}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium border ${on ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'}`}>
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Размер компании</label>
              <div className="flex flex-wrap gap-2">
                {SIZE_BUCKETS.map((s) => {
                  const on = size.includes(s);
                  return (
                    <button key={s} type="button" onClick={() => toggle(size, setSize, s)}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium border ${on ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'}`}>
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Ниша / индустрия {industry.length ? <span className="text-gray-400 font-normal">— выбрано: {industry.length}</span> : null}
              </label>
              <input value={industrySearch} onChange={(e) => setIndustrySearch(e.target.value)} placeholder="искать нишу…"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-green-400" />
              <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                {industryOptions.map((f) => {
                  const on = industry.includes(f.value);
                  return (
                    <label key={f.value} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                      <span className="flex items-center gap-2">
                        <input type="checkbox" checked={on} onChange={() => toggle(industry, setIndustry, f.value)} className="h-4 w-4 rounded border-gray-300 text-green-600" />
                        {industryLabelRu(f.value)}
                      </span>
                      <span className="text-xs text-gray-400 tabular-nums">{f.count.toLocaleString('ru-RU')}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Название содержит</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="необязательно"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-green-400" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Сколько выгрузить (макс.)</label>
                <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                  {LIMIT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-4 pt-1">
              <button onClick={() => void runSearch(1)} disabled={loading}
                className="inline-flex items-center rounded-xl bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                Показать компании
              </button>
              {previewCount != null ? (
                <span className="text-sm text-gray-500">≈ <b className="text-gray-800">{previewCount.toLocaleString('ru-RU')}</b> компаний под фильтр</span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      {searched ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-900">Компании ({count.toLocaleString('ru-RU')})</h3>
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : null}
              {exportProgress ? <span className="text-xs text-gray-500">{exportProgress}</span> : null}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => void exportCsv()} disabled={actionsBusy || !items.length}
                className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </button>
              <button onClick={() => void copyResults()} disabled={actionsBusy || !items.length}
                className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                <Copy className="h-4 w-4 mr-1.5" /> Копировать
              </button>
              <button onClick={() => void addToDatabase()} disabled={actionsBusy || !items.length}
                className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                <Database className="h-4 w-4 mr-1.5" /> В Базы
              </button>
            </div>
          </div>

          {!items.length ? (
            <div className="px-6 py-12 text-center text-gray-500">{loading ? 'Загрузка…' : 'Ничего не найдено'}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Компания</th>
                    <th className="px-4 py-3">Сайт</th>
                    <th className="px-4 py-3">Индустрия</th>
                    <th className="px-4 py-3">Размер</th>
                    <th className="px-4 py-3">Страна</th>
                    <th className="px-4 py-3">Описание</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900 capitalize">{r.name}</td>
                      <td className="px-4 py-3">
                        {r.website ? (
                          <a href={`https://${r.website}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-green-700 hover:underline">
                            {r.website} <ExternalLink className="h-3 w-3 text-gray-400" />
                          </a>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{industryLabelRu(r.industry)}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{r.size ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-500">{countryLabelRu(r.country)}</td>
                      <td className="px-4 py-3 text-gray-500 max-w-[280px] truncate" title={descriptionOf(r)}>{descriptionOf(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 ? (
            <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between text-sm">
              <button onClick={() => void runSearch(page - 1)} disabled={page <= 1 || loading}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40">Назад</button>
              <span className="text-gray-500">Стр. {page} из {totalPages.toLocaleString('ru-RU')}</span>
              <button onClick={() => void runSearch(page + 1)} disabled={page >= totalPages || loading}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40">Вперёд</button>
            </div>
          ) : null}

          <div className="px-6 py-2 border-t border-gray-100 text-[11px] text-gray-400">
            Данные о компаниях: People Data Labs, CC BY 4.0. Описание — индустрия/гео; реальное описание дотягивается со сайта.
          </div>
        </div>
      ) : null}
    </div>
  );
}
