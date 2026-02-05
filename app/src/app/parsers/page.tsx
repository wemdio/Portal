'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { HHSearchConfig, HHVacancyRow, ParserJob } from '@/types';
import { HHParserForm } from '@/components/parsers/HHParserForm';
import { JobsList } from '@/components/parsers/JobsList';
import { VacancyResults } from '@/components/parsers/VacancyResults';

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

async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
    const data = safeJsonParse<{ error?: string; captcha_url?: string; request_id?: string }>(text);
    const message = data?.error ? String(data.error) : (text || `Request failed: ${res.status}`);
    throw new ApiError(message, res.status, {
      captchaUrl: data?.captcha_url,
      requestId: data?.request_id,
    });
  }

  return (await res.json()) as T;
}

const exportLimit = 200;

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

export default function ParsersPage() {
  const [jobs, setJobs] = useState<ParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  const [results, setResults] = useState<HHVacancyRow[]>([]);
  const [resultsCount, setResultsCount] = useState(0);
  const [resultsOffset, setResultsOffset] = useState(0);
  const resultsLimit = 50;
  const [resultsPage, setResultsPage] = useState(1);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [activeJobId, jobs]);

  const refreshSeq = useRef(0);

  const refreshJobs = useCallback(async () => {
    const seq = ++refreshSeq.current;
    setRefreshing(true);
    try {
      const data = await apiFetch<JobsResponse>('/api/parsers/hh', { method: 'GET' });
      setJobs(data.jobs ?? []);
      if (!activeJobId && data.jobs?.[0]?.id) setActiveJobId(data.jobs[0].id);
    } finally {
      if (refreshSeq.current === seq) setRefreshing(false);
    }
  }, [activeJobId]);

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
    }

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
    }, 5000);
    return () => clearInterval(interval);
  }, [activeJobId, activeJob?.status, refreshJobs]);

  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed') {
      const offset = Math.max(0, (resultsPage - 1) * resultsLimit);
      void loadResults(activeJob.id, offset, false);
      return;
    }
    if (activeJob.status === 'failed' && activeJob.error_message) {
      setError({ message: activeJob.error_message });
    }
  }, [activeJob, loadResults, resultsLimit, resultsPage]);

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

  const deleteJob = useCallback(async (jobId: string) => {
    if (!confirm('Удалить job и все результаты?')) return;
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

  const exportCsv = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const items = await resolveExportItems();
      if (items.length === 0) return;
      const csv = buildCsv(items);
      downloadBlob(csv, 'text/csv;charset=utf-8', `hh_results_${activeJobId ?? 'job'}.csv`);
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
      if (items.length === 0) return;
      const html = buildExcelHtml(items);
      downloadBlob(html, 'application/vnd.ms-excel;charset=utf-8', `hh_results_${activeJobId ?? 'job'}.xls`);
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
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API недоступен');
      }
      await navigator.clipboard.writeText(buildTsv(items));
    } catch (e: unknown) {
      setError(toUiError(e, 'Ошибка копирования результатов'));
    } finally {
      setCopying(false);
    }
  }, [resolveExportItems]);

  const actionsBusy = exporting || copying;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Парсеры</h1>
        <p className="text-sm text-gray-500 mt-1">Запуск и результаты парсинга</p>
      </div>

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

      <HHParserForm onStart={start} busy={busy} />

      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
        <JobsList
          jobs={jobs}
          activeJobId={activeJobId}
          onSelect={(id) => setActiveJobId(id)}
          onRefresh={() => void refreshJobs()}
          busy={busy || refreshing}
        />

        <VacancyResults
          items={results}
          count={resultsCount}
          limit={resultsLimit}
          offset={resultsOffset}
          loading={resultsLoading}
          actionsBusy={actionsBusy}
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
          onStopJob={activeJob?.id ? () => stopJob(activeJob.id) : undefined}
          onDeleteJob={activeJob?.id ? () => deleteJob(activeJob.id) : undefined}
        />
      </div>

      {activeJob?.status === 'running' ? (
        <div className="text-sm text-gray-500">
          Job в статусе running — обновите список jobs или подождите завершения.
        </div>
      ) : null}
    </div>
  );
}

