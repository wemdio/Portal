'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, RefreshCw, Square, Trash2 } from 'lucide-react';
import { CHAIN_LABELS, REASON_LABELS, type ChainType, type RuOutreachConfig, type Stage } from '@/lib/polzaRuOutreach/types';
import { LaunchForm } from './LaunchForm';
import { Libraries } from './Libraries';
import { Funnel, ResultsTable } from './Results';
import { API, api, downloadFile, fmtDateTime, type RuJob, type RuRow } from './shared';

type Tab = 'launch' | 'libraries';
type Filter = 'ready' | 'manual_review' | 'rejected' | 'all';

const FILTERS: Array<[Filter, string]> = [
  ['ready', 'Готовые'],
  ['manual_review', 'Ручная проверка'],
  ['rejected', 'Отсеянные'],
  ['all', 'Все'],
];
const PAGE = 50;

const JOB_STATUS: Record<RuJob['status'], string> = {
  pending: 'в очереди',
  running: 'идёт',
  completed: 'готов',
  failed: 'остановлен / ошибка',
};

type Sender = { id: string; sender_name: string; sender_title: string | null; is_default: boolean; status: string };
type ResultsResponse = {
  items: RuRow[];
  count: number;
  funnel: Record<Stage, number>;
  reason_counts: Record<string, number>;
  status_counts: Record<string, number>;
};

export function PolzaRuOutreachView() {
  const [tab, setTab] = useState<Tab>('launch');
  const [jobs, setJobs] = useState<RuJob[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ready');
  const [reason, setReason] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const active = useMemo(() => jobs.find((j) => j.id === activeId) ?? null, [jobs, activeId]);
  const running = active?.status === 'running' || active?.status === 'pending';

  useEffect(() => {
    if (!error) return undefined;
    const t = window.setTimeout(() => setError(null), 15_000);
    return () => window.clearTimeout(t);
  }, [error]);

  const loadJobs = useCallback(async () => {
    const data = await api<{ jobs: RuJob[] }>(API);
    setJobs(data.jobs ?? []);
    setActiveId((prev) => prev ?? data.jobs?.[0]?.id ?? null);
  }, []);

  const loadSenders = useCallback(async () => {
    const data = await api<{ senders: Sender[] }>(`${API}/libraries`);
    setSenders(data.senders ?? []);
  }, []);

  const loadResults = useCallback(async () => {
    if (!activeId) return;
    setLoadingResults(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) });
      if (reason) params.set('reason', reason);
      else if (filter !== 'all') params.set('status', filter);
      setResults(await api<ResultsResponse>(`${API}/${activeId}/results?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки результатов');
    } finally {
      setLoadingResults(false);
    }
  }, [activeId, filter, reason, page]);

  useEffect(() => {
    // Загрузка данных при открытии страницы — запрос во внешнюю систему.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs().catch((e) => setError(e instanceof Error ? e.message : 'Ошибка загрузки'));
    loadSenders().catch(() => undefined);
  }, [loadJobs, loadSenders]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadResults();
  }, [loadResults]);

  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => {
      void loadJobs();
      void loadResults();
    }, 5000);
    return () => window.clearInterval(id);
  }, [running, loadJobs, loadResults]);

  const start = async (config: Partial<RuOutreachConfig>) => {
    setBusy(true);
    setError(null);
    try {
      const { job } = await api<{ job: RuJob }>(API, { method: 'POST', body: JSON.stringify(config) });
      setActiveId(job.id);
      setFilter('ready');
      setReason(null);
      setPage(1);
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запуска');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!activeId) return;
    try {
      await api(`${API}/${activeId}`, { method: 'PATCH', body: JSON.stringify({ action: 'stop' }) });
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка остановки');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить запуск вместе с журналом?')) return;
    try {
      await api(`${API}/${id}`, { method: 'DELETE' });
      if (id === activeId) setActiveId(null);
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка удаления');
    }
  };

  const exportFile = async (kind: 'ready' | 'journal') => {
    if (!activeId) return;
    setExporting(kind);
    try {
      await downloadFile(`${API}/${activeId}/export?kind=${kind}`, `nash-autooutreach-${kind}-${activeId.slice(0, 8)}.xlsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка выгрузки');
    } finally {
      setExporting(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil((results?.count ?? 0) / PAGE));
  const detail = active?.progress_detail ?? null;

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
        {(
          [
            ['launch', 'Запуск'],
            ['libraries', 'Библиотеки'],
          ] as Array<[Tab, string]>
        ).map(([t, l]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium ${tab === t ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      {tab === 'libraries' ? (
        <Libraries onError={setError} onSendersChanged={() => void loadSenders()} />
      ) : (
        <>
          <LaunchForm busy={busy} senders={senders} onStart={start} />

          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-900">Запуски</div>
              <button type="button" onClick={() => void loadJobs()} className="rounded-md p-1 text-gray-500 hover:bg-gray-100" aria-label="Обновить">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            {jobs.length === 0 ? (
              <div className="text-sm text-gray-500">Запусков ещё не было.</div>
            ) : (
              <div className="max-h-64 divide-y divide-gray-100 overflow-y-auto">
                {jobs.map((j) => (
                  <div
                    key={j.id}
                    onClick={() => {
                      setActiveId(j.id);
                      setPage(1);
                      setReason(null);
                    }}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-2 py-2 text-sm ${j.id === activeId ? 'bg-violet-50' : 'hover:bg-gray-50'}`}
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-gray-900">Запуск на {j.config?.limit ?? '—'}</span>
                      <span className="ml-2 text-xs text-gray-500">{fmtDateTime(j.created_at)}</span>
                      <span className="ml-2 text-xs text-gray-500">
                        готово {j.total_parsed ?? 0} из {j.config?.limit ?? '—'} · просмотрено {j.total_found ?? 0}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-gray-500">{JOB_STATUS[j.status]}</span>
                      {j.status !== 'running' && j.status !== 'pending' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(j.id);
                          }}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                          aria-label="Удалить запуск"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {active && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-gray-700">
                  <b>Запуск</b> · {JOB_STATUS[active.status]}
                  {running && <> · {active.progress_percent ?? 0}% · в пуле {detail?.pool ?? '…'} компаний</>}
                  {detail?.stop_reason === 'pool_exhausted' && ' · кандидаты закончились раньше лимита'}
                  {detail?.stop_reason === 'scan_limit' && ' · достигнут потолок просмотра'}
                  {active.status === 'failed' && active.error_message ? ` · ${active.error_message}` : ''}
                </div>
                <div className="flex gap-2">
                  {running && (
                    <button type="button" onClick={stop} className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                      <Square className="mr-1.5 h-4 w-4" /> Остановить
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={exporting !== null}
                    onClick={() => void exportFile('ready')}
                    className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {exporting === 'ready' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
                    Excel: готовые
                  </button>
                  <button
                    type="button"
                    disabled={exporting !== null}
                    onClick={() => void exportFile('journal')}
                    className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {exporting === 'journal' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
                    Excel: журнал
                  </button>
                </div>
              </div>

              {detail?.chains && Object.keys(detail.chains).length > 0 && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="text-gray-500">Цепочки после скоринга:</span>
                  {Object.entries(detail.chains).map(([c, n]) => (
                    <span key={c} className="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">
                      {CHAIN_LABELS[c as ChainType] ?? c}: {n}
                    </span>
                  ))}
                </div>
              )}

              <Funnel
                funnel={results?.funnel ?? null}
                reasons={results?.reason_counts ?? null}
                onReason={(code) => {
                  setReason(code);
                  setPage(1);
                }}
              />

              <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map(([f, l]) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      setFilter(f);
                      setReason(null);
                      setPage(1);
                    }}
                    className={`rounded-full px-3 py-1 text-sm ${!reason && filter === f ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                  >
                    {l}
                    {f !== 'all' && results?.status_counts?.[f] != null ? ` · ${results.status_counts[f]}` : ''}
                  </button>
                ))}
                {reason && (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-sm text-amber-800">
                    Причина: {REASON_LABELS[reason] ?? reason}
                    <button type="button" className="ml-2 text-amber-900" onClick={() => setReason(null)}>
                      ×
                    </button>
                  </span>
                )}
                {loadingResults && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
              </div>

              <ResultsTable rows={results?.items ?? []} />

              {totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 text-sm">
                  <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-2 py-1 disabled:opacity-40">
                    ←
                  </button>
                  <span className="text-gray-600">
                    {page} / {totalPages}
                  </span>
                  <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border px-2 py-1 disabled:opacity-40">
                    →
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
