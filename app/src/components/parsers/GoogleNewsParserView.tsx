'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetchJson } from '@/lib/authFetch';
import { supabase } from '@/lib/supabaseClient';
import {
  Clock,
  Download,
  FileJson,
  Newspaper,
  Pause,
  Play,
  RefreshCw,
  Square,
  Table2,
} from 'lucide-react';
import type { GoogleNewsJobRow, GoogleNewsResultRow, GoogleParserStatus } from '@/types/googleParsers';
import type { QueueStatusResponse } from '@/app/api/parsers/googlenews/queue-status/route';
import { GoogleNewsParserForm } from '@/components/parsers/GoogleNewsParserForm';
import { JobStatus, isStoppedByUser } from '@/components/parsers/JobStatus';
import type { ParserJobStatus } from '@/types/parsers';

const POLL_INTERVAL_MS = 1800;
const RESULTS_TABLE_LIMIT = 500;
const RESULTS_FETCH_PAGE = 5000;

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

/**
 * GoogleParserStatus has more granular states than the shared JobStatus pill
 * (queued/paused/blocked/captcha/timeout/login_required/stopped). Map them
 * into the four-state ParserJobStatus palette that JobStatus knows about.
 */
function mapToParserJobStatus(status: GoogleParserStatus): ParserJobStatus {
  if (status === 'queued' || status === 'paused') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  return 'failed';
}

function isActiveStatus(status: GoogleParserStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'paused';
}

function statusLabelRu(status: GoogleParserStatus): string {
  switch (status) {
    case 'queued':
      return 'В очереди';
    case 'running':
      return 'Выполняется';
    case 'paused':
      return 'Приостановлено';
    case 'stopped':
      return 'Остановлено';
    case 'completed':
      return 'Завершено';
    case 'failed':
      return 'Ошибка';
    case 'captcha':
      return 'Капча';
    case 'blocked':
      return 'Заблокировано';
    case 'timeout':
      return 'Таймаут';
    case 'login_required':
      return 'Нужен вход';
    default:
      return status;
  }
}

function useTimedFlag(durationMs: number) {
  const [flag, setFlag] = useState(false);
  const timerRef = useRef<number | null>(null);
  const trigger = useCallback(() => {
    setFlag(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setFlag(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  return { flag, trigger };
}

export function GoogleNewsParserView() {
  const [jobs, setJobs] = useState<GoogleNewsJobRow[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [results, setResults] = useState<GoogleNewsResultRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatusResponse | null>(null);
  const { flag: refreshed, trigger: triggerRefreshed } = useTimedFlag(1200);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);

  const refreshJobs = useCallback(async () => {
    try {
      const data = await authFetchJson<{ jobs: GoogleNewsJobRow[] }>('/api/parsers/googlenews');
      setJobs(data.jobs ?? []);
    } catch (e) {
      console.error('[googlenews] refreshJobs failed', e);
    }
  }, []);

  const refreshQueueStatus = useCallback(async () => {
    try {
      const data = await authFetchJson<QueueStatusResponse>('/api/parsers/googlenews/queue-status');
      setQueueStatus(data);
    } catch {
      // non-critical
    }
  }, []);

  const refreshActiveJob = useCallback(async (jobId: string) => {
    try {
      const data = await authFetchJson<{ job: GoogleNewsJobRow }>(`/api/parsers/googlenews/${jobId}`);
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === jobId);
        if (idx === -1) return [data.job, ...prev];
        const next = prev.slice();
        next[idx] = data.job;
        return next;
      });
    } catch (e) {
      console.error('[googlenews] refreshActiveJob failed', e);
    }
  }, []);

  const loadResults = useCallback(async (jobId: string) => {
    setLoadingResults(true);
    try {
      let offset = 0;
      let all: GoogleNewsResultRow[] = [];
      for (;;) {
        const data = await authFetchJson<{ results: GoogleNewsResultRow[]; hasMore: boolean }>(
          `/api/parsers/googlenews/${jobId}/results?limit=${RESULTS_FETCH_PAGE}&offset=${offset}`,
        );
        const page = data.results ?? [];
        all = all.concat(page);
        if (!data.hasMore || page.length === 0) break;
        offset += page.length;
      }
      setResults(all);
    } catch (e) {
      console.error('[googlenews] loadResults failed', e);
    } finally {
      setLoadingResults(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void refreshJobs();
    void refreshQueueStatus();
  }, [refreshJobs, refreshQueueStatus]);

  // Load results when the active job changes
  useEffect(() => {
    if (!activeJobId) {
      setResults([]);
      return;
    }
    void loadResults(activeJobId);
  }, [activeJobId, loadResults]);

  // Poll active job status + results while it's live
  useEffect(() => {
    if (!activeJobId || !activeJob) return;
    if (!isActiveStatus(activeJob.status)) return;
    const interval = window.setInterval(() => {
      void refreshActiveJob(activeJobId);
      void refreshQueueStatus();
      void loadResults(activeJobId);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeJob, activeJobId, refreshActiveJob, refreshQueueStatus, loadResults]);

  const handleSubmit = useCallback(
    async (values: {
      queries: string[];
      pagesLimit: number;
      country: string;
      language: string;
      dateRange: 'any' | 'hour' | 'day' | 'week' | 'month' | 'year';
      minDelayMs: number;
      maxDelayMs: number;
      proxies: string[];
    }) => {
      setSubmitting(true);
      setError(null);
      try {
        const data = await authFetchJson<{ job: GoogleNewsJobRow }>('/api/parsers/googlenews', {
          method: 'POST',
          body: JSON.stringify(values),
        });
        // Prepend the new job to the list optimistically, then refresh.
        setJobs((prev) => [data.job, ...prev.filter((j) => j.id !== data.job.id)]);
        setActiveJobId(data.job.id);
        void refreshJobs();
        void refreshQueueStatus();
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : 'Не удалось создать запуск');
      } finally {
        setSubmitting(false);
      }
    },
    [refreshJobs, refreshQueueStatus],
  );

  const runControl = useCallback(
    async (jobId: string, action: 'pause' | 'resume' | 'stop') => {
      setJobActionId(jobId);
      setError(null);
      try {
        const data = await authFetchJson<{ job: GoogleNewsJobRow }>(
          `/api/parsers/googlenews/${jobId}/${action}`,
          { method: 'POST' },
        );
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === jobId);
          if (idx === -1) return prev;
          const next = prev.slice();
          next[idx] = data.job;
          return next;
        });
      } catch (e) {
        console.error(e);
        setError(
          e instanceof Error
            ? e.message
            : action === 'pause'
              ? 'Не удалось поставить на паузу'
              : action === 'resume'
                ? 'Не удалось возобновить'
                : 'Не удалось остановить',
        );
      } finally {
        setJobActionId(null);
      }
    },
    [],
  );

  const handlePause = useCallback(() => activeJobId && runControl(activeJobId, 'pause'), [activeJobId, runControl]);
  const handleResume = useCallback(() => activeJobId && runControl(activeJobId, 'resume'), [activeJobId, runControl]);
  const handleStop = useCallback(() => activeJobId && runControl(activeJobId, 'stop'), [activeJobId, runControl]);

  const downloadExport = useCallback(
    async (format: 'csv' | 'json') => {
      if (!activeJobId) return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          setError('Сессия истекла, обновите страницу');
          return;
        }
        const res = await fetch(`/api/parsers/googlenews/${activeJobId}/export?format=${format}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `google-news-${activeJobId.slice(0, 8)}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error('[googlenews] export failed', e);
        setError(`Не удалось скачать ${format.toUpperCase()}`);
      }
    },
    [activeJobId],
  );

  const handleExportCsv = useCallback(() => downloadExport('csv'), [downloadExport]);
  const handleExportJson = useCallback(() => downloadExport('json'), [downloadExport]);

  const totalTargets = activeJob?.total_targets ?? 0;
  const processedTargets = activeJob?.processed_targets ?? 0;
  const totalResults = activeJob?.total_results ?? results.length;
  const progressPct = totalTargets > 0 ? Math.round((processedTargets / totalTargets) * 100) : null;

  const canPause = activeJob?.status === 'running' || activeJob?.status === 'queued';
  const canResume = activeJob?.status === 'paused';
  const canStop = activeJob ? isActiveStatus(activeJob.status) : false;

  return (
    <div className="space-y-8">
      {/* Top section: New Run */}
      <div
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
        style={{ borderTop: '3px solid #0F9D58' }}
      >
        <div className="p-4 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-100 text-emerald-700">
                  <Newspaper className="h-4 w-4" />
                </span>
                Google News
              </h3>
              <p className="text-xs text-gray-500 mt-0.5 ml-9">
                Инструмент для сбора новостной выдачи из Google News
              </p>
            </div>
            {queueStatus ? (
              <div className="text-xs text-gray-500 text-right shrink-0">
                {queueStatus.activeJobId ? (
                  <div>
                    <span className="font-medium text-gray-700">В работе:</span>{' '}
                    <span className="font-mono">#{queueStatus.activeJobId.slice(0, 8)}</span>
                  </div>
                ) : (
                  <div>Воркер свободен</div>
                )}
                <div>
                  В очереди: <span className="font-medium text-gray-700">{queueStatus.queuedCount}</span>
                  {queueStatus.averageJobDurationSec > 0 ? (
                    <span className="ml-2">
                      ~{Math.round(queueStatus.averageJobDurationSec / 60)} мин/запуск
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="p-6">
          <GoogleNewsParserForm submitting={submitting} onSubmit={handleSubmit} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: History */}
        <div className="lg:col-span-3 space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-[800px]">
            <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-amber-100 text-amber-600">
                  <Clock className="h-3.5 w-3.5" />
                </span>
                История запусков
              </h3>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors bg-white border border-gray-200 rounded-md px-2.5 py-1.5 shadow-sm hover:bg-gray-50"
                onClick={() => {
                  void refreshJobs();
                  void refreshQueueStatus();
                  triggerRefreshed();
                }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshed ? 'animate-spin' : ''}`} />
                Обновить
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {jobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
                  <p>Нет запусков</p>
                </div>
              ) : (
                jobs.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setActiveJobId(j.id)}
                    className={`w-full text-left rounded-lg border p-3 transition-all ${
                      activeJobId === j.id
                        ? 'border-emerald-500 bg-emerald-50/50 ring-1 ring-emerald-500/20'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-xs font-medium text-gray-500">
                        #{j.id.slice(0, 8)}
                      </span>
                      <JobStatus
                        status={mapToParserJobStatus(j.status)}
                        errorMessage={j.error_message}
                      />
                    </div>

                    <div className="flex items-center justify-between text-xs text-gray-600">
                      <span>{formatDate(j.created_at)}</span>
                      <span className="font-medium">
                        {j.total_targets
                          ? `${j.processed_targets}/${j.total_targets} стр.`
                          : `${j.total_results} рез.`}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: Active job details */}
        <div className="lg:col-span-9 space-y-6">
          {!activeJob ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center h-full flex flex-col items-center justify-center">
              <div className="mx-auto h-12 w-12 text-gray-300 mb-4">
                <Newspaper className="h-full w-full" strokeWidth={1.5} />
              </div>
              <h3 className="text-lg font-medium text-gray-900">Нет выбранного запуска</h3>
              <p className="mt-1 text-sm text-gray-500">
                Запустите новый парсинг сверху или выберите запуск из истории слева.
              </p>
            </div>
          ) : (
            <>
              {/* Job header + controls */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <h2 className="text-xl font-bold text-gray-900">
                          Запуск #{activeJob.id.slice(0, 8)}
                        </h2>
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                            activeJob.status === 'completed'
                              ? 'bg-green-50 text-green-700 ring-green-600/20'
                              : activeJob.status === 'running'
                                ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                                : activeJob.status === 'paused'
                                  ? 'bg-amber-50 text-amber-700 ring-amber-600/20'
                                  : activeJob.status === 'queued'
                                    ? 'bg-gray-50 text-gray-700 ring-gray-500/20'
                                    : 'bg-red-50 text-red-700 ring-red-600/20'
                          }`}
                        >
                          {statusLabelRu(activeJob.status)}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500 mt-2">
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                          Страниц:{' '}
                          <span className="font-medium text-gray-900">
                            {processedTargets} / {totalTargets}
                            {progressPct !== null ? ` (${progressPct}%)` : ''}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                          Результатов:{' '}
                          <span className="font-medium text-gray-900">{totalResults}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                          Создан:{' '}
                          <span className="font-medium text-gray-900">
                            {formatDate(activeJob.created_at)}
                          </span>
                        </div>
                      </div>

                      {progressPct !== null && isActiveStatus(activeJob.status) ? (
                        <div className="mt-3 h-1.5 w-full max-w-md rounded-full bg-gray-100 overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 transition-all duration-300"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      ) : null}

                      {activeJob.status === 'running' ? (
                        <div className="mt-3 rounded-md border border-emerald-100 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
                          Парсинг может занимать длительное время. Можно закрыть вкладку — задача выполняется в фоне.
                        </div>
                      ) : null}

                      {activeJob.status === 'queued' && queueStatus ? (
                        <div className="mt-3 rounded-md border border-amber-100 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
                          В очереди. Активный запуск:{' '}
                          {queueStatus.activeJobId
                            ? `#${queueStatus.activeJobId.slice(0, 8)}`
                            : 'нет'}
                          . Ожидают ещё: {Math.max(0, queueStatus.queuedCount - 1)}.
                        </div>
                      ) : null}

                      {activeJob.error_message &&
                      !isStoppedByUser(
                        mapToParserJobStatus(activeJob.status),
                        activeJob.error_message,
                      ) ? (
                        <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 border border-red-100">
                          <span className="font-medium">Сообщение:</span> {activeJob.error_message}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2 shrink-0">
                      {canPause ? (
                        <button
                          type="button"
                          onClick={handlePause}
                          disabled={jobActionId === activeJob.id}
                          className="inline-flex items-center gap-1.5 justify-center rounded-lg bg-white border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50"
                        >
                          <Pause className="h-4 w-4" />
                          Пауза
                        </button>
                      ) : null}
                      {canResume ? (
                        <button
                          type="button"
                          onClick={handleResume}
                          disabled={jobActionId === activeJob.id}
                          className="inline-flex items-center gap-1.5 justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50"
                        >
                          <Play className="h-4 w-4" />
                          Возобновить
                        </button>
                      ) : null}
                      {canStop ? (
                        <button
                          type="button"
                          onClick={handleStop}
                          disabled={jobActionId === activeJob.id}
                          className="inline-flex items-center gap-1.5 justify-center rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
                        >
                          <Square className="h-4 w-4" />
                          Остановить
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {error ? (
                    <div className="mt-4 text-sm text-red-600 bg-red-50 p-2 rounded border border-red-100">
                      {error}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Results table */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-[600px]">
                <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-emerald-100 text-emerald-600">
                      <Table2 className="h-3.5 w-3.5" />
                    </span>
                    Результаты
                    <span className="text-xs font-normal text-gray-500 ml-1">
                      ({results.length})
                    </span>
                  </h3>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={handleExportJson}
                      disabled={!activeJobId}
                      className="inline-flex items-center gap-2 rounded-lg bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    >
                      <FileJson className="h-3.5 w-3.5" />
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={handleExportCsv}
                      disabled={!activeJobId}
                      className="inline-flex items-center gap-2 rounded-lg bg-gray-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-gray-800 disabled:opacity-50 shadow-sm transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" />
                      CSV
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-auto relative">
                  {loadingResults ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10 pointer-events-none">
                      <div className="flex flex-col items-center gap-2">
                        <RefreshCw className="h-6 w-6 animate-spin text-emerald-500" />
                        <span className="text-sm text-gray-500">Загрузка данных...</span>
                      </div>
                    </div>
                  ) : null}

                  {results.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
                      <p>Нет результатов</p>
                    </div>
                  ) : (
                    <table className="min-w-full text-sm divide-y divide-gray-200">
                      <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Запрос
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Позиция
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[280px]">
                            Заголовок
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Текст
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                            Опубликовано
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Источник
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Ссылка
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {results.slice(0, RESULTS_TABLE_LIMIT).map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 align-top text-gray-600 max-w-[180px] break-words">
                              {r.query || '—'}
                            </td>
                            <td className="px-4 py-3 align-top text-center text-gray-900 whitespace-nowrap">
                              {r.position ?? '—'}
                            </td>
                            <td className="px-4 py-3 align-top max-w-[280px]">
                              <div className="font-medium text-gray-900 break-words line-clamp-2" title={r.title ?? ''}>
                                {r.title || '—'}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top text-gray-600 max-w-[360px]">
                              {r.body ? (
                                <div className="line-clamp-2" title={r.body}>
                                  {r.body}
                                </div>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-3 align-top text-gray-600 whitespace-nowrap">
                              {r.posted || '—'}
                            </td>
                            <td className="px-4 py-3 align-top text-gray-600 max-w-[160px]">
                              <div className="truncate" title={r.source ?? ''}>
                                {r.source || '—'}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              {r.link ? (
                                <a
                                  className="text-emerald-700 hover:text-emerald-900 hover:underline truncate max-w-[220px] block"
                                  href={r.link}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {r.link}
                                </a>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {results.length > RESULTS_TABLE_LIMIT ? (
                  <div className="p-2 border-t border-gray-200 bg-gray-50 text-center text-xs text-gray-500">
                    Показано {RESULTS_TABLE_LIMIT} из {results.length} записей. В экспорт (CSV / JSON) попадут все {results.length}.
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
