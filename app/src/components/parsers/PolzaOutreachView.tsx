'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import type { PolzaOutreachCompanyRow, PolzaOutreachConfig, PolzaOutreachFunnel, PolzaOutreachParserJob } from '@/types';
import { JobsList } from '@/components/parsers/JobsList';
import { PolzaOutreachForm } from '@/components/parsers/PolzaOutreachForm';
import { PolzaOutreachResults } from '@/components/parsers/PolzaOutreachResults';

type JobsResponse = { jobs: PolzaOutreachParserJob[] };
type CreateJobResponse = { job: PolzaOutreachParserJob };
type ResultsResponse = {
  items: PolzaOutreachCompanyRow[];
  count: number;
  limit: number;
  offset: number;
  funnel?: PolzaOutreachFunnel | null;
  status_counts?: Record<string, number> | null;
  exclusion_counts?: Record<string, number> | null;
};

const RESULTS_LIMIT = 50;
const EXPORT_LIMIT = 1000;

const EXPORT_HEADER = [
  'company_name',
  'domain',
  'website',
  'job_title',
  'job_url',
  'job_country',
  'job_published_at',
  'service_line',
  'target_sales_geo',
  'target_sales_geo_confidence',
  'target_sales_geo_evidence',
  'outbound_mandate',
  'outbound_evidence',
  'email',
  'email_type',
  'status',
  'stage',
  'exclusion_reason',
  'review_reason',
  'letter_1_subject',
  'letter_1_body',
  'letter_2_subject',
  'letter_2_body',
  'letter_3_subject',
  'letter_3_body',
  'letter_4_subject',
  'letter_4_body',
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

function csvCell(value: unknown) {
  const text = String(value ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ');
  return `"${text.replaceAll('"', '""')}"`;
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

function exportRow(row: PolzaOutreachCompanyRow) {
  const letters = row.letters ?? [];
  const letter = (n: number, field: 'subject' | 'body') => letters.find((l) => l.n === n)?.[field] ?? '';
  return [
    row.company_name,
    row.normalized_domain ?? '',
    row.company_website ?? '',
    row.job_title ?? '',
    row.job_source_url ?? '',
    row.job_country_code ?? '',
    row.job_published_at ?? '',
    row.service_line ?? '',
    row.target_sales_geo ?? '',
    row.target_sales_geo_confidence ?? '',
    row.target_sales_geo_evidence ?? '',
    row.outbound_mandate ?? '',
    row.outbound_evidence ?? '',
    row.selected_company_email ?? '',
    row.email_type ?? '',
    row.status,
    row.stage ?? '',
    row.exclusion_reason ?? '',
    row.review_reason ?? '',
    letter(1, 'subject'),
    letter(1, 'body'),
    letter(2, 'subject'),
    letter(2, 'body'),
    letter(3, 'subject'),
    letter(3, 'body'),
    letter(4, 'subject'),
    letter(4, 'body'),
  ];
}

export function PolzaOutreachView() {
  const [jobs, setJobs] = useState<PolzaOutreachParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const [results, setResults] = useState<PolzaOutreachCompanyRow[]>([]);
  const [resultsCount, setResultsCount] = useState(0);
  const [funnel, setFunnel] = useState<PolzaOutreachFunnel | null>(null);
  const [exclusionCounts, setExclusionCounts] = useState<Record<string, number> | null>(null);
  const [resultsPage, setResultsPage] = useState(1);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeJobId) ?? null, [activeJobId, jobs]);
  const totalPages = Math.max(1, Math.ceil(resultsCount / RESULTS_LIMIT));

  const refreshJobs = useCallback(async () => {
    const data = await apiFetch<JobsResponse>('/api/parsers/polza-outreach', { method: 'GET' });
    setJobs(data.jobs ?? []);
    setActiveJobId((prev) => prev ?? data.jobs?.[0]?.id ?? null);
  }, []);

  const loadResults = useCallback(async (jobId: string, page: number) => {
    setResultsLoading(true);
    try {
      const offset = Math.max(0, (page - 1) * RESULTS_LIMIT);
      const data = await apiFetch<ResultsResponse>(
        `/api/parsers/polza-outreach/${jobId}/results?limit=${RESULTS_LIMIT}&offset=${offset}`,
        { method: 'GET' },
      );
      setResultsCount(data.count ?? 0);
      setResults(data.items ?? []);
      setFunnel(data.funnel ?? null);
      setExclusionCounts(data.exclusion_counts ?? null);
    } finally {
      setResultsLoading(false);
    }
  }, []);

  const fetchAllResults = useCallback(async (jobId: string) => {
    const all: PolzaOutreachCompanyRow[] = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const data = await apiFetch<ResultsResponse>(
        `/api/parsers/polza-outreach/${jobId}/results?limit=${EXPORT_LIMIT}&offset=${offset}`,
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

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSessionUserId(data.session?.user?.id ?? null);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionUserId) return;
    const channel = supabase
      .channel(`polza_outreach_parser_jobs_${sessionUserId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'parser_jobs', filter: `user_id=eq.${sessionUserId}` },
        (payload) => {
          const p = payload as unknown as { eventType?: string; type?: string; new?: PolzaOutreachParserJob; old?: { id?: string } };
          const eventType = p.eventType ?? p.type;
          if (eventType === 'DELETE') {
            if (p.old?.id) setJobs((prev) => prev.filter((job) => job.id !== p.old!.id));
            return;
          }
          const next = p.new;
          if (!next?.id || next.parser_type !== 'polza_outreach') return;
          setJobs((prev) => {
            const index = prev.findIndex((job) => job.id === next.id);
            if (index === -1) return [next, ...prev].sort((a, b) => b.created_at.localeCompare(a.created_at));
            const copy = [...prev];
            copy[index] = { ...prev[index], ...next };
            return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResultsPage(1);
    void loadResults(activeJobId, 1);
  }, [activeJobId, loadResults]);

  useEffect(() => {
    if (!activeJobId) return;
    const status = activeJob?.status;
    if (status !== 'running' && status !== 'pending') return;
    const id = window.setInterval(() => {
      void refreshJobs();
      void loadResults(activeJobId, resultsPage);
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeJobId, activeJob?.status, refreshJobs, loadResults, resultsPage]);

  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const start = useCallback(
    async (config: PolzaOutreachConfig) => {
      setBusy(true);
      setError(null);
      try {
        const created = await apiFetch<CreateJobResponse>('/api/parsers/polza-outreach', {
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
  }, [activeJobId, loadResults, refreshJobs, resultsPage]);

  const handlePageChange = useCallback(
    (page: number) => {
      if (!activeJobId) return;
      const next = Math.min(Math.max(page, 1), totalPages);
      setResultsPage(next);
      void loadResults(activeJobId, next);
    },
    [activeJobId, loadResults, totalPages],
  );

  const exportCsv = useCallback(async () => {
    if (!activeJobId) return;
    setActionsBusy(true);
    setExportProgress('CSV: подготовка');
    try {
      const items = await fetchAllResults(activeJobId);
      if (!items.length) {
        setToast({ tone: 'error', message: 'Нет данных для экспорта' });
        return;
      }
      const lines = [EXPORT_HEADER.join(',')];
      for (const item of items) lines.push(exportRow(item).map(csvCell).join(','));
      downloadBlob('\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8', `polza_outreach_${activeJobId.slice(0, 8)}.csv`);
      setToast({ tone: 'success', message: `CSV: ${items.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [activeJobId, fetchAllResults]);

  const stopJob = useCallback(async () => {
    if (!activeJobId) return;
    try {
      await apiFetch(`/api/parsers/polza-outreach/${activeJobId}`, { method: 'PATCH', body: JSON.stringify({ action: 'stop' }) });
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка остановки');
    }
  }, [activeJobId, refreshJobs]);

  const confirmDelete = useCallback(async () => {
    if (!deleteCandidate) return;
    try {
      await apiFetch(`/api/parsers/polza-outreach/${deleteCandidate}`, { method: 'DELETE' });
      if (activeJobId === deleteCandidate) {
        setActiveJobId(null);
        setResults([]);
        setResultsCount(0);
        setFunnel(null);
        setExclusionCounts(null);
      }
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления');
    } finally {
      setDeleteCandidate(null);
    }
  }, [activeJobId, deleteCandidate, refreshJobs]);

  return (
    <div className="space-y-6">
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
          role="status"
        >
          {toast.message}
        </div>
      ) : null}

      <PolzaOutreachForm onStart={start} busy={busy} />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <JobsList
          jobs={jobs}
          activeJobId={activeJobId}
          activeJobParsedCount={resultsCount}
          onSelect={(id) => setActiveJobId(id)}
          onRefresh={() => void manualRefresh()}
          busy={busy}
          refreshing={refreshing}
        />

        <PolzaOutreachResults
          items={results}
          count={resultsCount}
          funnel={funnel}
          exclusionCounts={exclusionCounts}
          loading={resultsLoading}
          jobStatus={activeJob?.status ?? null}
          currentPage={resultsPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          actionsBusy={actionsBusy}
          exportProgress={exportProgress}
          onExportCsv={() => void exportCsv()}
          onStopJob={activeJob?.id ? () => void stopJob() : undefined}
          onDeleteJob={activeJob?.id ? () => setDeleteCandidate(activeJob.id) : undefined}
        />
      </div>

      {deleteCandidate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-gray-900">Удалить запуск?</h3>
              <p className="mt-2 text-sm text-gray-600">
                Будут удалены job и все результаты Polza outreach. Действие необратимо.
              </p>
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
