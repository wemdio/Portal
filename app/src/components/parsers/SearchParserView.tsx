
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { SearchParserJob, SearchResult } from '@/types/parsers';
import { SearchParserForm } from './SearchParserForm';
import { JobStatus } from './JobStatus';
import { RefreshCw, Download, Copy, Check } from 'lucide-react';

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

export function SearchParserView() {
  const [jobs, setJobs] = useState<SearchParserJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingResults, setLoadingResults] = useState(false);
  const [copied, setCopied] = useState(false);

  const activeJob = useMemo(() => jobs.find(j => j.id === activeJobId), [jobs, activeJobId]);

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

  const refreshJobs = useCallback(async () => {
    try {
      const { data } = await supabase.from('search_parser_jobs').select('*').order('created_at', { ascending: false });
      if (data) setJobs(data);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadResults = useCallback(async (jobId: string) => {
    setLoadingResults(true);
    try {
      const data = await apiFetch<{ results: SearchResult[] }>(`/api/parsers/search/${jobId}/results`);
      if (data.results) setResults(data.results);
    } finally {
      setLoadingResults(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  useEffect(() => {
    if (activeJobId) {
      loadResults(activeJobId);
    } else {
      setResults([]);
    }
  }, [activeJobId, loadResults]);

  // Auto-refresh active job
  useEffect(() => {
    if (!activeJobId || !activeJob) return;
    if (activeJob.status === 'running' || activeJob.status === 'pending') {
      const interval = setInterval(() => {
        refreshJobs();
        loadResults(activeJobId);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [activeJob, activeJobId, refreshJobs, loadResults]);

  const handleStart = async (queries: string[]) => {
    setBusy(true);
    try {
      const data = await apiFetch<{ job: SearchParserJob }>('/api/parsers/search', {
        method: 'POST',
        body: JSON.stringify({ queries }),
      });
      await refreshJobs();
      setActiveJobId(data.job.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const handleExportCsv = () => {
    if (results.length === 0) return;
    const header = ['Query', 'Title', 'Link', 'Snippet', 'Position'];
    const rows = results.map(r => [
      `"${r.query.replace(/"/g, '""')}"`,
      `"${r.title.replace(/"/g, '""')}"`,
      `"${r.link}"`,
      `"${r.snippet.replace(/"/g, '""')}"`,
      r.position
    ]);
    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `search_results_${activeJobId}.csv`;
    a.click();
  };

  const handleCopy = async () => {
     if (results.length === 0) return;
     const text = results.map(r => `${r.title}\t${r.link}\t${r.snippet}`).join('\n');
     try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
     } catch (err) {
        console.error('Failed to copy', err);
     }
  };

  return (
    <div className="space-y-6">
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
                  <JobStatus status={job.status} />
                  <span className="text-xs text-gray-400">{formatDate(job.created_at)}</span>
                </div>
                <div className="text-sm font-medium text-gray-900 truncate">
                  {job.config.queries?.[0] || 'Без запросов'}
                  {job.config.queries?.length > 1 && ` (+${job.config.queries.length - 1})`}
                </div>
                <div className="mt-2 text-xs text-gray-500 flex justify-between">
                  <span>Запросов: {job.processed_queries}/{job.total_queries}</span>
                  <span>Найдено: {job.total_results}</span>
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
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
               <h3 className="text-lg font-semibold text-gray-900">Результаты</h3>
               <p className="text-sm text-gray-500">{results.length} найдено</p>
            </div>
            <div className="flex gap-2">
               <button onClick={handleExportCsv} disabled={results.length === 0} className="p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50">
                  <Download className="h-5 w-5" />
               </button>
               <button onClick={handleCopy} disabled={results.length === 0} className="p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50">
                  {copied ? <Check className="h-5 w-5 text-green-500" /> : <Copy className="h-5 w-5" />}
               </button>
            </div>
          </div>
          
          {activeJobId ? (
             <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                   <thead className="bg-gray-50">
                      <tr>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Запрос</th>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Результат</th>
                         <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Позиция</th>
                      </tr>
                   </thead>
                   <tbody className="divide-y divide-gray-100 bg-white">
                      {loadingResults ? (
                         <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-500">Загрузка...</td></tr>
                      ) : results.length === 0 ? (
                         <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-500">Нет результатов</td></tr>
                      ) : (
                         results.map((r) => (
                            <tr key={r.id} className="hover:bg-gray-50">
                               <td className="px-4 py-3 text-xs text-gray-500 max-w-[150px] truncate" title={r.query}>{r.query}</td>
                               <td className="px-4 py-3">
                                  <a href={r.link} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 hover:underline block mb-1">
                                     {r.title}
                                  </a>
                                  <div className="text-xs text-green-700 truncate mb-1">{r.link}</div>
                                  <div className="text-xs text-gray-600 line-clamp-2">{r.snippet}</div>
                               </td>
                               <td className="px-4 py-3 text-xs text-gray-500 text-center">{r.position}</td>
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
    </div>
  );
}
