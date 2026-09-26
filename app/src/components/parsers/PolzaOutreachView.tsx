'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import type { PolzaOutreachCompanyRow, PolzaOutreachConfig, PolzaOutreachFunnel, PolzaOutreachParserJob } from '@/types';
import type { OutreachLlmBudgetSnapshot } from '@/lib/outreachLlm/types';
import { PolzaOutreachLaunchPanel } from '@/components/parsers/PolzaOutreachLaunchPanel';
import { PolzaOutreachResults } from '@/components/parsers/PolzaOutreachResults';
import { JobRail, type JobRailItem } from '@/components/ui/JobRail';
import { WorkArea } from '@/components/ui/WorkArea';

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

/**
 * Файл для отправки: компания, куда писать и что писать.
 *
 * Полная выгрузка со статусами, причинами отсева и цитатами нужна, когда
 * разбираешься, почему выход такой. Для рассылки это мусор: список уходит в
 * автоматическую отправку, и каждая лишняя колонка — это лишняя развилка при
 * импорте.
 */
const READY_EXPORT_HEADER = [
  'company_name',
  'email',
  'domain',
  'job_country',
  'job_title',
  'job_url',
  'letter_1_subject',
  'letter_1_body',
  'letter_2_subject',
  'letter_2_body',
  'letter_3_subject',
  'letter_3_body',
  'letter_4_subject',
  'letter_4_body',
];

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

/** Дата запуска в колонке: день, месяц и время — этого хватает, чтобы отличить соседние. */
function fmtJobDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Расход на ИИ и причина остановки из progress_detail запуска. Поле — jsonb
 * без схемы (у старых запусков его нет вовсе), поэтому форму проверяем здесь,
 * а не верим типу.
 */
function runSummary(job: PolzaOutreachParserJob | null): { llm: OutreachLlmBudgetSnapshot | null; stopReason: string | null } {
  const detail = job?.progress_detail as Record<string, unknown> | null | undefined;
  const llm = detail?.llm as Partial<OutreachLlmBudgetSnapshot> | null | undefined;
  const valid = typeof llm?.spent_usd === 'number' && typeof llm?.limit_usd === 'number' && typeof llm?.calls === 'number';
  return {
    llm: valid ? (llm as OutreachLlmBudgetSnapshot) : null,
    stopReason: typeof detail?.stop_reason === 'string' ? detail.stop_reason : null,
  };
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

function readyExportRow(row: PolzaOutreachCompanyRow) {
  const letters = row.letters ?? [];
  const letter = (n: number, field: 'subject' | 'body') => letters.find((l) => l.n === n)?.[field] ?? '';
  return [
    row.company_name,
    row.selected_company_email ?? '',
    row.normalized_domain ?? '',
    row.job_country_code ?? '',
    row.job_title ?? '',
    row.job_source_url ?? '',
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
  const [panel, setPanel] = useState<{ initial: PolzaOutreachConfig | null; seq: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const [results, setResults] = useState<PolzaOutreachCompanyRow[]>([]);
  const [resultsCount, setResultsCount] = useState(0);
  const [funnel, setFunnel] = useState<PolzaOutreachFunnel | null>(null);
  const [exclusionCounts, setExclusionCounts] = useState<Record<string, number> | null>(null);
  const [resultsPage, setResultsPage] = useState(1);
  // Режим отправки включён с самого начала: инструмент существует ради
  // готовых строк, а отсеянные компании нужны раз в десять запусков — когда
  // разбираешься, почему выход меньше заказа. Они не исчезли, их показывает
  // «Показать отсеянные».
  const [readyOnly, setReadyOnly] = useState(true);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeJobId) ?? null, [activeJobId, jobs]);
  const activeSummary = useMemo(() => runSummary(activeJob), [activeJob]);

  const railItems = useMemo<JobRailItem[]>(
    () =>
      jobs.map((job) => {
        const target = job.config?.limit ?? null;
        const done = job.total_parsed ?? 0;
        return {
          id: job.id,
          status: job.status,
          title: target ? `На ${target} компаний` : 'Запуск',
          subtitle: `${fmtJobDate(job.created_at)} · готово ${done}${target ? ` из ${target}` : ''}`,
          percent: job.status === 'completed' ? 100 : job.progress_percent ?? 0,
          deletable: job.status !== 'running' && job.status !== 'pending',
        };
      }),
    [jobs],
  );

  // Полосу ошибки читают один раз, а места она занимала до перезагрузки
  // страницы — и следующая ошибка падала поверх прежней.
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const totalPages = Math.max(1, Math.ceil(resultsCount / RESULTS_LIMIT));

  const refreshJobs = useCallback(async () => {
    const data = await apiFetch<JobsResponse>('/api/parsers/polza-outreach', { method: 'GET' });
    setJobs(data.jobs ?? []);
    setActiveJobId((prev) => prev ?? data.jobs?.[0]?.id ?? null);
  }, []);

  const statusQuery = readyOnly ? '&status=ready' : '';

  const loadResults = useCallback(async (jobId: string, page: number) => {
    setResultsLoading(true);
    try {
      const offset = Math.max(0, (page - 1) * RESULTS_LIMIT);
      const data = await apiFetch<ResultsResponse>(
        `/api/parsers/polza-outreach/${jobId}/results?limit=${RESULTS_LIMIT}&offset=${offset}${statusQuery}`,
        { method: 'GET' },
      );
      setResultsCount(data.count ?? 0);
      setResults(data.items ?? []);
      setFunnel(data.funnel ?? null);
      setExclusionCounts(data.exclusion_counts ?? null);
    } finally {
      setResultsLoading(false);
    }
  }, [statusQuery]);

  /**
   * Все строки прогона — для разбора этапа.
   *
   * Таблица листается по полусотне, а этап — это про весь прогон: показывать
   * его по строкам, случайно оказавшихся на текущей странице, значило бы
   * отвечать не на тот вопрос. Потолок ручки — тысяча строк, лимит запуска —
   * триста компаний, так что в один запрос прогон помещается целиком.
   */
  const loadAllRows = useCallback(async (): Promise<PolzaOutreachCompanyRow[]> => {
    if (!activeJobId) return [];
    const data = await apiFetch<ResultsResponse>(
      `/api/parsers/polza-outreach/${activeJobId}/results?limit=1000&offset=0`,
      { method: 'GET' },
    );
    return data.items ?? [];
  }, [activeJobId]);

  const fetchAllResults = useCallback(async (jobId: string) => {
    const all: PolzaOutreachCompanyRow[] = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const data = await apiFetch<ResultsResponse>(
        `/api/parsers/polza-outreach/${jobId}/results?limit=${EXPORT_LIMIT}&offset=${offset}${statusQuery}`,
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
  }, [statusQuery]);

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
    await refreshJobs();
    if (activeJobId) await loadResults(activeJobId, resultsPage);
  }, [activeJobId, loadResults, refreshJobs, resultsPage]);

  const openPanel = useCallback(
    (initial: PolzaOutreachConfig | null) => setPanel((prev) => ({ initial, seq: (prev?.seq ?? 0) + 1 })),
    [],
  );

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
      const header = readyOnly ? READY_EXPORT_HEADER : EXPORT_HEADER;
      const lines = [header.join(',')];
      for (const item of items) {
        lines.push((readyOnly ? readyExportRow(item) : exportRow(item)).map(csvCell).join(','));
      }
      downloadBlob('\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8', `polza_outreach_${activeJobId.slice(0, 8)}.csv`);
      setToast({ tone: 'success', message: `CSV: ${items.length} строк` });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [activeJobId, fetchAllResults, readyOnly]);

  /**
   * Excel собирает сервер и отдаёт готовым файлом.
   *
   * CSV открывают в Excel, и там он рассыпается: письма содержат переносы
   * строк и запятые, а локаль путает разделитель. Тащить exceljs в браузер
   * ради этого незачем — он тяжёлый, и на странице парсеров ему делать нечего.
   */
  const exportXlsx = useCallback(async () => {
    if (!activeJobId) return;
    setActionsBusy(true);
    setExportProgress('Excel: собираю файл');
    try {
      const res = await authFetch(
        `/api/parsers/polza-outreach/${activeJobId}/export${readyOnly ? '?status=ready' : ''}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Не удалось выгрузить (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `polza_outreach_${activeJobId.slice(0, 8)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setToast({ tone: 'success', message: 'Excel готов' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка выгрузки');
    } finally {
      setActionsBusy(false);
      setExportProgress(null);
    }
  }, [activeJobId, readyOnly]);

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
      {/* Полоса ошибки висела до перезагрузки страницы: прочитали один раз, а
          место она занимала всегда — и поверх неё падала следующая. Теперь
          уходит сама через 15 секунд, и её можно закрыть раньше. */}
      {error ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Закрыть"
            className="shrink-0 rounded p-0.5 text-red-400 transition hover:text-red-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
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
          {toast.message}
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <div className="text-base font-semibold text-gray-900">Запусков ещё не было</div>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
            Соберём B2B-компании с поводом написать — найм в sales/GTM или свежий батч YC, — отберём по Lead Score, найдём почту и напишем
            цепочку из четырёх писем на английском. Без отправки: на выходе таблица и выгрузка.
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
          <JobRail
            items={railItems}
            activeId={activeJobId}
            onSelect={(id) => setActiveJobId(id)}
            onNew={() => openPanel(null)}
            onRefresh={() => void manualRefresh()}
            onRepeat={(id) => {
              const job = jobs.find((j) => j.id === id);
              if (job) openPanel(job.config ?? null);
            }}
            onDelete={(id) => setDeleteCandidate(id)}
          />
        }
      >
        <PolzaOutreachResults
          items={results}
          count={resultsCount}
          funnel={funnel}
          exclusionCounts={exclusionCounts}
          loading={resultsLoading}
          jobStatus={activeJob?.status ?? null}
          jobError={activeJob?.error_message ?? null}
          llmSpend={activeSummary.llm}
          stopReason={activeSummary.stopReason}
          loadAllRows={activeJobId ? loadAllRows : undefined}
          currentPage={resultsPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          readyOnly={readyOnly}
          onReadyOnlyChange={setReadyOnly}
          actionsBusy={actionsBusy}
          exportProgress={exportProgress}
          onExportCsv={() => void exportCsv()}
          onExportXlsx={() => void exportXlsx()}
          onStopJob={activeJob?.id ? () => void stopJob() : undefined}
          onDeleteJob={activeJob?.id ? () => setDeleteCandidate(activeJob.id) : undefined}
        />
      </WorkArea>
      )}

      {panel ? (
        <PolzaOutreachLaunchPanel
          key={panel.seq}
          busy={busy}
          initial={panel.initial}
          onClose={() => setPanel(null)}
          onStart={start}
        />
      ) : null}

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
