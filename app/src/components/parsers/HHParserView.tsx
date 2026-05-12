
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import type { HHSearchConfig, HHVacancyRow, ParserJob } from '@/types';
import { HHParserForm } from '@/components/parsers/HHParserForm';
import { JobsList } from '@/components/parsers/JobsList';
import { VacancyResults } from '@/components/parsers/VacancyResults';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';
import { ClientTariffUsageInline } from '@/components/client/ClientTariffUsageInline';

type JobsResponse = { jobs: ParserJob[] };
type CreateJobResponse = { job: ParserJob };
type ExecuteResponse = { status: string; found?: number; parsed?: number; job_id?: string };
type ResultsResponse = { items: HHVacancyRow[]; count: number; limit: number; offset: number };
type UiError = { message: string; captchaUrl?: string; requestId?: string };

class ApiError extends Error {
  status: number;
  captchaUrl?: string;
  requestId?: string;

  constructor(message: string, status: number, options?: { captchaUrl?: string; requestId?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.captchaUrl = options?.captchaUrl;
    this.requestId = options?.requestId;
  }
}

const exportHeader = [
  'vacancy_id',
  'name',
  'url',
  'company_name',
  'company_url',
  'company_site_url',
  'company_description',
  'area',
  'salary_from',
  'salary_to',
  'salary_currency',
  'published_at',
];

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const data = safeJsonParse<{ error?: string; captcha_url?: string; request_id?: string }>(text);
    const message = data?.error ? String(data.error) : (text || `Request failed: ${res.status}`);
    throw new ApiError(message, res.status, {
      captchaUrl: data?.captcha_url,
      requestId: data?.request_id,
    });
  }

  return (await res.json()) as T;
}

const exportLimit = 1000;

function exportRow(v: HHVacancyRow) {
  return [
    v.vacancy_id,
    v.name,
    v.url,
    v.company_name,
    v.company_url ?? '',
    v.company_site_url ?? '',
    v.company_description ?? '',
    v.area,
    v.salary_from ?? '',
    v.salary_to ?? '',
    v.salary_currency ?? '',
    v.published_at ?? '',
  ];
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
    .replaceAll('\t', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
  return `"${text.replaceAll('"', '""')}"`;
}

function tsvCell(value: unknown) {
  return String(value ?? '')
    .replaceAll('\t', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
}

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

function buildCsv(items: HHVacancyRow[]) {
  const lines = [exportHeader.join(',')];
  for (const item of items) {
    const row = exportRow(item).map(csvCell);
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function buildTsv(items: HHVacancyRow[]) {
  const lines = [exportHeader.map(tsvCell).join('\t')];
  for (const item of items) {
    const row = exportRow(item).map(tsvCell);
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

function buildExcelHtml(items: HHVacancyRow[]) {
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

function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toUiError(error: unknown, fallback: string): UiError {
  if (error instanceof ApiError) {
    return {
      message: error.message || fallback,
      captchaUrl: error.captchaUrl,
      requestId: error.requestId,
    };
  }
  if (error instanceof Error) return { message: error.message || fallback };
  return { message: fallback };
}

function safeHostname(url: string | null | undefined) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  try {
    return new URL(s).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function extractHhEmployerKey(url: string | null | undefined): string | null {
  const s = String(url ?? '').trim();
  if (!s) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'hh.ru') return null;
    const match = parsed.pathname.match(/\/employer\/(\d+)/);
    if (!match) return null;
    return `hh:${match[1]}`;
  } catch {
    return null;
  }
}

type HHParserViewProps = {
  /** Hides staff-only features like "Add to Database" (uses /tools/databases) */
  clientMode?: boolean;
};

export function HHParserView({ clientMode }: HHParserViewProps = {}) {
  const [jobs, setJobs] = useState<ParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);

  const [results, setResults] = useState<HHVacancyRow[]>([]);
  const [resultsCount, setResultsCount] = useState(0);
  const [resultsOffset, setResultsOffset] = useState(0);
  const resultsLimit = 50;
  const [resultsPage, setResultsPage] = useState(1);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [addingToDb, setAddingToDb] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [activeJobId, jobs]);

  const refreshSeq = useRef(0);

  const refreshJobs = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const data = await apiFetch<JobsResponse>('/api/parsers/hh', { method: 'GET' });
    if (refreshSeq.current !== seq) return;
    setJobs(data.jobs ?? []);
    if (!activeJobId && data.jobs?.[0]?.id) setActiveJobId(data.jobs[0].id);
  }, [activeJobId]);

  const handleManualRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await refreshJobs();
    } finally {
      setManualRefreshing(false);
    }
  }, [refreshJobs]);

  useEffect(() => {
    if (!activeJobId) return undefined;
    if (!activeJob || (activeJob.status !== 'running' && activeJob.status !== 'pending')) return undefined;
    const intervalId = window.setInterval(() => {
      void refreshJobs();
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [activeJob, activeJobId, refreshJobs]);

  const loadResults = useCallback(async (jobId: string, offset: number, append: boolean) => {
    setResultsLoading(true);
    try {
      const data = await apiFetch<ResultsResponse>(`/api/parsers/hh/${jobId}/results?limit=${resultsLimit}&offset=${offset}`, {
        method: 'GET',
      });
      setResultsCount(data.count ?? 0);
      setResultsOffset(data.offset ?? offset);
      setResults((prev) => (append ? [...prev, ...(data.items ?? [])] : (data.items ?? [])));
    } finally {
      setResultsLoading(false);
    }
  }, []);

  const fetchAllResults = useCallback(async (jobId: string) => {
    const all: HHVacancyRow[] = [];
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const data = await apiFetch<ResultsResponse>(`/api/parsers/hh/${jobId}/results?limit=${exportLimit}&offset=${offset}`, {
        method: 'GET',
      });
      if (offset === 0) total = data.count ?? 0;
      const chunk = data.items ?? [];
      all.push(...chunk);
      if (chunk.length === 0) break;
      offset += chunk.length;
      if (total > 0) {
        setExportProgress(`${Math.min(offset, total)} / ${total}`);
      }
    }

    setExportProgress(null);
    return all;
  }, []);

  const resolveExportItems = useCallback(async () => {
    if (!activeJobId) return results;
    if (resultsCount > 0 && results.length >= resultsCount) return results;
    return fetchAllResults(activeJobId);
  }, [activeJobId, fetchAllResults, results, resultsCount]);

  useEffect(() => {
    void (async () => {
      try {
        setError(null);
        await refreshJobs();
      } catch (e: unknown) {
        setError(toUiError(e, 'Ошибка загрузки jobs'));
      }
    })();
  }, [refreshJobs]);

  useEffect(() => {
    let isMounted = true;
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!isMounted) return;
      setSessionUserId(session?.user?.id ?? null);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionUserId) return;
    const channel = supabase
      .channel(`parser_jobs_${sessionUserId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'parser_jobs', filter: `user_id=eq.${sessionUserId}` },
        (payload) => {
          const payloadAny = payload as unknown as {
            eventType?: string;
            type?: string;
            new?: ParserJob;
            old?: { id?: string };
          };
          const eventType = payloadAny.eventType ?? payloadAny.type;
          if (eventType === 'DELETE') {
            const oldRow = payloadAny.old;
            if (!oldRow?.id) return;
            setJobs((prev) => prev.filter((job) => job.id !== oldRow.id));
            return;
          }
          const nextJob = payloadAny.new;
          if (!nextJob?.id) return;
          setJobs((prev) => {
            const existingIndex = prev.findIndex((job) => job.id === nextJob.id);
            if (existingIndex === -1) {
              return [nextJob, ...prev].sort((a, b) => b.created_at.localeCompare(a.created_at));
            }
            const next = [...prev];
            next[existingIndex] = { ...prev[existingIndex], ...nextJob };
            return next.sort((a, b) => b.created_at.localeCompare(a.created_at));
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionUserId]);

  useEffect(() => {
    if (!activeJobId) return;
    setResultsPage(1);
    setResults([]);
    setResultsCount(0);
    setResultsOffset(0);
    void loadResults(activeJobId, 0, false);
  }, [activeJobId, loadResults]);

  useEffect(() => {
    if (!activeJobId) return;
    if (activeJob?.status !== 'running') return;
    const interval = setInterval(() => {
      void refreshJobs();
      const offset = Math.max(0, (resultsPage - 1) * resultsLimit);
      void loadResults(activeJobId, offset, false);
    }, 5000);
    return () => clearInterval(interval);
  }, [activeJobId, activeJob?.status, refreshJobs, loadResults, resultsPage, resultsLimit]);

  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') {
      const offset = Math.max(0, (resultsPage - 1) * resultsLimit);
      void loadResults(activeJob.id, offset, false);
    }
    if (activeJob.status === 'failed' && activeJob.error_message) {
      setError({ message: activeJob.error_message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeJob?.status, loadResults, resultsLimit, resultsPage]);

  const totalPages = Math.max(1, Math.ceil(resultsCount / resultsLimit));

  useEffect(() => {
    if (!activeJobId) return;
    if (resultsPage <= totalPages) return;
    const nextPage = totalPages;
    setResultsPage(nextPage);
    const offset = Math.max(0, (nextPage - 1) * resultsLimit);
    void loadResults(activeJobId, offset, false);
  }, [activeJobId, loadResults, resultsLimit, resultsPage, totalPages]);

  const handlePageChange = useCallback((page: number) => {
    if (!activeJobId) return;
    const nextPage = Math.min(Math.max(page, 1), totalPages);
    if (nextPage === resultsPage) return;
    setResultsPage(nextPage);
    const offset = Math.max(0, (nextPage - 1) * resultsLimit);
    void loadResults(activeJobId, offset, false);
  }, [activeJobId, loadResults, resultsLimit, resultsPage, totalPages]);

  const start = useCallback(async (config: HHSearchConfig) => {
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<CreateJobResponse>('/api/parsers/hh', {
        method: 'POST',
        body: JSON.stringify(config),
      });

      const jobId = created.job.id;
      setActiveJobId(jobId);

      void apiFetch<ExecuteResponse>('/api/parsers/hh/execute', {
        method: 'POST',
        body: JSON.stringify({ job_id: jobId }),
      })
        .then(() => refreshJobs())
        .catch((e: unknown) => {
          setError(toUiError(e, 'Ошибка запуска парсинга'));
          void refreshJobs().catch(() => undefined);
        });

      await refreshJobs();
      void loadResults(jobId, 0, false);
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка запуска парсинга'));
      await refreshJobs().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [loadResults, refreshJobs]);

  const stopJob = useCallback(async (jobId: string) => {
    setJobActionId(jobId);
    setError(null);
    try {
      await apiFetch(`/api/parsers/hh/${jobId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'stop' }),
      });
      await refreshJobs();
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка остановки job'));
    } finally {
      setJobActionId(null);
    }
  }, [refreshJobs]);

  const runDeleteJob = useCallback(async (jobId: string) => {
    setJobActionId(jobId);
    setError(null);
    try {
      await apiFetch(`/api/parsers/hh/${jobId}`, { method: 'DELETE' });
      if (activeJobId === jobId) {
        setActiveJobId(null);
        setResults([]);
        setResultsCount(0);
        setResultsOffset(0);
      }
      await refreshJobs();
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка удаления job'));
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

  const exportCsv = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const items = await resolveExportItems();
      if (items.length === 0) {
        setToast({ tone: 'error', message: 'Нет данных для экспорта' });
        return;
      }
      const csv = '\uFEFF' + buildCsv(items);
      downloadBlob(csv, 'text/csv;charset=utf-8', `hh_results_${activeJobId ?? 'job'}.csv`);
      setToast({ tone: 'success', message: `CSV: скачано ${items.length} строк` });
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка экспорта CSV'));
    } finally {
      setExporting(false);
    }
  }, [activeJobId, resolveExportItems]);

  const exportExcel = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const items = await resolveExportItems();
      if (items.length === 0) {
        setToast({ tone: 'error', message: 'Нет данных для экспорта' });
        return;
      }
      const html = buildExcelHtml(items);
      downloadBlob(html, 'application/vnd.ms-excel;charset=utf-8', `hh_results_${activeJobId ?? 'job'}.xls`);
      setToast({ tone: 'success', message: `Excel: скачано ${items.length} строк` });
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка экспорта Excel'));
    } finally {
      setExporting(false);
    }
  }, [activeJobId, resolveExportItems]);

  const copyResults = useCallback(async () => {
    setCopying(true);
    setError(null);
    try {
      const items = await resolveExportItems();
      if (items.length === 0) return;
      await writeTextToClipboard(buildTsv(items));
      setToast({ tone: 'success', message: `Скопировано строк: ${items.length}` });
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка копирования результатов'));
    } finally {
      setCopying(false);
    }
  }, [resolveExportItems]);

  const actionsBusy = exporting || copying || addingToDb;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const addCompaniesToDatabase = useCallback(async () => {
    if (!activeJobId) {
      setToast({ tone: 'error', message: 'Сначала выберите запуск' });
      return;
    }
    setAddingToDb(true);
    try {
      const items = await resolveExportItems();
      if (items.length === 0) {
        setToast({ tone: 'error', message: 'Нет результатов для добавления' });
        return;
      }

      const map = new Map<
        string,
        { company_name: string; site: string; company_url: string; description: string; vacancyCount: number }
      >();
      for (const v of items) {
        const siteHost = safeHostname(v.company_site_url);
        const hhEmployerKey = extractHhEmployerKey(v.company_url);
        const fallbackName = (v.company_name ?? '').trim().toLowerCase();

        const key = (
          siteHost && siteHost !== 'hh.ru'
            ? siteHost
            : hhEmployerKey
              ? hhEmployerKey
              : siteHost || fallbackName
        ).trim().toLowerCase();
        if (!key) continue;
        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            company_name: v.company_name ?? '',
            site: v.company_site_url ?? '',
            company_url: v.company_url ?? '',
            description: v.company_description ?? '',
            vacancyCount: 1,
          });
          continue;
        }
        existing.vacancyCount += 1;
        if (!existing.site && v.company_site_url) existing.site = v.company_site_url;
        if (!existing.company_url && v.company_url) existing.company_url = v.company_url;
        if ((!existing.description || existing.description.length < 40) && v.company_description) {
          existing.description = v.company_description;
        }
      }

      const companies = Array.from(map.values()).sort((a, b) =>
        (a.company_name || a.site).localeCompare(b.company_name || b.site, 'ru'),
      );
      if (companies.length === 0) {
        setToast({ tone: 'error', message: 'Не удалось собрать компании из результатов' });
        return;
      }

      const MAX_ROWS = 5000;
      const rows: string[][] = [
        ['Company', 'Site', 'CompanyUrl', 'Description', 'Vacancies', 'JobId', 'Parser'],
        ...companies.slice(0, MAX_ROWS).map((c) => [
          c.company_name,
          c.site,          // только внешний сайт компании (если есть)
          c.company_url,   // страница работодателя на hh.ru
          c.description,
          String(c.vacancyCount),
          activeJobId,
          'hh',
        ]),
      ];

      const title = `HH.ru #${activeJobId.slice(0, 8)}`;
      const { id } = writePendingDbImport({ title, rows });
      const url = buildDatabasesImportUrl(id);
      const trimmed = companies.length > MAX_ROWS;
      setToast({
        tone: 'success',
        message: trimmed
          ? `Добавлено в “Базы” (${MAX_ROWS} из ${companies.length} компаний). Можете перейти и проверить импорт.`
          : `Добавлено в “Базы” (${companies.length} компаний). Можете перейти и проверить импорт.`,
        href: url,
      });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка добавления в базу' });
    } finally {
      setAddingToDb(false);
    }
  }, [activeJobId, resolveExportItems]);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div>{error.message}</div>
          {error.captchaUrl ? (
            <div className="mt-2 text-xs text-red-700">
              <a
                href={error.captchaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline break-all"
              >
                Открыть капчу HH.ru
              </a>
              {error.requestId ? <span className="ml-2 break-all">request_id: {error.requestId}</span> : null}
            </div>
          ) : null}
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

      <HHParserForm onStart={start} busy={busy} />

      {clientMode && activeJob ? (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <ClientTariffUsageInline
            metric="max_rows"
            spent={Math.max(resultsCount, activeJob.total_parsed ?? 0, activeJob.total_found ?? 0)}
            refreshKey={`${activeJob.id}:${activeJob.status}:${resultsCount}`}
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
        <JobsList
          jobs={jobs}
          activeJobId={activeJobId}
          activeJobParsedCount={resultsCount}
          onSelect={(id) => setActiveJobId(id)}
          onRefresh={() => void handleManualRefresh()}
          busy={busy}
          refreshing={manualRefreshing}
        />

        <VacancyResults
          items={results}
          count={resultsCount}
          limit={resultsLimit}
          offset={resultsOffset}
          loading={resultsLoading}
          actionsBusy={actionsBusy}
          exportProgress={exportProgress}
          addToDatabaseDisabled={addingToDb}
          jobId={activeJob?.id ?? null}
          jobStatus={activeJob?.status ?? null}
          jobActionBusy={jobActionId === activeJob?.id}
          searchConfig={activeJob?.config ?? null}
          currentPage={resultsPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          onExportCsv={exportCsv}
          onExportExcel={exportExcel}
          onCopy={copyResults}
          onAddToDatabase={clientMode ? undefined : () => void addCompaniesToDatabase()}
          onStopJob={activeJob?.id ? () => stopJob(activeJob.id) : undefined}
          onDeleteJob={activeJob?.id ? () => deleteJob(activeJob.id) : undefined}
        />
      </div>

      {deleteCandidateId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-gray-900">Удалить запуск?</h3>
              <p className="mt-2 text-sm text-gray-600">
                Будут удалены job и все результаты парсинга. Действие необратимо.
              </p>
              {activeJob?.id === deleteCandidateId ? (
                <div className="mt-3 text-xs text-gray-500">
                  Запрос: {activeJob?.config?.text || '—'}
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
