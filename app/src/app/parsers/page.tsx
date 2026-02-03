'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { HHSearchConfig, HHVacancyRow, ParserJob } from '@/types';
import { HHParserForm } from '@/components/parsers/HHParserForm';
import { JobsList } from '@/components/parsers/JobsList';
import { VacancyResults } from '@/components/parsers/VacancyResults';

type JobsResponse = { jobs: ParserJob[] };
type CreateJobResponse = { job: ParserJob };
type ExecuteResponse = { status: string; found: number; parsed: number };
type ResultsResponse = { items: HHVacancyRow[]; count: number; limit: number; offset: number };

async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
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
    throw new Error(text || `Request failed: ${res.status}`);
  }

  return (await res.json()) as T;
}

export default function ParsersPage() {
  const [jobs, setJobs] = useState<ParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');

  const [results, setResults] = useState<HHVacancyRow[]>([]);
  const [resultsCount, setResultsCount] = useState(0);
  const [resultsOffset, setResultsOffset] = useState(0);
  const resultsLimit = 50;
  const [resultsLoading, setResultsLoading] = useState(false);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [activeJobId, jobs]);

  const refreshJobs = useCallback(async () => {
    const data = await apiFetch<JobsResponse>('/api/parsers/hh', { method: 'GET' });
    setJobs(data.jobs ?? []);
    if (!activeJobId && data.jobs?.[0]?.id) setActiveJobId(data.jobs[0].id);
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

  useEffect(() => {
    void (async () => {
      try {
        setError('');
        await refreshJobs();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Ошибка загрузки jobs');
      }
    })();
  }, [refreshJobs]);

  useEffect(() => {
    if (!activeJobId) return;
    setResults([]);
    setResultsCount(0);
    setResultsOffset(0);
    void loadResults(activeJobId, 0, false);
  }, [activeJobId, loadResults]);

  const start = useCallback(async (config: HHSearchConfig) => {
    setBusy(true);
    setError('');
    try {
      const created = await apiFetch<CreateJobResponse>('/api/parsers/hh', {
        method: 'POST',
        body: JSON.stringify(config),
      });

      const jobId = created.job.id;
      setActiveJobId(jobId);

      await apiFetch<ExecuteResponse>('/api/parsers/hh/execute', {
        method: 'POST',
        body: JSON.stringify({ job_id: jobId }),
      });

      await refreshJobs();
      await loadResults(jobId, 0, false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка запуска парсинга');
      await refreshJobs().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [loadResults, refreshJobs]);

  const exportCsv = useCallback(() => {
    const header = ['vacancy_id', 'name', 'url', 'company_name', 'area', 'salary_from', 'salary_to', 'salary_currency', 'published_at'];
    const lines = [header.join(',')];
    for (const v of results) {
      const row = [
        v.vacancy_id,
        v.name,
        v.url,
        v.company_name,
        v.area,
        v.salary_from ?? '',
        v.salary_to ?? '',
        v.salary_currency ?? '',
        v.published_at ?? '',
      ].map((x) => `"${String(x).replaceAll('"', '""')}"`);
      lines.push(row.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hh_results_${activeJobId ?? 'job'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [activeJobId, results]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Парсеры</h1>
        <p className="text-sm text-gray-500 mt-1">Асинхронные задачи парсинга и результаты</p>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <HHParserForm onStart={start} busy={busy} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <JobsList
          jobs={jobs}
          activeJobId={activeJobId}
          onSelect={(id) => setActiveJobId(id)}
          onRefresh={() => void refreshJobs()}
          busy={busy}
        />

        <VacancyResults
          items={results}
          count={resultsCount}
          limit={resultsLimit}
          offset={resultsOffset}
          loading={resultsLoading}
          onLoadMore={() => {
            if (!activeJobId) return;
            const nextOffset = resultsOffset + results.length;
            void loadResults(activeJobId, nextOffset, true);
          }}
          onExportCsv={exportCsv}
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

