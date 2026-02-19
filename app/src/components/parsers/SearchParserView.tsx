
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { SearchParserJob, SearchResult } from '@/types/parsers';
import { SearchParserForm } from './SearchParserForm';
import { isStoppedByUser, JobStatus } from './JobStatus';
import { RefreshCw, Download, ExternalLink, FileSpreadsheet, Loader2, CirclePause, Trash2, Database, Copy } from 'lucide-react';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';

type Lead = {
  id: string;
  company_name: string | null;
  site: string | null;
  email: string | null;
  description: string | null;
  queries: string[];
  sources: number;
  created_at: string;
};

const exportHeader = ['Company', 'Site', 'Email', 'Description', 'Queries'];

function tsvCell(value: unknown) {
  return String(value ?? '')
    .replaceAll('\t', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
}

function safeHostname(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

// Note: the search parser stores/displays only company leads (source pages are used internally but not shown as results).

function escapeHtml(value: unknown) {
  const text = String(value ?? '')
    .replaceAll('\t', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function exportRow(r: Lead) {
  return [
    r.company_name ?? '',
    r.site ?? '',
    r.email ?? '',
    r.description ?? '',
    (r.queries ?? []).join(' · '),
  ];
}

function buildCsv(items: Lead[]) {
  const lines = [exportHeader.join(',')];
  for (const item of items) {
    const row = exportRow(item).map((val) => {
      const text = String(val).replaceAll('"', '""');
      return `"${text}"`;
    });
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function buildTsv(items: Lead[]) {
  const lines = [exportHeader.map(tsvCell).join('\t')];
  for (const item of items) {
    const row = exportRow(item).map(tsvCell);
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

async function writeTextToClipboard(text: string) {
  const tryClipboardApi = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  };

  const tryLegacyCopy = async () => {
    if (typeof document === 'undefined') return false;
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '0';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      el.remove();
    }
    return ok;
  };

  // On Windows/Chromium `navigator.clipboard.writeText` can silently truncate huge payloads.
  // Prefer legacy copy path for large exports.
  const LARGE_TEXT_THRESHOLD = 1_000_000;
  const preferLegacy = text.length >= LARGE_TEXT_THRESHOLD;

  if (preferLegacy) {
    const ok = await tryLegacyCopy();
    if (ok) return;
    const apiOk = await tryClipboardApi();
    if (apiOk) return;
    throw new Error('Clipboard API недоступен');
  }

  const apiOk = await tryClipboardApi();
  if (apiOk) return;
  const ok = await tryLegacyCopy();
  if (ok) return;
  throw new Error('Clipboard API недоступен');
}

function buildExcelHtml(items: Lead[]) {
  const header = exportHeader
    .map((h) => `<th style="border:1px solid #d1d5db;padding:4px 6px;white-space:nowrap;">${escapeHtml(h)}</th>`)
    .join('');
  const body = items
    .map((item) => {
      const cells = exportRow(item)
        .map((cell) => `<td style="border:1px solid #d1d5db;padding:4px 6px;white-space:nowrap;">${escapeHtml(cell)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body><table style="border-collapse:collapse;"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function useTimedFlag(durationMs: number) {
  const [flag, setFlag] = useState(false);
  const timerRef = useRef<number | null>(null);

  const trigger = useCallback(() => {
    setFlag(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setFlag(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { flag, trigger };
}

function getExportFilename(extension: string) {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = now.getFullYear();
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `leads_${d}${m}${y}_${h}${min}.${extension}`;
}

export function SearchParserView() {
  const [jobs, setJobs] = useState<SearchParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);
  const [copying, setCopying] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const latestCreatedAtRef = useRef<string | null>(null);

  const activeJob = useMemo(() => jobs.find(j => j.id === activeJobId), [jobs, activeJobId]);
  const leads = useMemo(() => {
    const pickBetterText = (a: string | null, b: string | null) => {
      const aa = (a ?? '').trim();
      const bb = (b ?? '').trim();
      if (!aa) return bb || null;
      if (!bb) return aa || null;
      return bb.length > aa.length ? bb : aa;
    };

    const scoreCompanyName = (value: string | null) => {
      const s = (value ?? '').trim();
      if (!s) return -100;
      let score = 0;
      if (s.length >= 2 && s.length <= 80) score += 5;
      else if (s.length <= 140) score += 2;
      else score -= 2;
      if (/\b(ООО|ЗАО|ОАО|ПАО|АО|ИП)\b/i.test(s)) score += 4;
      if (/^\d/.test(s)) score -= 6;
      if (/(рейтинг|топ|лучши|обзор|каталог|список|реестр|ваканс|новост|блог|статья)/i.test(s)) score -= 6;
      if (/https?:\/\//i.test(s)) score -= 4;
      if (/\w+\.\w+/.test(s)) score -= 2;
      if (/[|]/.test(s)) score -= 1;
      return score;
    };

    const pickBetterCompanyName = (a: string | null, b: string | null) => {
      const aa = (a ?? '').trim();
      const bb = (b ?? '').trim();
      if (!aa) return bb || null;
      if (!bb) return aa || null;
      const sa = scoreCompanyName(aa);
      const sb = scoreCompanyName(bb);
      if (sb !== sa) return sb > sa ? bb : aa;
      return bb.length < aa.length ? bb : aa;
    };

    const mergeEmails = (prev: string | null, next: string | null) => {
      const items = new Set<string>();
      const add = (raw: string | null) => {
        if (!raw) return;
        raw
          .split(/[;,]/g)
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => items.add(s));
      };
      add(prev);
      add(next);
      return items.size ? Array.from(items).join('; ') : null;
    };

    const map = new Map<string, Lead>();
    for (const r of results) {
      const key = (r.site ?? r.link ?? '').trim().toLowerCase();
      if (!key) continue;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          id: r.id,
          company_name: r.company_name ?? null,
          site: r.site ?? null,
          email: r.email ?? null,
          description: (r.description ?? r.snippet ?? null) as string | null,
          queries: r.query ? [r.query] : [],
          sources: 1,
          created_at: r.created_at,
        });
        continue;
      }

      existing.company_name = pickBetterCompanyName(existing.company_name, r.company_name ?? null);
      existing.site = existing.site ?? (r.site ?? null);
      existing.email = mergeEmails(existing.email, r.email ?? null);
      existing.description = pickBetterText(existing.description, (r.description ?? r.snippet ?? null) as string | null);
      if (r.query && !existing.queries.includes(r.query)) existing.queries.push(r.query);
      existing.sources += 1;
    }

    return Array.from(map.values()).sort((a, b) => {
      const an = (a.company_name ?? a.site ?? '').toLowerCase();
      const bn = (b.company_name ?? b.site ?? '').toLowerCase();
      return an.localeCompare(bn, 'ru');
    });
  }, [results]);

  const companyLeads = leads;

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Request failed: ${res.status}`);
    }

    return (await res.json()) as T;
  }, [getAccessToken]);

  useEffect(() => {
    latestCreatedAtRef.current = results.length ? results[results.length - 1]?.created_at ?? null : null;
  }, [results]);

  const refreshJobs = useCallback(async () => {
    try {
      const { data } = await supabase.from('search_parser_jobs').select('*').order('created_at', { ascending: false });
      if (data) setJobs(data);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadResults = useCallback(
    async (jobId: string, mode: 'initial' | 'incremental' = 'initial') => {
      const isInitial = mode === 'initial';
      if (isInitial) setLoadingResults(true);
      try {
        const after = !isInitial ? latestCreatedAtRef.current : null;
        const url = after
          ? `/api/parsers/search/${jobId}/results?after=${encodeURIComponent(after)}`
          : `/api/parsers/search/${jobId}/results`;
        const data = await apiFetch<{ results: SearchResult[] }>(url);
        const incoming = data.results ?? [];
        if (incoming.length === 0) return;
        setResults((prev) => {
          if (isInitial || prev.length === 0) return incoming;
          const seen = new Set(prev.map((r) => r.id));
          const merged = [...prev];
          for (const r of incoming) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            merged.push(r);
          }
          return merged;
        });
      } finally {
        if (isInitial) setLoadingResults(false);
      }
    },
    [apiFetch],
  );

  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  useEffect(() => {
    if (activeJobId) {
      setResults([]);
      latestCreatedAtRef.current = null;
      loadResults(activeJobId, 'initial');
    } else {
      setResults([]);
      latestCreatedAtRef.current = null;
    }
  }, [activeJobId, loadResults]);

  // Auto-refresh active job
  useEffect(() => {
    if (!activeJobId || !activeJob) return;
    if (activeJob.status === 'running' || activeJob.status === 'pending') {
      const interval = setInterval(() => {
        refreshJobs();
        // Only append new rows; don't flicker the table.
        loadResults(activeJobId, 'incremental');
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [activeJob, activeJobId, refreshJobs, loadResults]);

  const handleStart = useCallback(async (queries: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<{ job: SearchParserJob }>('/api/parsers/search', {
        method: 'POST',
        body: JSON.stringify({ queries }),
      });
      await refreshJobs();
      setActiveJobId(data.job.id);
    } catch (err) {
      console.error(err);
      setError('Не удалось запустить парсинг');
    } finally {
      setBusy(false);
    }
  }, [apiFetch, refreshJobs]);

  const stopJob = useCallback(async (jobId: string) => {
    setJobActionId(jobId);
    setError(null);
    try {
      const { error: updateError } = await supabase
        .from('search_parser_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'Остановлено пользователем',
        })
        .eq('id', jobId);
      if (updateError) throw updateError;
      await refreshJobs();
      await loadResults(jobId);
    } catch (err) {
      console.error(err);
      setError('Не удалось остановить запуск');
    } finally {
      setJobActionId(null);
    }
  }, [loadResults, refreshJobs]);

  const runDeleteJob = useCallback(async (jobId: string) => {
    setJobActionId(jobId);
    setError(null);
    try {
      const { error: deleteError } = await supabase
        .from('search_parser_jobs')
        .delete()
        .eq('id', jobId);
      if (deleteError) throw deleteError;
      if (activeJobId === jobId) {
        setActiveJobId(null);
        setResults([]);
      }
      await refreshJobs();
    } catch (err) {
      console.error(err);
      setError('Не удалось удалить запуск');
    } finally {
      setJobActionId(null);
    }
  }, [activeJobId, refreshJobs]);

  const deleteJob = useCallback((jobId: string) => {
    setDeleteCandidateId(jobId);
  }, []);

  const confirmDeleteJob = useCallback(async () => {
    if (!deleteCandidateId) return;
    await runDeleteJob(deleteCandidateId);
    setDeleteCandidateId(null);
  }, [deleteCandidateId, runDeleteJob]);

  const cancelDeleteJob = useCallback(() => {
    setDeleteCandidateId(null);
  }, []);

  const handleExportCsv = () => {
    if (companyLeads.length === 0) return;
    const csv = buildCsv(companyLeads);
    downloadBlob(csv, 'text/csv;charset=utf-8', getExportFilename('csv'));
  };

  const handleExportExcel = () => {
    if (companyLeads.length === 0) return;
    const html = buildExcelHtml(companyLeads);
    downloadBlob(html, 'application/vnd.ms-excel;charset=utf-8', getExportFilename('xls'));
  };

  const handleCopy = useCallback(async () => {
    if (companyLeads.length === 0) return;
    setCopying(true);
    try {
      const text = buildTsv(companyLeads);
      await writeTextToClipboard(text);
      setToast({ tone: 'success', message: `Скопировано строк: ${companyLeads.length}` });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Не удалось скопировать в буфер обмена' });
    } finally {
      setCopying(false);
    }
  }, [companyLeads]);

  const handleRepeat = useCallback(async () => {
    const queries = (activeJob?.config?.queries ?? []).map((q) => q.trim()).filter(Boolean);
    if (queries.length === 0) return;
    await handleStart(queries);
  }, [activeJob, handleStart]);

  const jobQueries = useMemo(() => {
    return (activeJob?.config?.queries ?? []).map((q) => q.trim()).filter(Boolean);
  }, [activeJob]);
  const hasQueries = jobQueries.length > 0;
  const processedQueries = activeJob?.processed_queries ?? 0;
  const totalQueries = activeJob?.total_queries ?? jobQueries.length;
  const totalCompanies = companyLeads.length;
  const jobControlsDisabled = !activeJobId || jobActionId === activeJobId || busy;
  const exportDisabled = companyLeads.length === 0;
  const copyDisabled = exportDisabled || copying;
  const showStop = activeJob?.status === 'running' || activeJob?.status === 'pending';
  const activeJobStoppedByUser = activeJob ? isStoppedByUser(activeJob.status, activeJob.error_message) : false;
  const isJobLoading = Boolean(activeJob && showStop);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.href ? 9000 : 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const addToDatabase = useCallback(() => {
    try {
      if (companyLeads.length === 0) {
        setToast({ tone: 'error', message: 'Нет компаний для добавления' });
        return;
      }

      const MAX_ROWS = 5000;
      const rows = [
        ['Company', 'Site', 'Email', 'Description'],
        ...companyLeads.slice(0, MAX_ROWS).map((r) => [
          r.company_name ?? '',
          r.site ?? '',
          r.email ?? '',
          r.description ?? '',
        ]),
      ];

      const title = `Поиск ${activeJobId ? `#${activeJobId.slice(0, 8)}` : ''}`.trim() || 'Поиск';
      const { id } = writePendingDbImport({ title, rows });
      const url = buildDatabasesImportUrl(id);
      setToast({ tone: 'success', message: 'Добавлено в “Базы”. Можете перейти и проверить импорт.', href: url });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка добавления в базу' });
    }
  }, [activeJobId, companyLeads]);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0">{toast.message}</div>
            {toast.href ? (
              <a
                href={toast.href}
                className="shrink-0 inline-flex items-center rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-900 shadow-sm hover:bg-emerald-50"
              >
                Перейти
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <SearchParserForm onStart={handleStart} busy={busy} />

      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
        {/* Jobs List */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">История ({jobs.length})</h3>
            <button onClick={refreshJobs} className="text-gray-500 hover:text-gray-700">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
            {jobs.map(job => (
              <button
                key={job.id}
                onClick={() => setActiveJobId(job.id)}
                className={`w-full text-left px-6 py-4 hover:bg-gray-50 transition-colors ${activeJobId === job.id ? 'bg-blue-50' : ''}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <JobStatus status={job.status} errorMessage={job.error_message} />
                  <span className="text-xs text-gray-400">{formatDate(job.created_at)}</span>
                </div>
                <div className="text-sm font-medium text-gray-900 truncate">
                  {job.config.queries?.[0] || 'Без запросов'}
                  {job.config.queries?.length > 1 && ` (+${job.config.queries.length - 1})`}
                </div>
                <div className="mt-2 text-xs text-gray-500 flex justify-between gap-3">
                  <span>Запросов: {job.processed_queries}/{job.total_queries}</span>
                  <span>Компаний: {job.total_results}</span>
                </div>
              </button>
            ))}
            {jobs.length === 0 && (
               <div className="px-6 py-8 text-center text-gray-400 text-sm">Нет истории</div>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 sm:px-6 py-4 border-b border-gray-200">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900">Результаты</h3>
                    {activeJob ? <JobStatus status={activeJob.status} errorMessage={activeJob.error_message} /> : null}
                  </div>
                </div>
                <p className="text-sm text-gray-500">
                  {activeJob ? (
                    <>
                      Компаний: {totalCompanies} · Запросов обработано: {processedQueries}/{totalQueries}
                    </>
                  ) : (
                    `${totalCompanies} компаний`
                  )}
                </p>
              </div>

              <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap">
                <button
                  type="button"
                  onClick={addToDatabase}
                  disabled={companyLeads.length === 0}
                  className="inline-flex w-full flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
                  title="Добавит результаты в “Базы” (без открытия новой вкладки)"
                >
                  <Database className="h-4 w-4" />
                  В базу
                </button>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={exportDisabled}
                  className="inline-flex w-full flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
                >
                  <Download className="h-4 w-4" />
                  CSV
                </button>
                <button
                  type="button"
                  onClick={handleExportExcel}
                  disabled={exportDisabled}
                  className="inline-flex w-full flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Excel
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  disabled={copyDisabled}
                  className="inline-flex w-full flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-gray-50 px-2.5 py-2 text-xs font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50 sm:w-auto sm:bg-transparent sm:px-3 sm:py-2 sm:text-sm sm:text-gray-700"
                  title="Копировать компании в буфер (TSV для вставки в таблицы)"
                >
                  {copying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                  {copying ? 'Копирование…' : 'Копировать'}
                </button>

                {activeJob ? (
                  <>
                    <div className="hidden sm:block h-6 w-px bg-gray-200 mx-1" aria-hidden="true" />
                    {showStop ? (
                      <button
                        type="button"
                        onClick={() => (activeJob?.id ? stopJob(activeJob.id) : undefined)}
                        disabled={jobControlsDisabled}
                        title="Остановить"
                        aria-label="Остановить"
                        className="inline-flex h-9 w-full items-center justify-center rounded-lg border border-amber-200 bg-amber-50 px-2 text-amber-900 hover:bg-amber-100 hover:shadow-sm disabled:opacity-50 sm:w-9"
                      >
                        {jobActionId === activeJobId ? <Loader2 className="h-4 w-4 animate-spin" /> : <CirclePause className="h-4 w-4" />}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => (activeJob?.id ? deleteJob(activeJob.id) : undefined)}
                      disabled={jobControlsDisabled}
                      title="Удалить"
                      aria-label="Удалить"
                      className="inline-flex h-9 w-full items-center justify-center rounded-lg border border-red-200 bg-red-50 px-2 text-red-800 hover:bg-red-100 disabled:opacity-50 sm:w-9"
                    >
                      {jobActionId === activeJobId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          {activeJob ? (
            <div className="px-6 py-3 border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-medium text-gray-700">Запросы поиска</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleRepeat}
                    disabled={!hasQueries || busy}
                    className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                  >
                    Повторить
                  </button>
                </div>
              </div>
              <div className={`mt-2 flex flex-wrap gap-2 ${hasQueries ? '' : 'text-gray-500'}`}>
                {hasQueries ? (
                  jobQueries.map((query, index) => (
                    <span
                      key={`${query}-${index}`}
                      className="max-w-[280px] truncate rounded-full border border-gray-200 bg-white px-2 py-0.5 text-gray-700"
                      title={query}
                    >
                      {query}
                    </span>
                  ))
                ) : (
                  <span>Запросы не указаны</span>
                )}
              </div>
            </div>
          ) : null}

          {activeJob?.error_message ? (
            <div
              className={`px-6 py-3 border-b text-sm ${
                activeJobStoppedByUser
                  ? 'border-amber-200 bg-amber-50 text-amber-900'
                  : activeJob.status === 'failed'
                    ? 'border-red-100 bg-red-50 text-red-700'
                    : 'border-amber-100 bg-amber-50 text-amber-800'
              }`}
            >
              {activeJobStoppedByUser ? <span>Остановлено</span> : null}
              {!activeJobStoppedByUser && activeJob.status === 'failed' ? <span>{activeJob.error_message}</span> : null}
              {!activeJobStoppedByUser && activeJob.status !== 'failed' ? (
                <span>{activeJob.error_message}</span>
              ) : null}
            </div>
          ) : null}

          {activeJobId ? (
             <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                   <thead className={activeJobStoppedByUser ? 'bg-amber-50' : 'bg-gray-50'}>
                      <tr>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Компания</th>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Сайт</th>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Описание</th>
                      </tr>
                   </thead>
                   <tbody className={`divide-y divide-gray-100 ${activeJobStoppedByUser ? 'bg-amber-50/20' : 'bg-white'}`}>
                      {loadingResults ? (
                         <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">Загрузка...</td></tr>
                      ) : companyLeads.length === 0 ? (
                         isJobLoading ? (
                           <tr>
                             <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                               <div className="inline-flex items-center gap-2">
                                 <Loader2 className="h-4 w-4 animate-spin" />
                                 <span>Загрузка...</span>
                               </div>
                             </td>
                           </tr>
                         ) : (
                           <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">Нет компаний</td></tr>
                         )
                      ) : (
                         companyLeads.map((r) => (
                            <tr key={`${r.site ?? r.id}`} className={activeJobStoppedByUser ? 'hover:bg-amber-50' : 'hover:bg-gray-50'}>
                               <td className="px-4 py-3">
                                  <a
                                    href={r.site ?? undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm font-medium text-blue-600 hover:underline block"
                                    title={(r.queries ?? []).join(' · ')}
                                  >
                                     {r.company_name ?? '—'}
                                  </a>
                                  {r.queries.length ? (
                                    <div className="mt-1 text-[11px] text-gray-500 line-clamp-1" title={r.queries.join(' · ')}>
                                      Найдено по: {r.queries.join(' · ')}
                                    </div>
                                  ) : null}
                               </td>
                               <td className="px-4 py-3">
                                 <div className="flex items-center gap-2 max-w-[320px]">
                                   <span className="text-xs text-green-700 truncate" title={r.site ?? ''}>
                                     {r.site ?? '—'}
                                   </span>
                                   {r.site ? (
                                     <a
                                       href={r.site}
                                       target="_blank"
                                       rel="noopener noreferrer"
                                       className="inline-flex items-center rounded-md border border-gray-200 bg-white p-1.5 text-gray-600 hover:bg-gray-50 hover:text-gray-800"
                                       title="Открыть сайт"
                                     >
                                       <ExternalLink className="h-3.5 w-3.5" />
                                     </a>
                                   ) : null}
                                 </div>
                               </td>
                               <td className="px-4 py-3 text-xs text-gray-700 max-w-[220px] truncate" title={r.email ?? ''}>
                                 {r.email ?? '—'}
                               </td>
                               <td className="px-4 py-3 text-xs text-gray-600 min-w-[320px]">
                                 <div className="line-clamp-2" title={r.description ?? ''}>
                                   {r.description ?? '—'}
                                 </div>
                               </td>
                            </tr>
                         ))
                      )}
                   </tbody>
                </table>
             </div>
          ) : (
             <div className="px-6 py-12 text-center text-gray-500">
                Выберите запуск слева или создайте новый
             </div>
          )}
        </div>
      </div>

      {deleteCandidateId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-gray-900">Удалить запуск?</h3>
              <p className="mt-2 text-sm text-gray-600">
                Будут удалены запуск и все результаты поиска. Действие необратимо.
              </p>
              {activeJob?.id === deleteCandidateId ? (
                <div className="mt-3 text-xs text-gray-500">
                  Запросы: {hasQueries ? jobQueries.join(' · ') : '—'}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={cancelDeleteJob}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={confirmDeleteJob}
                disabled={jobActionId === deleteCandidateId}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
