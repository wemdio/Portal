'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import type { RuOutreachConfig } from '@/lib/polzaRuOutreach/types';
import { JobDetail } from './JobDetail';
import { JobList } from './JobList';
import { LaunchPanel } from './LaunchPanel';
import { Libraries } from './Libraries';
import { WorkArea } from '@/components/ui/WorkArea';
import { API, RESULTS_PAGE, api, downloadFile, type ResultsFilter, type ResultsResponse, type RuJob } from './shared';

type Tab = 'launch' | 'libraries';

type Sender = { id: string; sender_name: string; sender_title: string | null; is_default: boolean; status: string };

/** Открытая панель запуска: `initial` не пуст, когда жмут «Повторить». */
interface PanelState {
  initial: Partial<RuOutreachConfig> | null;
  /** Растёт на каждое открытие — панель пересоздаётся с новыми значениями полей. */
  seq: number;
}

export function PolzaRuOutreachView() {
  const [tab, setTab] = useState<Tab>('launch');
  const [jobs, setJobs] = useState<RuJob[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ResultsFilter>('ready');
  const [reason, setReason] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);

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
      const params = new URLSearchParams({ limit: String(RESULTS_PAGE), offset: String((page - 1) * RESULTS_PAGE) });
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

  const openPanel = (initial: Partial<RuOutreachConfig> | null) => setPanel((prev) => ({ initial, seq: (prev?.seq ?? 0) + 1 }));

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
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <div className="text-base font-semibold text-gray-900">Запусков ещё не было</div>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
            Система соберёт компании по свежим поводам, отберёт по скорингу, найдёт почту и напишет цепочку писем. Письма не отправляются — на
            выходе таблица и Excel.
          </p>
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
            <JobList
              jobs={jobs}
              activeId={activeId}
              onSelect={(id) => {
                setActiveId(id);
                setPage(1);
                setReason(null);
              }}
              onNew={() => openPanel(null)}
              onRepeat={(job) => openPanel(job.config ?? null)}
              onDelete={(id) => void remove(id)}
              onRefresh={() => void loadJobs()}
            />
          }
        >
          {active ? (
            <JobDetail
              job={active}
              results={results}
              loading={loadingResults}
              exporting={exporting}
              filter={filter}
              reason={reason}
              page={page}
              onFilter={setFilter}
              onReason={setReason}
              onPage={setPage}
              onStop={() => void stop()}
              onExport={(kind) => void exportFile(kind)}
            />
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 shadow-sm">Выберите запуск слева.</div>
          )}
        </WorkArea>
      )}

      {panel && (
        <LaunchPanel
          key={panel.seq}
          open
          busy={busy}
          senders={senders}
          initial={panel.initial}
          onClose={() => setPanel(null)}
          onStart={(config) => void start(config)}
        />
      )}
    </div>
  );
}
