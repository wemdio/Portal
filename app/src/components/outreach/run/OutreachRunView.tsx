'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import { fetchAllResultPages } from '@/lib/polzaOutreach/resultsPaging';
import { JobRail, type JobRailItem } from '@/components/ui/JobRail';
import { WorkArea } from '@/components/ui/WorkArea';
import { OutreachRunResults } from './OutreachRunResults';
import type { OutreachResultsResponse, OutreachRunAdapter, OutreachRunJob } from './types';

const RESULTS_LIMIT = 50;

type Resp<Row> = OutreachResultsResponse<Row> & Record<string, unknown>;

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

/** Дата запуска в колонке: день, месяц и время — этого хватает, чтобы отличить соседние. */
function fmtJobDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

type JobsScope = 'all' | 'mine';

/** Выбор «Все / Мои» запоминаем в браузере — у каждого языка свой. */
function readScope(key: string): JobsScope {
  try {
    return window.localStorage.getItem(key) === 'mine' ? 'mine' : 'all';
  } catch {
    return 'all';
  }
}

function csvCell(value: unknown) {
  const text = String(value ?? '').replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ');
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Строка фильтра таблицы: причина отсева важнее статуса — она уже его задаёт. */
function filterQuery(filter: string, reason: string | null): string {
  if (reason) return `&reason=${encodeURIComponent(reason)}`;
  return filter === 'all' ? '' : `&status=${encodeURIComponent(filter)}`;
}

/**
 * Общий экран запуска автоаутрича: колонка запусков, шаги конвейера, цепочки,
 * «Рассылка», таблица с доказательствами и выгрузки. Что ищем и как выглядит
 * строка — адаптер языка (components/outreach/run/types.ts).
 */
export function OutreachRunView<Row extends { id: string }, Config, Job extends OutreachRunJob>({
  adapter,
}: {
  adapter: OutreachRunAdapter<Row, Config, Job>;
}) {
  const base = adapter.apiBase;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<{ initial: Config | null; seq: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const [resp, setResp] = useState<Resp<Row> | null>(null);
  const [resultsPage, setResultsPage] = useState(1);
  // По умолчанию — только готовые: инструмент существует ради них, а
  // отсеянные нужны, когда разбираешься, почему выход меньше заказа.
  const [filter, setFilter] = useState('ready');
  const [reason, setReason] = useState<string | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  // Запуски видят все сотрудники; «Мои» — только свои. Чужие — на чтение.
  const scopeKey = `outreach_jobs_scope_${adapter.parserType}`;
  // null — выбор ещё не прочитан: список не грузим, чтобы не показать «Все» на миг.
  const [scope, setScope] = useState<JobsScope | null>(null);
  useEffect(() => {
    // Выбор из браузера — только после монтирования, иначе разойдётся с сервером.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScope(readScope(scopeKey));
  }, [scopeKey]);
  const changeScope = useCallback(
    (next: JobsScope) => {
      setScope(next);
      try {
        window.localStorage.setItem(scopeKey, next);
      } catch {
        /* приватное окно — выбор просто не запомнится */
      }
    },
    [scopeKey],
  );

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeJobId) ?? null, [activeJobId, jobs]);
  const isOwn = useCallback((job: Job | null) => Boolean(job && sessionUserId && job.user_id === sessionUserId), [sessionUserId]);
  const activeOwn = isOwn(activeJob);

  const railItems = useMemo<JobRailItem[]>(
    () =>
      jobs.map((job) => {
        const target = job.config?.limit ?? null;
        const done = job.total_parsed ?? 0;
        const own = isOwn(job);
        // В общем списке видно, чей запуск; в «Моих» и так ясно. Автосбор
        // записан на включившего автодобор, но запускал его не человек.
        const author = job.config?.autofill
          ? 'система · '
          : scope === 'all'
            ? `${own ? 'вы' : job.author_name ?? 'коллега'} · `
            : '';
        return {
          id: job.id,
          status: job.status as JobRailItem['status'],
          title: `${job.config?.autofill ? 'Автодобор · ' : ''}${target ? `на ${target} компаний` : 'запуск'}`.replace(/^./, (c) => c.toUpperCase()),
          subtitle: `${author}${fmtJobDate(job.created_at)} · готово ${done}${target ? ` из ${target}` : ''}`,
          percent: job.status === 'completed' ? 100 : job.progress_percent ?? 0,
          deletable: own && job.status !== 'running' && job.status !== 'pending',
        };
      }),
    [jobs, isOwn, scope],
  );

  // Полоса ошибки уходит сама через 15 секунд — и её можно закрыть раньше.
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const totalPages = Math.max(1, Math.ceil((resp?.count ?? 0) / RESULTS_LIMIT));

  const refreshJobs = useCallback(async () => {
    if (!scope) return;
    const data = await apiFetch<{ jobs: Job[] }>(`${base}?scope=${scope}`, { method: 'GET' });
    const list = data.jobs ?? [];
    setJobs(list);
    // После смены «Все / Мои» выбранного запуска в списке может не оказаться.
    setActiveJobId((prev) => (prev && list.some((job) => job.id === prev) ? prev : list[0]?.id ?? null));
  }, [base, scope]);

  const query = filterQuery(filter, reason);

  const loadResults = useCallback(
    async (jobId: string, page: number) => {
      setResultsLoading(true);
      try {
        const offset = Math.max(0, (page - 1) * RESULTS_LIMIT);
        setResp(await apiFetch<Resp<Row>>(`${base}/${jobId}/results?limit=${RESULTS_LIMIT}&offset=${offset}${query}`, { method: 'GET' }));
      } finally {
        setResultsLoading(false);
      }
    },
    [base, query],
  );

  /**
   * Все строки прогона — для разбора шага. Таблица листается по полусотне, а
   * шаг — это про весь прогон, поэтому читаем страницами до конца.
   */
  const loadAllRows = useCallback(async (): Promise<Row[]> => {
    if (!activeJobId) return [];
    return fetchAllResultPages<Row>(async (offset, limit) => {
      const data = await apiFetch<Resp<Row>>(`${base}/${activeJobId}/results?limit=${limit}&offset=${offset}`, { method: 'GET' });
      return { items: data.items ?? [], count: data.count ?? 0 };
    });
  }, [activeJobId, base]);

  const fetchAllResults = useCallback(
    async (jobId: string) =>
      fetchAllResultPages<Row>(
        async (offset, limit) => {
          const data = await apiFetch<Resp<Row>>(`${base}/${jobId}/results?limit=${limit}&offset=${offset}${query}`, { method: 'GET' });
          return { items: data.items ?? [], count: data.count ?? 0 };
        },
        (loaded, total) => setExportProgress(`Загрузка: ${loaded} / ${total}`),
      ),
    [base, query],
  );

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
      .channel(`${adapter.parserType}_parser_jobs_${sessionUserId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'parser_jobs', filter: `user_id=eq.${sessionUserId}` },
        (payload) => {
          const p = payload as unknown as { eventType?: string; type?: string; new?: Job; old?: { id?: string } };
          const eventType = p.eventType ?? p.type;
          if (eventType === 'DELETE') {
            if (p.old?.id) setJobs((prev) => prev.filter((job) => job.id !== p.old!.id));
            return;
          }
          const next = p.new;
          if (!next?.id || next.parser_type !== adapter.parserType) return;
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
  }, [sessionUserId, adapter.parserType]);

  useEffect(() => {
    if (!activeJobId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResultsPage(1);
    void loadResults(activeJobId, 1).catch((e) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'));
  }, [activeJobId, loadResults]);

  useEffect(() => {
    if (!activeJobId) return;
    const status = activeJob?.status;
    if (status !== 'running' && status !== 'pending') return;
    const id = window.setInterval(() => {
      void refreshJobs().catch(() => undefined);
      void loadResults(activeJobId, resultsPage).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [activeJobId, activeJob?.status, refreshJobs, loadResults, resultsPage]);

  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === 'completed' || activeJob.status === 'failed') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadResults(activeJob.id, resultsPage).catch(() => undefined);
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
    async (config: Config) => {
      setBusy(true);
      setError(null);
      try {
        const created = await apiFetch<{ job: Job }>(base, { method: 'POST', body: JSON.stringify(config) });
        setActiveJobId(created.job.id);
        setFilter('ready');
        setReason(null);
        setPanel(null);
        await refreshJobs();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка запуска');
      } finally {
        setBusy(false);
      }
    },
    [base, refreshJobs],
  );

  const manualRefresh = useCallback(async () => {
    await refreshJobs();
    if (activeJobId) await loadResults(activeJobId, resultsPage);
  }, [activeJobId, loadResults, refreshJobs, resultsPage]);

  const openPanel = useCallback(
    (initial: Config | null) => setPanel((prev) => ({ initial, seq: (prev?.seq ?? 0) + 1 })),
    [],
  );

  const handlePageChange = useCallback(
    (page: number) => {
      if (!activeJobId) return;
      const next = Math.min(Math.max(page, 1), totalPages);
      setResultsPage(next);
      void loadResults(activeJobId, next).catch((e) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'));
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
      const readyOnly = filter === 'ready' && !reason;
      const header = readyOnly ? adapter.csv.readyHeader : adapter.csv.fullHeader;
      const lines = [header.join(',')];
      for (const item of items) {
        lines.push((readyOnly ? adapter.csv.readyRow(item) : adapter.csv.fullRow(item)).map(csvCell).join(','));
      }
      downloadBlob(
        new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
        `${adapter.filePrefix}_${activeJobId.slice(0, 8)}.csv`,
      );
      setToast({ tone: 'success', message: `CSV: ${items.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [activeJobId, adapter, fetchAllResults, filter, reason]);

  /** Excel собирает сервер: CSV в Excel рассыпается на переносах строк и запятых в письмах. */
  const downloadXlsx = useCallback(
    async (url: string, suffix: string) => {
      if (!activeJobId) return;
      setActionsBusy(true);
      setExportProgress('Excel: собираю файл');
      try {
        const res = await authFetch(url);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Не удалось выгрузить (HTTP ${res.status})`);
        }
        downloadBlob(await res.blob(), `${adapter.filePrefix}_${suffix}${activeJobId.slice(0, 8)}.xlsx`);
        setToast({ tone: 'success', message: 'Excel готов' });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка выгрузки');
      } finally {
        setActionsBusy(false);
        setExportProgress(null);
      }
    },
    [activeJobId, adapter.filePrefix],
  );

  const stopJob = useCallback(async () => {
    if (!activeJobId) return;
    try {
      await apiFetch(`${base}/${activeJobId}`, { method: 'PATCH', body: JSON.stringify({ action: 'stop' }) });
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка остановки');
    }
  }, [activeJobId, base, refreshJobs]);

  const confirmDelete = useCallback(async () => {
    if (!deleteCandidate) return;
    try {
      await apiFetch(`${base}/${deleteCandidate}`, { method: 'DELETE' });
      if (activeJobId === deleteCandidate) {
        setActiveJobId(null);
        setResp(null);
      }
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления');
    } finally {
      setDeleteCandidate(null);
    }
  }, [activeJobId, base, deleteCandidate, refreshJobs]);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Закрыть" className="shrink-0 rounded p-0.5 text-red-400 transition hover:text-red-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'
          }`}
          role="status"
        >
          {toast.message}
        </div>
      ) : null}

      {jobs.length === 0 && scope !== 'mine' ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <div className="text-base font-semibold text-gray-900">Запусков ещё не было</div>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">{adapter.emptyDescription}</p>
          <button
            type="button"
            onClick={() => openPanel(null)}
            className="mt-4 inline-flex items-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
          >
            <Play className="mr-2 h-4 w-4" /> Новый запуск
          </button>
        </div>
      ) : (
        <WorkArea
          aside={
            <div className="space-y-2">
              <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm shadow-sm" role="tablist">
                {(['all', 'mine'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={scope === value}
                    onClick={() => changeScope(value)}
                    className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                      scope === value ? 'bg-violet-50 text-violet-700' : 'text-gray-500 hover:text-gray-900'
                    }`}
                  >
                    {value === 'all' ? 'Все запуски' : 'Мои'}
                  </button>
                ))}
              </div>
              <JobRail
                items={railItems}
                emptyText={scope === 'mine' ? 'У вас запусков ещё не было.' : undefined}
                activeId={activeJobId}
                onSelect={(id) => {
                  setActiveJobId(id);
                  setReason(null);
                }}
                onNew={() => openPanel(null)}
                onRefresh={() => void manualRefresh().catch((e) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'))}
                onRepeat={(id) => {
                  const job = jobs.find((j) => j.id === id);
                  if (job) openPanel(adapter.jobConfig(job));
                }}
                onDelete={(id) => setDeleteCandidate(id)}
              />
            </div>
          }
        >
          <OutreachRunResults
            adapter={adapter}
            job={activeJob}
            resp={resp}
            loading={resultsLoading}
            onRefresh={() => void manualRefresh().catch((e) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'))}
            loadAllRows={loadAllRows}
            currentPage={resultsPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            filter={filter}
            onFilterChange={(next) => {
              setFilter(next);
              setReason(null);
            }}
            reason={reason}
            onReasonChange={setReason}
            actionsBusy={actionsBusy}
            exportProgress={exportProgress}
            onExportCsv={() => void exportCsv()}
            onExportXlsx={() => {
              if (activeJobId) void downloadXlsx(adapter.xlsxUrl(activeJobId, filter), '');
            }}
            onExtraExport={(kind) => {
              if (activeJobId && adapter.extraExportUrl) void downloadXlsx(adapter.extraExportUrl(activeJobId, kind), `${kind}_`);
            }}
            onStopJob={activeJob?.id && activeOwn ? () => void stopJob() : undefined}
            onDeleteJob={activeJob?.id && activeOwn ? () => setDeleteCandidate(activeJob.id) : undefined}
            readOnly={!activeOwn}
          />
        </WorkArea>
      )}

      {panel
        ? <div key={panel.seq}>{adapter.renderLaunchPanel({ busy, initial: panel.initial, onClose: () => setPanel(null), onStart: (config) => void start(config) })}</div>
        : null}

      {deleteCandidate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-gray-900">Удалить запуск?</h3>
              <p className="mt-2 text-sm text-gray-600">{adapter.deleteDescription}</p>
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
