'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import type { AtsCompanyRow, AtsParserJob, AtsSearchConfig } from '@/types';
import { AtsParserForm } from '@/components/parsers/AtsParserForm';
import { AtsCompanyResults } from '@/components/parsers/AtsCompanyResults';
import { JobsList } from '@/components/parsers/JobsList';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';

type JobsResponse = { jobs: AtsParserJob[] };
type CreateJobResponse = { job: AtsParserJob };
type ResultsResponse = { items: AtsCompanyRow[]; count: number; limit: number; offset: number };

const RESULTS_LIMIT = 50;
const EXPORT_LIMIT = 1000;
const MAX_DB_ROWS = 5000;

const EXPORT_HEADER = [
  'company', 'domain', 'ats', 'country', 'roles_found',
  'job_count', 'cities', 'job_titles', 'careers_url', 'latest_posted_at',
];

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text || `Request failed: ${res.status}`;
    try {
      const data = JSON.parse(text) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* keep raw text */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function exportRow(c: AtsCompanyRow): string[] {
  return [
    c.company,
    c.domain ?? '',
    c.ats,
    c.country ?? '',
    (c.roles_found ?? []).join('; '),
    String(c.job_count ?? 0),
    (c.cities ?? []).join('; '),
    (c.job_titles ?? []).join('; '),
    c.careers_url ?? '',
    c.latest_posted_at ?? '',
  ];
}

function csvCell(v: unknown) {
  const t = String(v ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ');
  return `"${t.replaceAll('"', '""')}"`;
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

export function AtsParserView() {
  const [jobs, setJobs] = useState<AtsParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);

  const [results, setResults] = useState<AtsCompanyRow[]>([]);
  const [resultsCount, setResultsCount] = useState(0);
  const [resultsPage, setResultsPage] = useState(1);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [activeJobId, jobs]);
  const totalPages = Math.max(1, Math.ceil(resultsCount / RESULTS_LIMIT));

  const refreshJobs = useCallback(async () => {
    const data = await apiFetch<JobsResponse>('/api/parsers/ats', { method: 'GET' });
    setJobs(data.jobs ?? []);
    setActiveJobId((prev) => prev ?? data.jobs?.[0]?.id ?? null);
  }, []);

  const loadResults = useCallback(async (jobId: string, page: number) => {
    setResultsLoading(true);
    try {
      const offset = Math.max(0, (page - 1) * RESULTS_LIMIT);
      const data = await apiFetch<ResultsResponse>(
        `/api/parsers/ats/${jobId}/results?limit=${RESULTS_LIMIT}&offset=${offset}`,
        { method: 'GET' },
      );
      setResultsCount(data.count ?? 0);
      setResults(data.items ?? []);
    } finally {
      setResultsLoading(false);
    }
  }, []);

  const fetchAllResults = useCallback(async (jobId: string) => {
    const all: AtsCompanyRow[] = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const data = await apiFetch<ResultsResponse>(
        `/api/parsers/ats/${jobId}/results?limit=${EXPORT_LIMIT}&offset=${offset}`,
        { method: 'GET' },
      );
      if (offset === 0) total = data.count ?? 0;
      const chunk = data.items ?? [];
      all.push(...chunk);
      if (chunk.length === 0) break;
      offset += chunk.length;
      setExportProgress(`Загрузка: ${Math.min(offset, total)} / ${total}`);
    }
    return all;
  }, []);

  // Initial load
  useEffect(() => {
    void (async () => {
      try {
        setError(null);
        await refreshJobs();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки');
      }
    })();
  }, [refreshJobs]);

  // Session id for realtime
  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSessionUserId(data.session?.user?.id ?? null);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Realtime: only react to our ATS jobs
  useEffect(() => {
    if (!sessionUserId) return;
    const channel = supabase
      .channel(`ats_parser_jobs_${sessionUserId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'parser_jobs', filter: `user_id=eq.${sessionUserId}` },
        (payload) => {
          const p = payload as unknown as { eventType?: string; type?: string; new?: AtsParserJob; old?: { id?: string } };
          const eventType = p.eventType ?? p.type;
          if (eventType === 'DELETE') {
            if (p.old?.id) setJobs((prev) => prev.filter((j) => j.id !== p.old!.id));
            return;
          }
          const next = p.new;
          if (!next?.id || next.parser_type !== 'ats_companies') return;
          setJobs((prev) => {
            const idx = prev.findIndex((j) => j.id === next.id);
            if (idx === -1) return [next, ...prev].sort((a, b) => b.created_at.localeCompare(a.created_at));
            const copy = [...prev];
            copy[idx] = { ...prev[idx], ...next };
            return copy;
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionUserId]);

  // Load results when active job changes
  useEffect(() => {
    if (!activeJobId) return;
    setResultsPage(1);
    void loadResults(activeJobId, 1);
  }, [activeJobId, loadResults]);

  // Poll while pending OR running. Realtime can be unreliable on the self-hosted
  // Supabase, so polling is what moves the UI off "В очереди" once the worker
  // claims the job (status pending -> running) and as it progresses.
  useEffect(() => {
    if (!activeJobId) return;
    const st = activeJob?.status;
    if (st !== 'running' && st !== 'pending') return;
    const id = window.setInterval(() => {
      void refreshJobs();
      void loadResults(activeJobId, resultsPage);
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeJobId, activeJob?.status, refreshJobs, loadResults, resultsPage]);

  // Refresh results on completion / failure
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') {
      void loadResults(activeJob.id, resultsPage);
    }
    if (activeJob.status === 'failed' && activeJob.error_message) setError(activeJob.error_message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeJob?.status]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handlePageChange = useCallback(
    (page: number) => {
      if (!activeJobId) return;
      const next = Math.min(Math.max(page, 1), totalPages);
      setResultsPage(next);
      void loadResults(activeJobId, next);
    },
    [activeJobId, loadResults, totalPages],
  );

  const start = useCallback(
    async (config: AtsSearchConfig) => {
      setBusy(true);
      setError(null);
      try {
        const created = await apiFetch<CreateJobResponse>('/api/parsers/ats', {
          method: 'POST',
          body: JSON.stringify(config),
        });
        setActiveJobId(created.job.id);
        await refreshJobs();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка запуска');
      } finally {
        setBusy(false);
      }
    },
    [refreshJobs],
  );

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshJobs();
      if (activeJobId) await loadResults(activeJobId, resultsPage);
    } finally {
      setRefreshing(false);
    }
  }, [refreshJobs, loadResults, activeJobId, resultsPage]);

  const resolveExportItems = useCallback(async () => {
    if (!activeJobId) return results;
    if (resultsCount > 0 && results.length >= resultsCount) return results;
    return fetchAllResults(activeJobId);
  }, [activeJobId, fetchAllResults, results, resultsCount]);

  const exportCsv = useCallback(async () => {
    setActionsBusy(true);
    setExportProgress('CSV: подготовка');
    try {
      const items = await resolveExportItems();
      if (!items.length) {
        setToast({ tone: 'error', message: 'Нет данных для экспорта' });
        return;
      }
      const lines = [EXPORT_HEADER.join(',')];
      for (const it of items) lines.push(exportRow(it).map(csvCell).join(','));
      downloadBlob('﻿' + lines.join('\n'), 'text/csv;charset=utf-8', `ats_companies_${activeJobId ?? 'job'}.csv`);
      setToast({ tone: 'success', message: `CSV: ${items.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [resolveExportItems, activeJobId]);

  const copyResults = useCallback(async () => {
    setActionsBusy(true);
    setExportProgress('Копирование');
    try {
      const items = await resolveExportItems();
      if (!items.length) return;
      const lines = [EXPORT_HEADER.join('\t')];
      for (const it of items) lines.push(exportRow(it).join('\t'));
      await navigator.clipboard.writeText(lines.join('\n'));
      setToast({ tone: 'success', message: `Скопировано: ${items.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка копирования');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [resolveExportItems]);

  const addToDatabase = useCallback(async () => {
    if (!activeJobId) return;
    setActionsBusy(true);
    setExportProgress('Базы: подготовка');
    try {
      const items = await resolveExportItems();
      if (!items.length) {
        setToast({ tone: 'error', message: 'Нет результатов' });
        return;
      }
      const rows: string[][] = [
        ['Company', 'Site', 'CareersUrl', 'Roles', 'Vacancies', 'JobId', 'Parser'],
        ...items.slice(0, MAX_DB_ROWS).map((c) => [
          c.company,
          c.domain ?? '',
          c.careers_url ?? '',
          (c.roles_found ?? []).join('; '),
          String(c.job_count ?? 0),
          activeJobId,
          'ats',
        ]),
      ];
      const { id } = writePendingDbImport({ title: `ATS #${activeJobId.slice(0, 8)}`, rows });
      const url = buildDatabasesImportUrl(id);
      const trimmed = items.length > MAX_DB_ROWS;
      setToast({
        tone: 'success',
        message: trimmed
          ? `Добавлено в «Базы» (${MAX_DB_ROWS} из ${items.length})`
          : `Добавлено в «Базы» (${items.length} компаний)`,
        href: url,
      });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка' });
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [activeJobId, resolveExportItems]);

  const stopJob = useCallback(async () => {
    if (!activeJobId) return;
    try {
      await apiFetch(`/api/parsers/ats/${activeJobId}`, { method: 'PATCH', body: JSON.stringify({ action: 'stop' }) });
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка остановки');
    }
  }, [activeJobId, refreshJobs]);

  const confirmDelete = useCallback(async () => {
    if (!deleteCandidate) return;
    try {
      await apiFetch(`/api/parsers/ats/${deleteCandidate}`, { method: 'DELETE' });
      if (activeJobId === deleteCandidate) {
        setActiveJobId(null);
        setResults([]);
        setResultsCount(0);
      }
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления');
    } finally {
      setDeleteCandidate(null);
    }
  }, [deleteCandidate, activeJobId, refreshJobs]);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}
      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
          role="status"
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0">{toast.message}</div>
            {toast.href ? (
              <a
                href={toast.href}
                className="shrink-0 inline-flex items-center rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-900 hover:bg-emerald-50"
              >
                Перейти
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <AtsParserForm onStart={start} busy={busy} />

      <div className="grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
        <JobsList
          jobs={jobs}
          activeJobId={activeJobId}
          activeJobParsedCount={resultsCount}
          onSelect={(id) => setActiveJobId(id)}
          onRefresh={() => void manualRefresh()}
          busy={busy}
          refreshing={refreshing}
        />

        <AtsCompanyResults
          items={results}
          count={resultsCount}
          loading={resultsLoading}
          jobStatus={activeJob?.status ?? null}
          currentPage={resultsPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          actionsBusy={actionsBusy}
          exportProgress={exportProgress}
          onExportCsv={() => void exportCsv()}
          onCopy={() => void copyResults()}
          onAddToDatabase={() => void addToDatabase()}
          onStopJob={activeJob?.id ? () => void stopJob() : undefined}
          onDeleteJob={activeJob?.id ? () => setDeleteCandidate(activeJob.id) : undefined}
        />
      </div>

      {deleteCandidate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-gray-900">Удалить запуск?</h3>
              <p className="mt-2 text-sm text-gray-600">Будут удалены job и все результаты. Действие необратимо.</p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setDeleteCandidate(null)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
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
