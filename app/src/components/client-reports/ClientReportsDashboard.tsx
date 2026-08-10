'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, RefreshCw } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import {
  CLIENT_REPORT_EXPORT_POLL_INTERVAL_MS,
  CLIENT_REPORT_EXPORT_POLL_TIMEOUT_MS,
  isActiveClientReportExportStatus,
} from '@/lib/clientReports/exportLifecycle';
import type {
  ClientReportAnalyticsResponse,
  ClientReportExportStatus,
} from '@/lib/clientReports/types';

export type PeriodPreset = '7d' | '30d' | 'current' | 'previous' | 'custom';
type ScoreFilter = 'all' | 'A' | 'B' | 'C';
type ExportKind = 'rejected' | 'working' | 'submitted';

interface ReportQueryFilters {
  from: string;
  to: string;
  score: ScoreFilter;
  campaign: string;
}

type AnalyticsResponse = ClientReportAnalyticsResponse;

interface ExportJob {
  id: string;
  status: ClientReportExportStatus;
  downloadUrl?: string | null;
  error?: string | null;
}

type ExportJobResponse = { job: ExportJob } | ExportJob;
type RequestStatus = 'loading' | 'refreshing' | 'ready' | 'error';
type ExportStatus = 'idle' | 'working' | 'completed' | 'error';

const NUMBER_FORMATTER = new Intl.NumberFormat('ru-RU');
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const PERIODS: Array<{ value: PeriodPreset; label: string }> = [
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'current', label: 'Текущий месяц' },
  { value: 'previous', label: 'Прошлый месяц' },
  { value: 'custom', label: 'Свои даты' },
];

const SCORES: Array<{ value: ScoreFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
];

const API_PRESETS: Record<PeriodPreset, string> = {
  '7d': 'last_7_days',
  '30d': 'last_30_days',
  current: 'current_month',
  previous: 'previous_month',
  custom: 'custom',
};

const EXPORTS: Array<{
  kind: ExportKind;
  title: string;
  description: string;
  buttonLabel: string;
}> = [
  {
    kind: 'rejected',
    title: 'Не подошли по скору',
    description: 'Выгрузка всегда включает все компании, которые не попали в A, B или C за выбранный период. Фильтры скора и кампании к ней не применяются.',
    buttonLabel: 'Выгрузить неподходящие',
  },
  {
    kind: 'working',
    title: 'Рабочий скор',
    description: 'Все строки с целевым скором за период. Фильтр кампании применяется только к выгрузке «Переданы в работу».',
    buttonLabel: 'Выгрузить рабочий скор',
  },
  {
    kind: 'submitted',
    title: 'Переданы в работу',
    description: 'Исторический журнал загрузок, который не зависит от очистки контактов в сервисе рассылки.',
    buttonLabel: 'Выгрузить переданные',
  },
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function shiftDays(value: string, days: number): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

function businessToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function resolveDateRange(
  preset: Exclude<PeriodPreset, 'custom'>,
  today = businessToday(),
): { from: string; to: string } {
  const date = parseIsoDate(today);
  if (!date) throw new Error('Некорректная дата для периода');

  if (preset === '7d') return { from: shiftDays(today, -6), to: today };
  if (preset === '30d') return { from: shiftDays(today, -29), to: today };
  if (preset === 'current') {
    return { from: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`, to: today };
  }

  const previousMonthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  return {
    from: `${previousMonthEnd.getUTCFullYear()}-${pad(previousMonthEnd.getUTCMonth() + 1)}-01`,
    to: formatIsoDate(previousMonthEnd),
  };
}

function parsePreset(value: string | null): PeriodPreset {
  return PERIODS.some((item) => item.value === value) ? value as PeriodPreset : '30d';
}

function parseScore(value: string | null): ScoreFilter {
  return value === 'A' || value === 'B' || value === 'C' ? value : 'all';
}

function normalizeCount(value: number | null | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function formatCount(value: number | null | undefined): string {
  return NUMBER_FORMATTER.format(normalizeCount(value));
}

function formatFreshness(value: string | null | undefined): string {
  if (!value) return 'нет данных';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'нет данных';
  return DATE_TIME_FORMATTER.format(date);
}

function conversion(current: number, previous: number | null): string {
  if (previous === null || previous <= 0) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format((current / previous) * 100)}%`;
}

function unwrapJob(response: ExportJobResponse): ExportJob {
  return 'job' in response ? response.job : response;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function triggerDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ClientReportsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const today = useMemo(() => businessToday(), []);

  const preset = parsePreset(searchParams.get('period'));
  const score = parseScore(searchParams.get('score'));
  const campaign = searchParams.get('campaign')?.trim() || 'all';
  const presetRange = resolveDateRange(preset === 'custom' ? '30d' : preset, today);
  const requestedFrom = searchParams.get('from') ?? '';
  const requestedTo = searchParams.get('to') ?? '';
  const validCustomRange = Boolean(
    parseIsoDate(requestedFrom)
    && parseIsoDate(requestedTo)
    && requestedFrom <= requestedTo,
  );
  const from = preset === 'custom' && validCustomRange ? requestedFrom : presetRange.from;
  const to = preset === 'custom' && validCustomRange ? requestedTo : presetRange.to;
  const filters = useMemo<ReportQueryFilters>(() => ({ from, to, score, campaign }), [from, to, score, campaign]);

  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [dateError, setDateError] = useState('');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const dataRef = useRef<AnalyticsResponse | null>(null);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>('loading');
  const [requestError, setRequestError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const requestSequence = useRef(0);
  const exportControllers = useRef(new Set<AbortController>());
  const [exportStates, setExportStates] = useState<Record<ExportKind, { status: ExportStatus; message: string }>>({
    rejected: { status: 'idle', message: '' },
    working: { status: 'idle', message: '' },
    submitted: { status: 'idle', message: '' },
  });

  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
    setDateError('');
  }, [from, to]);

  const replaceFilters = useCallback((next: ReportQueryFilters & { period: PeriodPreset }) => {
    const query = new URLSearchParams({
      period: next.period,
      from: next.from,
      to: next.to,
      score: next.score,
      campaign: next.campaign,
    });
    router.replace(`/client/reports?${query.toString()}`);
  }, [router]);

  const choosePeriod = useCallback((nextPreset: PeriodPreset) => {
    if (nextPreset === 'custom') {
      replaceFilters({ ...filters, period: 'custom', from: draftFrom, to: draftTo });
      return;
    }
    const range = resolveDateRange(nextPreset, today);
    setDraftFrom(range.from);
    setDraftTo(range.to);
    replaceFilters({ ...filters, ...range, period: nextPreset });
  }, [draftFrom, draftTo, filters, replaceFilters, today]);

  const applyCustomDates = useCallback((nextFrom: string, nextTo: string) => {
    if (!parseIsoDate(nextFrom) || !parseIsoDate(nextTo)) return;
    if (nextFrom > nextTo) {
      setDateError('Дата начала должна быть раньше даты окончания');
      return;
    }
    setDateError('');
    replaceFilters({ ...filters, period: 'custom', from: nextFrom, to: nextTo });
  }, [filters, replaceFilters]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    setRequestStatus(dataRef.current ? 'refreshing' : 'loading');
    setRequestError('');

    const query = new URLSearchParams({
      preset: API_PRESETS[preset],
      from: filters.from,
      to: filters.to,
      score: filters.score,
    });
    if (filters.campaign !== 'all') query.set('campaign', filters.campaign);

    clientApiFetch<AnalyticsResponse>(`/reports/analytics?${query.toString()}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        dataRef.current = response;
        setData(response);
        setRequestStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setRequestError(errorMessage(error, 'Не удалось загрузить воронку базы'));
        setRequestStatus('error');
      });

    return () => controller.abort();
  }, [filters.from, filters.to, filters.score, filters.campaign, preset, reloadToken]);

  useEffect(() => () => {
    exportControllers.current.forEach((controller) => controller.abort());
    exportControllers.current.clear();
  }, []);

  const startExport = useCallback(async (kind: ExportKind) => {
    const controller = new AbortController();
    exportControllers.current.add(controller);
    setExportStates((current) => ({
      ...current,
      [kind]: { status: 'working', message: 'Готовим файл…' },
    }));

    try {
      const exportFilters = {
        preset: API_PRESETS[preset],
        from: filters.from,
        to: filters.to,
        score: filters.score,
        ...(filters.campaign === 'all' ? {} : { campaign: filters.campaign }),
      };
      const created = await clientApiFetch<ExportJobResponse>('/reports/exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, filters: exportFilters }),
        signal: controller.signal,
      });
      let job = unwrapJob(created);
      const pollDeadline = Date.now() + CLIENT_REPORT_EXPORT_POLL_TIMEOUT_MS;

      while (!controller.signal.aborted) {
        if (job.status === 'completed') {
          if (!job.downloadUrl) throw new Error('Файл готов, но ссылка на скачивание не получена');
          triggerDownload(job.downloadUrl);
          setExportStates((current) => ({
            ...current,
            [kind]: { status: 'completed', message: 'Скачивание началось' },
          }));
          return;
        }
        if (job.status === 'failed') throw new Error(job.error || 'Не удалось подготовить выгрузку');
        if (job.status === 'cancelled') {
          throw new Error('Выгрузка отменена. Запустите её повторно.');
        }
        if (!isActiveClientReportExportStatus(job.status)) {
          throw new Error('Выгрузка вернула неизвестный статус. Запустите её повторно.');
        }
        if (Date.now() >= pollDeadline) {
          throw new Error('Выгрузка готовится дольше 30 минут. Её можно запустить повторно позже.');
        }

        const response = await clientApiFetch<ExportJobResponse>(
          `/reports/exports/${encodeURIComponent(job.id)}`,
          { signal: controller.signal },
        );
        job = unwrapJob(response);
        if (isActiveClientReportExportStatus(job.status)) {
          const remainingMs = pollDeadline - Date.now();
          if (remainingMs > 0) {
            await sleep(Math.min(CLIENT_REPORT_EXPORT_POLL_INTERVAL_MS, remainingMs), controller.signal);
          }
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setExportStates((current) => ({
        ...current,
        [kind]: { status: 'error', message: errorMessage(error, 'Не удалось подготовить выгрузку') },
      }));
    } finally {
      exportControllers.current.delete(controller);
    }
  }, [filters, preset]);

  const funnelRows = data ? [
    { label: 'Отскорено компаний', value: data.funnel.scoredCompanies, unit: 'компаний' },
    { label: 'Получили рабочий скор', value: data.funnel.workingScoreCompanies, unit: 'компаний' },
    { label: 'Найдена почта', value: data.funnel.emailFoundCompanies, unit: 'компаний' },
    { label: 'Почта прошла валидацию', value: data.funnel.validatedEmails, unit: 'email' },
    { label: 'Передано из этой когорты', value: data.funnel.submittedContacts, unit: 'контактов' },
    { label: 'Принято из этой когорты', value: data.funnel.confirmedContacts, unit: 'контактов' },
  ] : [];
  const qualityNotices = data?.qualityNotices?.length
    ? data.qualityNotices
    : data?.legacyNotice
      ? [data.legacyNotice]
      : [];

  const empty = Boolean(data)
    && funnelRows.every((row) => normalizeCount(row.value) === 0)
    && (data?.funnel.byCampaign.length ?? 0) === 0;

  return (
    <main className="mx-auto max-w-6xl pb-10" aria-busy={requestStatus === 'loading' || requestStatus === 'refreshing'}>
      <header className="mb-6 sm:mb-8">
        <p className="ds-eyebrow mb-2">02 → Мониторинг</p>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="m-0 text-2xl font-semibold tracking-tight sm:text-3xl" style={{ color: 'var(--cp-paper)' }}>
              Воронка базы
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: 'var(--cp-paper-mute)' }}>
              Путь компаний от скоринга до подтверждённой передачи контактов в кампании.
            </p>
            <p className="mt-2 max-w-2xl text-xs leading-5" style={{ color: 'var(--cp-paper-faint)' }}>
              Отправки, открытия, ответы и лиды смотрите в разделе{' '}
              <Link className="underline underline-offset-2" href="/client">
                Кампании
              </Link>
              .
            </p>
          </div>
          {data && (
            <p className="ds-mono text-[11px] leading-5" style={{ color: 'var(--cp-paper-faint)' }}>
              Воронка: {formatFreshness(data.freshness.pipelineAt)}
            </p>
          )}
        </div>
      </header>

      <section className="ds-card mb-6 p-4 sm:p-5" aria-labelledby="report-filters-title">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="report-filters-title" className="ds-eyebrow">Фильтры</h2>
          {requestStatus === 'refreshing' && (
            <span className="ds-mono text-[11px]" role="status" style={{ color: 'var(--cp-paper-faint)' }}>
              Обновляем…
            </span>
          )}
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,.65fr)_minmax(220px,.85fr)]">
          <div>
            <p className="mb-2 text-xs font-medium" style={{ color: 'var(--cp-paper-mute)' }}>Период</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Период">
              {PERIODS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={preset === item.value}
                  className={`${preset === item.value ? 'ds-btn-primary' : 'ds-btn-secondary'} whitespace-nowrap`}
                  onClick={() => choosePeriod(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-sm">
              <label className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                <span className="mb-1.5 block">С</span>
                <input
                  className="ds-input w-full"
                  type="date"
                  value={draftFrom}
                  max={today}
                  aria-describedby={dateError ? 'report-date-error' : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraftFrom(value);
                    applyCustomDates(value, draftTo);
                  }}
                />
              </label>
              <label className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                <span className="mb-1.5 block">По</span>
                <input
                  className="ds-input w-full"
                  type="date"
                  value={draftTo}
                  max={today}
                  aria-describedby={dateError ? 'report-date-error' : undefined}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraftTo(value);
                    applyCustomDates(draftFrom, value);
                  }}
                />
              </label>
            </div>
            {dateError && (
              <p id="report-date-error" className="mt-2 text-xs" style={{ color: 'var(--cp-red)' }}>
                {dateError}
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium" style={{ color: 'var(--cp-paper-mute)' }}>Скор</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Скор">
              {SCORES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={score === item.value}
                  className={score === item.value ? 'ds-btn-primary' : 'ds-btn-secondary'}
                  onClick={() => replaceFilters({ ...filters, period: preset, score: item.value })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <label className="text-xs font-medium" style={{ color: 'var(--cp-paper-mute)' }}>
            <span className="mb-2 block">Кампания после передачи</span>
            <select
              className="ds-input w-full"
              value={campaign}
              aria-label="Кампания после передачи"
              onChange={(event) => replaceFilters({ ...filters, period: preset, campaign: event.target.value })}
            >
              <option value="all">Все кампании</option>
              {campaign !== 'all' && !data?.campaigns.some((item) => item.id === campaign) && (
                <option value={campaign}>Выбранная кампания</option>
              )}
              {(data?.campaigns ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="mt-2 block text-[11px] font-normal leading-4" style={{ color: 'var(--cp-paper-faint)' }}>
              Фильтр кампании действует с этапа передачи контактов.
            </span>
          </label>
        </div>
      </section>

      {requestError && (
        <div className="ds-card mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <div className="flex items-start gap-3">
            <span className="ds-status-dot mt-1.5" aria-hidden style={{ background: 'var(--cp-red)' }} />
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>Не удалось обновить воронку базы</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>{requestError}</p>
            </div>
          </div>
          <button
            type="button"
            className="ds-btn-secondary inline-flex items-center justify-center gap-2"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Повторить
          </button>
        </div>
      )}

      {requestStatus === 'loading' && !data && (
        <div className="ds-card mb-6 px-5 py-12 text-center" role="status" aria-label="Загрузка воронки базы">
          <p className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>Загружаем воронку базы…</p>
          <p className="mt-2 text-xs" style={{ color: 'var(--cp-paper-faint)' }}>Сводим скоринг, поиск почт и передачу в кампании.</p>
        </div>
      )}

      {data && (
        <>
          {qualityNotices.length > 0 && (
            <aside className="ds-card mb-6 flex items-start gap-3 p-4" role="region" aria-label="Ограничения данных">
              <span className="ds-status-dot mt-1.5" aria-hidden style={{ background: 'var(--cp-amber)' }} />
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>Ограничения данных</p>
                <ul className="mt-1 space-y-1 text-xs leading-5" style={{ color: 'var(--cp-paper-mute)' }}>
                  {qualityNotices.map((notice) => <li key={notice}>— {notice}</li>)}
                </ul>
              </div>
            </aside>
          )}

          {empty && (
            <div className="ds-card mb-6 px-5 py-9 text-center">
              <p className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>За выбранный период данных нет</p>
              <p className="mt-2 text-xs" style={{ color: 'var(--cp-paper-faint)' }}>Измените период, скор или кампанию.</p>
            </div>
          )}

          <section className="mb-6" role="region" aria-labelledby="report-funnel-title">
            <div className="mb-3">
              <p className="ds-eyebrow mb-1">01 → Обработка</p>
              <h2 id="report-funnel-title" className="text-base font-semibold" style={{ color: 'var(--cp-paper)' }}>
                Воронка компаний, отскоренных в период
              </h2>
            </div>
            <div className="ds-card overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-left text-xs">
                <thead style={{ background: 'var(--cp-surface-elev)' }}>
                  <tr>
                    <th className="ds-eyebrow px-4 py-3 sm:px-5" scope="col">Этап</th>
                    <th className="ds-eyebrow px-4 py-3 text-right" scope="col">Количество</th>
                    <th className="ds-eyebrow px-4 py-3" scope="col">Единица</th>
                    <th className="ds-eyebrow px-4 py-3 text-right sm:px-5" scope="col">К предыдущему</th>
                  </tr>
                </thead>
                <tbody>
                  {funnelRows.map((row, index) => (
                    <tr key={row.label} style={index > 0 ? { borderTop: '1px solid var(--cp-divider)' } : undefined}>
                      <th className="px-4 py-3 font-medium sm:px-5" scope="row" style={{ color: 'var(--cp-paper)' }}>{row.label}</th>
                      <td className="ds-mono px-4 py-3 text-right tabular-nums" style={{ color: 'var(--cp-paper)' }}>{formatCount(row.value)}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--cp-paper-mute)' }}>{row.unit}</td>
                      <td className="ds-mono px-4 py-3 text-right sm:px-5" style={{ color: 'var(--cp-paper-faint)' }}>
                        {conversion(
                          normalizeCount(row.value),
                          index > 0 && funnelRows[index - 1].unit === row.unit
                            ? normalizeCount(funnelRows[index - 1].value)
                            : null,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mb-6" role="region" aria-labelledby="report-campaigns-title">
            <div className="mb-3">
              <p className="ds-eyebrow mb-1">02 → Передача</p>
              <h2 id="report-campaigns-title" className="text-base font-semibold" style={{ color: 'var(--cp-paper)' }}>
                По кампаниям и скору
              </h2>
            </div>
            <div className="ds-card overflow-x-auto">
              {data.funnel.byCampaign.length > 0 ? (
                <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                  <thead style={{ background: 'var(--cp-surface-elev)' }}>
                    <tr>
                      <th className="ds-eyebrow px-4 py-3 sm:px-5" scope="col">Кампания</th>
                      <th className="ds-eyebrow px-4 py-3" scope="col">Скор</th>
                      <th className="ds-eyebrow px-4 py-3 text-right" scope="col">Передано</th>
                      <th className="ds-eyebrow px-4 py-3 text-right sm:px-5" scope="col">Подтверждено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.funnel.byCampaign.map((row, index) => (
                      <tr key={`${row.campaignId}-${row.scoreCode}`} style={index > 0 ? { borderTop: '1px solid var(--cp-divider)' } : undefined}>
                        <th className="px-4 py-3 font-medium sm:px-5" scope="row" style={{ color: 'var(--cp-paper)' }}>{row.campaignName}</th>
                        <td className="ds-mono px-4 py-3" style={{ color: 'var(--cp-paper-mute)' }}>{row.scoreCode}</td>
                        <td className="ds-mono px-4 py-3 text-right tabular-nums" style={{ color: 'var(--cp-paper-mute)' }}>{formatCount(row.submitted)}</td>
                        <td className="ds-mono px-4 py-3 text-right tabular-nums sm:px-5" style={{ color: 'var(--cp-paper)' }}>{formatCount(row.confirmed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="px-5 py-8 text-center text-xs" style={{ color: 'var(--cp-paper-faint)' }}>Нет загрузок по кампаниям за этот период.</p>
              )}
            </div>
          </section>
        </>
      )}

      <section aria-labelledby="report-exports-title">
            <div className="mb-3">
              <p className="ds-eyebrow mb-1">03 → Данные</p>
              <h2 id="report-exports-title" className="text-base font-semibold" style={{ color: 'var(--cp-paper)' }}>
                Выгрузки баз
              </h2>
            </div>
            <div className="ds-card overflow-hidden">
              {EXPORTS.map((item, index) => {
                const state = exportStates[item.kind];
                return (
                  <div
                    key={item.kind}
                    className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                    style={index > 0 ? { borderTop: '1px solid var(--cp-divider)' } : undefined}
                  >
                    <div className="max-w-2xl">
                      <p className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>{item.title}</p>
                      <p className="mt-1 text-xs leading-5" style={{ color: 'var(--cp-paper-faint)' }}>{item.description}</p>
                      {state.message && (
                        <p
                          className="mt-1.5 text-xs"
                          aria-live="polite"
                          style={{ color: state.status === 'error' ? 'var(--cp-red)' : 'var(--cp-paper-mute)' }}
                        >
                          {state.message}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ds-btn-secondary inline-flex shrink-0 items-center justify-center gap-2"
                      disabled={state.status === 'working'}
                      onClick={() => startExport(item.kind)}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                      {state.status === 'working' ? 'Готовим…' : item.buttonLabel}
                    </button>
                  </div>
                );
              })}
            </div>
      </section>
    </main>
  );
}
