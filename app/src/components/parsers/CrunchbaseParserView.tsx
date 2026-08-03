'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, Download, Copy, Database, ExternalLink, Banknote } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { supabase } from '@/lib/supabaseClient';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';
import {
  type FundedCompanyRow,
  EXPORT_HEADER,
  exportRow,
  countryLabelRu,
  industryLabelRu,
  sourceLabelRu,
  stageLabelRu,
  fundingHuman,
  bestFundingUsd,
  descriptionOf,
} from '@/lib/funded/labels';

type Facet = { value: string; count: number };
type FacetsResponse = { sources: Facet[]; countries: Facet[]; industries: Facet[]; stages: Facet[] };
type SearchResponse = { items: FundedCompanyRow[] };
type CountResponse = { estimate: number };

const PREVIEW = 100;
const ZIP_THRESHOLD = 100_000;
const MAX_DB_ROWS = 8000;

const MIN_FUNDING_PRESETS: { label: string; value: number }[] = [
  { label: 'любой', value: 0 },
  { label: '$100K+', value: 100_000 },
  { label: '$1M+', value: 1_000_000 },
  { label: '$5M+', value: 5_000_000 },
  { label: '$20M+', value: 20_000_000 },
];

const RECENCY_PRESETS: { label: string; months: number }[] = [
  { label: 'когда угодно', months: 0 },
  { label: 'за 3 мес.', months: 3 },
  { label: 'за 12 мес.', months: 12 },
  { label: 'за 24 мес.', months: 24 },
];

function monthsAgoISO(months: number): string | null {
  if (!months) return null;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, { method: 'GET', ...init });
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

type Filters = {
  source: string[];
  country: string[];
  industry: string[];
  stage: string[];
  minFunding: number;
  recencyMonths: number;
  name: string;
};

function filterQuery(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.source.length) p.set('source', f.source.join(','));
  if (f.country.length) p.set('country', f.country.join(','));
  if (f.industry.length) p.set('industry', f.industry.join(','));
  if (f.stage.length) p.set('stage', f.stage.join(','));
  if (f.minFunding > 0) p.set('min_funding', String(f.minFunding));
  const since = monthsAgoISO(f.recencyMonths);
  if (since) p.set('funded_since', since);
  if (f.name.trim()) p.set('name', f.name.trim());
  return p;
}

export function CrunchbaseParserView() {
  const [facets, setFacets] = useState<FacetsResponse | null>(null);
  const [source, setSource] = useState<string[]>([]);
  const [country, setCountry] = useState<string[]>([]);
  const [industry, setIndustry] = useState<string[]>([]);
  const [stage, setStage] = useState<string[]>([]);
  const [minFunding, setMinFunding] = useState(0);
  const [recencyMonths, setRecencyMonths] = useState(0);
  const [name, setName] = useState('');
  const [industrySearch, setIndustrySearch] = useState('');

  const [exportAll, setExportAll] = useState(false);
  const [exportN, setExportN] = useState('5000');

  const [items, setItems] = useState<FundedCompanyRow[]>([]);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);

  const countAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setFacets(await apiFetch<FacetsResponse>('/api/funded/facets'));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки фильтров');
      }
    })();
  }, []);

  const filters: Filters = useMemo(
    () => ({ source, country, industry, stage, minFunding, recencyMonths, name }),
    [source, country, industry, stage, minFunding, recencyMonths, name],
  );
  const filtersKey = useMemo(() => filterQuery(filters).toString(), [filters]);

  // SEC is the only funding-data source — with YC-only selected every funding
  // filter can only return zeros, so the whole block is dimmed for clarity.
  const fundingUnavailable = source.length > 0 && source.every((s) => s === 'yc');

  useEffect(() => {
    countAbort.current?.abort();
    const ac = new AbortController();
    countAbort.current = ac;
    setCounting(true);
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const data = await apiFetch<CountResponse>(`/api/funded/count?${filtersKey}`, { signal: ac.signal });
          if (!ac.signal.aborted) {
            setEstimate(data.estimate);
            setCounting(false);
          }
        } catch {
          if (!ac.signal.aborted) setCounting(false);
        }
      })();
    }, 400);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [filtersKey]);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<SearchResponse>(`/api/funded/search?${filterQuery(filters).toString()}&limit=${PREVIEW}`);
      setItems(data.items);
      setSearched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const toggle = (arr: string[], setArr: (v: string[]) => void, v: string) =>
    setArr(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const industryOptions = useMemo(() => {
    const list = facets?.industries ?? [];
    const q = industrySearch.trim().toLowerCase();
    return list.filter((f) => !q || industryLabelRu(f.value).toLowerCase().includes(q) || f.value.includes(q)).slice(0, 250);
  }, [facets, industrySearch]);

  const downloadFile = useCallback(async () => {
    setActionsBusy(true);
    setProgress('Готовим выгрузку…');
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Нет сессии');
      const n = Math.max(1, Number(exportN) || 1000);
      const big = exportAll || n > ZIP_THRESHOLD;
      const p = filterQuery(filters);
      p.set('t', token);
      if (exportAll) p.set('all', '1');
      else p.set('max', String(n));
      if (big) p.set('format', 'zip');
      window.location.href = `/api/funded/export?${p.toString()}`;
      setToast({ tone: 'success', message: big ? 'Готовим ZIP (файлы по 100к)…' : 'Скачивание началось…' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка выгрузки');
    } finally {
      setActionsBusy(false);
      setTimeout(() => setProgress(null), 2000);
    }
  }, [filters, exportN, exportAll]);

  const copyPreview = useCallback(async () => {
    if (!items.length) return;
    const lines = [EXPORT_HEADER.join('\t'), ...items.map((r) => exportRow(r).join('\t'))];
    await navigator.clipboard.writeText(lines.join('\n'));
    setToast({ tone: 'success', message: `Скопировано: ${items.length} (превью)` });
  }, [items]);

  const addToDatabase = useCallback(async () => {
    setActionsBusy(true);
    setProgress('Базы: загрузка…');
    try {
      const rows: FundedCompanyRow[] = [];
      for (let offset = 0; rows.length < MAX_DB_ROWS; offset += 1000) {
        const data = await apiFetch<SearchResponse>(`/api/funded/search?${filterQuery(filters).toString()}&limit=1000&offset=${offset}`);
        rows.push(...data.items);
        if (data.items.length < 1000) break;
      }
      if (!rows.length) {
        setToast({ tone: 'error', message: 'Нет данных' });
        return;
      }
      const dbRows: string[][] = [EXPORT_HEADER as unknown as string[], ...rows.slice(0, MAX_DB_ROWS).map(exportRow)];
      const { id } = await writePendingDbImport({ title: 'Crunchbase · стартапы и раунды', rows: dbRows });
      setToast({ tone: 'success', message: `Добавлено в «Базы» (${Math.min(rows.length, MAX_DB_ROWS)})`, href: buildDatabasesImportUrl(id) });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка' });
    } finally {
      setActionsBusy(false);
      setProgress(null);
    }
  }, [filters]);

  return (
    <div className="space-y-6">
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {toast ? (
        <div className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${toast.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
          <div className="flex items-center gap-3">
            <span className="min-w-0">{toast.message}</span>
            {toast.href ? <a href={toast.href} className="shrink-0 rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-900 hover:bg-emerald-50">Перейти</a> : null}
          </div>
        </div>
      ) : null}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" style={{ borderTop: '3px solid #16a34a' }}>
        <h2 className="text-lg font-semibold text-gray-900">Crunchbase · Стартапы и раунды</h2>
        <p className="text-sm text-gray-500 mt-1">
          Компании US/глобал с сайтом, описанием и данными по фандингу. Источники: Y Combinator, SEC EDGAR Form D (раунды в США), People Data Labs.
        </p>

        {!facets ? (
          <div className="mt-6 flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Загрузка фильтров…</div>
        ) : (
          <div className="mt-5 space-y-5">
            {/* Source */}
            {facets.sources.length ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Источник</label>
                <div className="flex flex-wrap gap-2">
                  {facets.sources.map((s) => {
                    const on = source.includes(s.value);
                    return <button key={s.value} type="button" onClick={() => toggle(source, setSource, s.value)} className={`rounded-full px-3 py-1.5 text-sm font-medium border ${on ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'}`}>{sourceLabelRu(s.value)} <span className={on ? 'text-green-100' : 'text-gray-400'}>{s.count.toLocaleString('ru-RU')}</span></button>;
                  })}
                </div>
              </div>
            ) : null}

            {/* Funding controls */}
            <div className={`rounded-lg border p-4 space-y-3 ${fundingUnavailable ? 'border-gray-200 bg-gray-50' : 'border-emerald-100 bg-emerald-50/40'}`}>
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <Banknote className={`h-4 w-4 ${fundingUnavailable ? 'text-gray-400' : 'text-emerald-600'}`} /> Фандинг
                {fundingUnavailable ? <span className="text-xs font-normal text-gray-400">— недоступен: у YC нет данных о раундах (только SEC)</span> : null}
              </div>
              <div className={fundingUnavailable ? 'pointer-events-none opacity-40' : undefined}>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">сумма раунда:</span>
                  {MIN_FUNDING_PRESETS.map((m) => (
                    <button key={m.value} type="button" onClick={() => setMinFunding(m.value)} className={`rounded-full px-2.5 py-1 text-xs font-medium border ${minFunding === m.value ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'}`}>{m.label}</button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">привлекли:</span>
                  {RECENCY_PRESETS.map((m) => (
                    <button key={m.months} type="button" onClick={() => setRecencyMonths(m.months)} className={`rounded-full px-2.5 py-1 text-xs font-medium border ${recencyMonths === m.months ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'}`}>{m.label}</button>
                  ))}
                  <span className="text-[11px] text-gray-400">только по SEC (US) — у YC дат раундов нет</span>
                </div>
              </div>
              {facets.stages.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-500">тип раунда:</span>
                  {facets.stages.slice(0, 12).map((s) => {
                    const on = stage.includes(s.value);
                    return <button key={s.value} type="button" onClick={() => toggle(stage, setStage, s.value)} className={`rounded-full px-2.5 py-1 text-xs font-medium border ${on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'}`}>{stageLabelRu(s.value)}</button>;
                  })}
                </div>
              ) : null}
              </div>
            </div>

            {/* Country */}
            {facets.countries.length ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Страны</label>
                <div className="flex flex-wrap gap-2">
                  {facets.countries.slice(0, 30).map((c) => {
                    const on = country.includes(c.value);
                    return <button key={c.value} type="button" onClick={() => toggle(country, setCountry, c.value)} className={`rounded-full px-3 py-1.5 text-sm font-medium border ${on ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:border-green-400'}`}>{countryLabelRu(c.value)}</button>;
                  })}
                </div>
              </div>
            ) : null}

            {/* Industry */}
            {facets.industries.length ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Ниша / индустрия {industry.length ? <span className="text-gray-400 font-normal">— выбрано: {industry.length}</span> : null}</label>
                <input value={industrySearch} onChange={(e) => setIndustrySearch(e.target.value)} placeholder="искать нишу…" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-1 focus:ring-green-400" />
                <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                  {industryOptions.map((f) => {
                    const on = industry.includes(f.value);
                    return (
                      <label key={f.value} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                        <span className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={() => toggle(industry, setIndustry, f.value)} className="h-4 w-4 rounded border-gray-300 text-green-600" />{industryLabelRu(f.value)}</span>
                        <span className="text-xs text-gray-400 tabular-nums">{f.count.toLocaleString('ru-RU')}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Название содержит</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="необязательно" className="w-full md:w-1/2 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-green-400" />
            </div>

            <div className="flex items-center gap-4 pt-1 flex-wrap">
              <button onClick={() => void runPreview()} disabled={loading} className="inline-flex items-center rounded-xl bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                Показать превью (100)
              </button>
              <span className="text-sm text-gray-500">
                {counting ? <span className="text-gray-400">≈ …</span> : estimate != null ? <>≈ <b className="text-gray-800">{estimate.toLocaleString('ru-RU')}</b> компаний под фильтр</> : null}
              </span>
            </div>

            {/* Export controls */}
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-sm font-medium text-gray-700">Выгрузить в файл:</span>
                <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={exportAll} onChange={(e) => setExportAll(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-green-600" />
                  Все (≈ {(estimate ?? 0).toLocaleString('ru-RU')})
                </label>
                {!exportAll ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
                    или
                    <input value={exportN} onChange={(e) => setExportN(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="w-28 rounded-lg border border-gray-300 px-2 py-1 text-sm" />
                    строк
                  </span>
                ) : null}
                <button onClick={() => void downloadFile()} disabled={actionsBusy} className="inline-flex items-center rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                  <Download className="h-4 w-4 mr-1.5" /> Скачать
                </button>
                {progress ? <span className="text-xs text-gray-500">{progress}</span> : null}
              </div>
              <p className="mt-2 text-[11px] text-gray-400">Большие выгрузки (&gt; 100 000) скачиваются ZIP-архивом из файлов по 100к строк. Качается напрямую на диск.</p>
            </div>
          </div>
        )}
      </div>

      {searched ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-900">Превью — первые {items.length}</h3>
              {estimate != null ? <span className="text-sm text-gray-500">из ≈ {estimate.toLocaleString('ru-RU')}</span> : null}
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : null}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => void copyPreview()} disabled={!items.length} className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"><Copy className="h-4 w-4 mr-1.5" /> Копировать превью</button>
              <button onClick={() => void addToDatabase()} disabled={actionsBusy} className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Database className="h-4 w-4 mr-1.5" /> В Базы (до 8к)</button>
            </div>
          </div>

          {!items.length ? (
            <div className="px-6 py-12 text-center text-gray-500">{loading ? 'Загрузка…' : 'Ничего не найдено'}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Компания</th><th className="px-4 py-3">Сайт</th><th className="px-4 py-3">Описание</th><th className="px-4 py-3">Индустрия</th><th className="px-4 py-3">Страна</th><th className="px-4 py-3">Фандинг</th><th className="px-4 py-3">Последний раунд</th><th className="px-4 py-3">Источник</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((r) => {
                    const fund = fundingHuman(bestFundingUsd(r));
                    return (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{r.name}</td>
                        <td className="px-4 py-3">{r.website ? <a href={r.website.startsWith('http') ? r.website : `https://${r.website}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-green-700 hover:underline">{r.website.replace(/^https?:\/\//, '')} <ExternalLink className="h-3 w-3 text-gray-400" /></a> : <span className="text-gray-400">—</span>}</td>
                        <td className="px-4 py-3 text-gray-500 max-w-[320px] truncate" title={descriptionOf(r)}>{descriptionOf(r)}</td>
                        <td className="px-4 py-3 text-gray-600">{industryLabelRu(r.industry)}</td>
                        <td className="px-4 py-3 text-gray-500">{countryLabelRu(r.country)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">{fund ? <span className="font-medium text-emerald-700">{fund}</span> : <span className="text-gray-300">—</span>}</td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{r.last_funding_date ? <span>{r.last_funding_date}{r.last_funding_type ? <span className="text-gray-400"> · {stageLabelRu(r.last_funding_type)}</span> : null}</span> : <span className="text-gray-300">—</span>}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs">{sourceLabelRu(r.source)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-6 py-2 border-t border-gray-100 text-[11px] text-gray-400">Это превью (первые 100). Всю выборку получишь кнопкой «Скачать». Данные: Y Combinator, SEC EDGAR (public domain), People Data Labs (CC BY 4.0).</div>
        </div>
      ) : null}
    </div>
  );
}
