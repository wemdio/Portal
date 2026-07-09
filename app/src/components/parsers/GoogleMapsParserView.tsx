'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetchJson } from '@/lib/authFetch';
import { supabase } from '@/lib/supabaseClient';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  Download,
  FileJson,
  FileText,
  MapPinned,
  Pause,
  Play,
  RefreshCw,
  Square,
  Table2,
} from 'lucide-react';
import type { GoogleMapsJobRow, GoogleMapsPlaceRow, GoogleParserStatus } from '@/types/googleParsers';
import type { QueueStatusResponse } from '@/app/api/parsers/googlemaps/queue-status/route';
import type { GoogleParserLogRow } from '@/app/api/parsers/googlemaps/[jobId]/logs/route';
import { GoogleMapsParserForm } from '@/components/parsers/GoogleMapsParserForm';
import { JobStatus, isStoppedByUser } from '@/components/parsers/JobStatus';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';
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

export function GoogleMapsParserView() {
  const [jobs, setJobs] = useState<GoogleMapsJobRow[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [results, setResults] = useState<GoogleMapsPlaceRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatusResponse | null>(null);
  const [logs, setLogs] = useState<GoogleParserLogRow[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const { flag: refreshed, trigger: triggerRefreshed } = useTimedFlag(1200);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);

  const refreshJobs = useCallback(async () => {
    try {
      const data = await authFetchJson<{ jobs: GoogleMapsJobRow[] }>('/api/parsers/googlemaps');
      setJobs(data.jobs ?? []);
    } catch (e) {
      console.error('[googlemaps] refreshJobs failed', e);
    }
  }, []);

  const refreshQueueStatus = useCallback(async () => {
    try {
      const data = await authFetchJson<QueueStatusResponse>('/api/parsers/googlemaps/queue-status');
      setQueueStatus(data);
    } catch {
      // non-critical
    }
  }, []);

  const refreshActiveJob = useCallback(async (jobId: string) => {
    try {
      const data = await authFetchJson<{ job: GoogleMapsJobRow }>(`/api/parsers/googlemaps/${jobId}`);
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === jobId);
        if (idx === -1) return [data.job, ...prev];
        const next = prev.slice();
        next[idx] = data.job;
        return next;
      });
    } catch (e) {
      console.error('[googlemaps] refreshActiveJob failed', e);
    }
  }, []);

  const loadResults = useCallback(async (jobId: string) => {
    setLoadingResults(true);
    try {
      let offset = 0;
      let all: GoogleMapsPlaceRow[] = [];
      for (;;) {
        const data = await authFetchJson<{ results: GoogleMapsPlaceRow[]; hasMore: boolean }>(
          `/api/parsers/googlemaps/${jobId}/results?limit=${RESULTS_FETCH_PAGE}&offset=${offset}`,
        );
        const page = data.results ?? [];
        all = all.concat(page);
        if (!data.hasMore || page.length === 0) break;
        offset += page.length;
      }
      setResults(all);
    } catch (e) {
      console.error('[googlemaps] loadResults failed', e);
    } finally {
      setLoadingResults(false);
    }
  }, []);

  const loadLogs = useCallback(async (jobId: string) => {
    try {
      const data = await authFetchJson<{ logs: GoogleParserLogRow[] }>(
        `/api/parsers/googlemaps/${jobId}/logs?limit=500`,
      );
      setLogs(data.logs ?? []);
    } catch (e) {
      console.error('[googlemaps] loadLogs failed', e);
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
      setLogs([]);
      return;
    }
    void loadResults(activeJobId);
    setLogs([]);
  }, [activeJobId, loadResults]);

  // Fetch logs when the panel is first opened for a job.
  useEffect(() => {
    if (!activeJobId || !showLogs) return;
    void loadLogs(activeJobId);
  }, [activeJobId, showLogs, loadLogs]);

  // Poll active job status + results while it's live. Also refresh logs if
  // the panel is open — piggybacked on the same tick so we don't run two
  // parallel polling loops.
  useEffect(() => {
    if (!activeJobId || !activeJob) return;
    if (!isActiveStatus(activeJob.status)) return;
    const interval = window.setInterval(() => {
      void refreshActiveJob(activeJobId);
      void refreshQueueStatus();
      void loadResults(activeJobId);
      if (showLogs) void loadLogs(activeJobId);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeJob, activeJobId, refreshActiveJob, refreshQueueStatus, loadResults, loadLogs, showLogs]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleSubmit = useCallback(
    async (values: {
      inputLines: string[];
      limitPerQuery: number;
      language: string;
      region: string;
      minDelayMs: number;
      maxDelayMs: number;
      enrichContacts: boolean;
      proxies: string[];
    }) => {
      setSubmitting(true);
      setError(null);
      try {
        const data = await authFetchJson<{ job: GoogleMapsJobRow }>('/api/parsers/googlemaps', {
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
        const data = await authFetchJson<{ job: GoogleMapsJobRow }>(
          `/api/parsers/googlemaps/${jobId}/${action}`,
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
        const res = await fetch(`/api/parsers/googlemaps/${activeJobId}/export?format=${format}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `google-maps-${activeJobId.slice(0, 8)}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error('[googlemaps] export failed', e);
        setError(`Не удалось скачать ${format.toUpperCase()}`);
      }
    },
    [activeJobId],
  );

  const handleExportCsv = useCallback(() => downloadExport('csv'), [downloadExport]);
  const handleExportJson = useCallback(() => downloadExport('json'), [downloadExport]);

  const handleAddToDatabases = useCallback(() => {
    try {
      if (!activeJobId) {
        setToast({ tone: 'error', message: 'Сначала выберите запуск' });
        return;
      }
      if (results.length === 0) {
        setToast({ tone: 'error', message: 'Нет результатов для добавления' });
        return;
      }
      const headerRow = ['company', 'phone', 'website', 'email', 'linkedin', 'address', 'industry'];
      const rows = results.map((p) => [
        p.name ?? '',
        p.phone ?? '',
        p.website ?? '',
        p.emails?.[0] ?? '',
        p.linkedin_url ?? '',
        p.address ?? '',
        p.category ?? '',
      ]);
      const title = `Google Maps #${activeJobId.slice(0, 8)}`;
      const { id } = writePendingDbImport({ title, rows: [headerRow, ...rows] });
      setToast({
        tone: 'success',
        message: `Добавлено в «Базы» (${rows.length})`,
        href: buildDatabasesImportUrl(id),
      });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка добавления в базу' });
    }
  }, [activeJobId, results]);

  const totalTargets = activeJob?.total_targets ?? 0;
  const processedTargets = activeJob?.processed_targets ?? 0;
  const totalResults = activeJob?.total_results ?? results.length;
  const progressPct = totalTargets > 0 ? Math.round((processedTargets / totalTargets) * 100) : null;

  const canPause = activeJob?.status === 'running' || activeJob?.status === 'queued';
  const canResume = activeJob?.status === 'paused';
  const canStop = activeJob ? isActiveStatus(activeJob.status) : false;

  return (
    <div className="space-y-8">
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

      {/* Top section: New Run */}
      <div
        className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
        style={{ borderTop: '3px solid #4285F4' }}
      >
        <div className="p-4 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-blue-100 text-blue-600">
                  <MapPinned className="h-4 w-4" />
                </span>
                Google Maps
              </h3>
              <p className="text-xs text-gray-500 mt-0.5 ml-9">
                Инструмент для сбора данных из Google Maps
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
          <GoogleMapsParserForm submitting={submitting} onSubmit={handleSubmit} />
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
                        ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500/20'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate min-w-0">
                        {(() => {
                          const first = j.config?.inputLines?.[0]?.trim();
                          if (first) return first.length > 32 ? first.slice(0, 32) + '…' : first;
                          return `#${j.id.slice(0, 8)}`;
                        })()}
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
                          ? `${j.processed_targets}/${j.total_targets} запр.`
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
                <MapPinned className="h-full w-full" strokeWidth={1.5} />
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
                        <h2 className="text-xl font-bold text-gray-900 truncate max-w-[520px]">
                          {(() => {
                            // Первая строка запроса как заголовок — обычно
                            // это либо URL Google Maps, либо ключевая фраза.
                            // Обрезаем 60 символов чтобы не растянуть шапку.
                            const first = activeJob.config?.inputLines?.[0]?.trim();
                            if (first) return first.length > 60 ? first.slice(0, 60) + '…' : first;
                            return `Запуск #${activeJob.id.slice(0, 8)}`;
                          })()}
                        </h2>
                        <span className="text-xs text-gray-400 shrink-0">#{activeJob.id.slice(0, 8)}</span>
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                            activeJob.status === 'completed'
                              ? 'bg-green-50 text-green-700 ring-green-600/20'
                              : activeJob.status === 'running'
                                ? 'bg-blue-50 text-blue-700 ring-blue-600/20'
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
                          Запросов:{' '}
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
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      ) : null}

                      {activeJob.status === 'running' ? (
                        <div className="mt-3 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-900">
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

                      {(activeJob.status === 'failed' ||
                        activeJob.status === 'captcha' ||
                        activeJob.status === 'blocked' ||
                        activeJob.status === 'timeout' ||
                        activeJob.status === 'login_required') &&
                      !isStoppedByUser(
                        mapToParserJobStatus(activeJob.status),
                        activeJob.error_message,
                      ) ? (
                        <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 border border-red-100 space-y-1">
                          <div>
                            <span className="font-medium">Статус:</span> {statusLabelRu(activeJob.status)}
                          </div>
                          {activeJob.error_message ? (
                            <div>
                              <span className="font-medium">Ошибка:</span>{' '}
                              <span className="break-all">{activeJob.error_message}</span>
                            </div>
                          ) : null}
                          {activeJob.message ? (
                            <div>
                              <span className="font-medium">Сообщение:</span>{' '}
                              <span className="break-all">{activeJob.message}</span>
                            </div>
                          ) : null}
                          {!activeJob.error_message && !activeJob.message ? (
                            <div className="text-xs text-red-600/80">
                              Диагностика не сохранена. Скорее всего воркер{' '}
                              <code className="rounded bg-red-100 px-1">worker-googleparsers</code>{' '}
                              не запущен, либо сервис{' '}
                              <code className="rounded bg-red-100 px-1">googleparsers</code>{' '}
                              (Playwright, порт 8001) недоступен. Проверь{' '}
                              <code className="rounded bg-red-100 px-1">docker logs portal-worker-googleparsers</code>{' '}
                              на прод-сервере.
                            </div>
                          ) : null}
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

                {/* Logs panel — expandable */}
                <div className="mx-6 mb-6 rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-3 py-2 text-sm bg-gray-50 hover:bg-gray-100"
                    onClick={() => setShowLogs((v) => !v)}
                  >
                    <span className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      <span>Логи парсинга</span>
                      {logs.length > 0 && (
                        <span className="text-xs text-gray-500">({logs.length})</span>
                      )}
                    </span>
                    {showLogs ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showLogs && (
                    <div className="max-h-96 overflow-y-auto bg-gray-950 text-gray-100 font-mono text-xs">
                      {logs.length === 0 ? (
                        <div className="p-3 text-gray-500">Пока пусто…</div>
                      ) : (
                        logs.map((l) => (
                          <div
                            key={l.id}
                            className={`px-3 py-1 border-b border-gray-800 flex gap-2 ${
                              l.level === 'error'
                                ? 'text-red-300'
                                : l.level === 'warn'
                                  ? 'text-amber-300'
                                  : l.level === 'debug'
                                    ? 'text-gray-500'
                                    : 'text-gray-100'
                            }`}
                          >
                            <span className="text-gray-500 shrink-0">
                              {new Date(l.created_at).toLocaleTimeString('ru-RU')}
                            </span>
                            <span className="uppercase text-[10px] pt-0.5 shrink-0">[{l.level}]</span>
                            <span className="break-all">{l.message}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
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
                      onClick={handleAddToDatabases}
                      disabled={!activeJobId || results.length === 0}
                      className="inline-flex items-center gap-2 rounded-lg bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                      title="Откроет «Базы» и добавит результаты новой вкладкой"
                    >
                      <Database className="h-3.5 w-3.5" />В базу
                    </button>
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
                        <RefreshCw className="h-6 w-6 animate-spin text-blue-500" />
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
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[240px]">
                            Компания
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Адрес
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Телефон
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Сайт
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            LinkedIn
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Email
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Рейтинг
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Статус
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {results.slice(0, RESULTS_TABLE_LIMIT).map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 align-top max-w-[240px]">
                              <div className="font-medium text-gray-900 break-words">
                                {r.name || '—'}
                              </div>
                              {r.category ? (
                                <div className="text-xs text-gray-500 mt-0.5 line-clamp-2" title={r.category}>
                                  {r.category}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 align-top text-gray-600 max-w-xs">
                              {r.address || '—'}
                            </td>
                            <td className="px-4 py-3 align-top text-gray-900 whitespace-nowrap">
                              {r.phone || '—'}
                            </td>
                            <td className="px-4 py-3 align-top">
                              {r.website ? (
                                <a
                                  className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-[200px] block"
                                  href={r.website}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {r.website}
                                </a>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-3 align-top">
                              {r.linkedin_url ? (
                                <a
                                  className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-[180px] block"
                                  href={r.linkedin_url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  LinkedIn
                                </a>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-3 align-top text-gray-600 max-w-[200px]">
                              {r.emails && r.emails.length > 0 ? (
                                <div className="space-y-0.5">
                                  {r.emails.slice(0, 2).map((em, i) => (
                                    <div key={i} className="truncate" title={em}>
                                      {em}
                                    </div>
                                  ))}
                                  {r.emails.length > 2 ? (
                                    <div className="text-xs text-gray-400">
                                      +{r.emails.length - 2}
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-3 align-top text-center whitespace-nowrap">
                              <div className="flex items-center justify-center gap-1">
                                <span className="text-amber-500">★</span>
                                <span className="font-medium text-gray-900">{r.rating || '—'}</span>
                                <span className="text-gray-400 text-xs">
                                  ({r.reviews_count ?? 0})
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top text-center">
                              <span className="text-xs text-gray-500">{r.status || 'ok'}</span>
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
