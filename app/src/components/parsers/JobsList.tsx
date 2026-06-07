'use client';

import type { ParserJob, AtsParserJob, PartitionProgressDetail } from '@/types';
import { isStoppedByUser, JobStatus } from './JobStatus';
import { ChevronRight, RefreshCw, Clock } from 'lucide-react';

const STAGE_LABELS: Record<string, string> = {
  pending: 'Ожидание',
  partitioning: 'Подготавливаем запрос',
  fetching_vacancies: 'Ищем вакансии',
  fetching_employers: 'Подгружаем работодателей',
  // ATS parser stages
  loading_companies: 'Загружаем компании',
  scanning: 'Сканируем вакансии',
  enriching: 'Определяем домены',
  saving: 'Сохраняем в базу',
  completed: 'Завершено',
  failed: 'Ошибка',
  cancelled: 'Остановлено',
};

function resolveStageLabel(job: ParserJob | AtsParserJob) {
  if (job.progress_stage === 'partitioning') {
    const detail = getPartitionDetail(job);
    if (detail) {
      return `Разбиение на подзапросы (${detail.completed_subqueries}/${detail.total_subqueries})`;
    }
    return STAGE_LABELS.partitioning;
  }
  if (job.progress_stage === 'fetching_vacancies') {
    const detail = getPartitionDetail(job);
    if (detail && detail.completed_subqueries < detail.total_subqueries) {
      return `Ищем вакансии (подзапрос ${detail.completed_subqueries + 1}/${detail.total_subqueries})`;
    }
    return STAGE_LABELS.fetching_vacancies;
  }
  if (job.progress_stage && STAGE_LABELS[job.progress_stage]) {
    return STAGE_LABELS[job.progress_stage];
  }
  if (job.status === 'completed') return STAGE_LABELS.completed;
  if (job.status === 'failed') {
    if (job.error_message === 'Остановлено пользователем') return STAGE_LABELS.cancelled;
    return STAGE_LABELS.failed;
  }
  if (job.status === 'pending') return STAGE_LABELS.pending;
  return 'В процессе';
}

function getPartitionDetail(job: ParserJob | AtsParserJob): PartitionProgressDetail | null {
  if (!job.progress_detail) return null;
  const d = job.progress_detail;
  if (typeof d.total_subqueries !== 'number' || d.total_subqueries <= 1) return null;
  return d;
}

type Props = {
  jobs: Array<ParserJob | AtsParserJob>;
  activeJobId: string | null;
  onSelect: (jobId: string) => void;
  onRefresh: () => void;
  busy: boolean;
  refreshing?: boolean;
  /** Фактическое количество строк в hh_vacancies для активного запуска */
  activeJobParsedCount?: number;
  /** Client portal: readable query (no OR-pipes), plain-language errors. */
  clientMode?: boolean;
  /** Client retry: re-run a failed job's search. When set, a «Повторить» button
   *  shows on failed rows in clientMode. */
  onRetry?: (job: ParserJob | AtsParserJob) => void;
};

const MAX_JOBS = 20;
const LIST_MAX_HEIGHT = '420px'; // ~5 видимых элементов

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


export function JobsList({
  jobs,
  activeJobId,
  onSelect,
  onRefresh,
  busy,
  refreshing,
  activeJobParsedCount,
  clientMode,
  onRetry,
}: Props) {
  const displayJobs = jobs.slice(0, MAX_JOBS);
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-nowrap">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-amber-100 text-amber-600">
            <Clock className="h-4 w-4" />
          </span>
          <h3 className="text-lg font-semibold text-gray-900 whitespace-nowrap">
            {clientMode ? 'Мои запросы' : 'История запусков'} ({displayJobs.length})
          </h3>
        </div>
        <button
          onClick={onRefresh}
          disabled={busy}
          className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </div>

      {displayJobs.length === 0 ? (
        <div className="px-6 py-10 text-center text-gray-500">Запусков пока нет</div>
      ) : (
        <div
          className="divide-y divide-gray-100 overflow-y-auto"
          style={{ maxHeight: LIST_MAX_HEIGHT }}
        >
          {displayJobs.map((job) => {
            const isActive = activeJobId === job.id;
            const stoppedByUser = isStoppedByUser(job.status, job.error_message);
            const totalFound = typeof job.total_found === 'number' ? job.total_found : null;
            const parsedFromJob = typeof job.total_parsed === 'number' ? job.total_parsed : null;
            const totalParsed =
              job.id === activeJobId && typeof activeJobParsedCount === 'number'
                ? activeJobParsedCount
                : parsedFromJob;
            const hasTotal = totalFound != null && totalFound > 0;
            const progressFromJob = typeof job.progress_percent === 'number'
              ? Math.max(0, Math.min(100, Math.round(job.progress_percent)))
              : null;
            const shouldHideFallback = progressFromJob == null &&
              (job.progress_stage === 'fetching_employers' || job.progress_stage === 'saving');
            const fallbackProgress = job.status === 'completed'
              ? 100
              : hasTotal && !shouldHideFallback
                ? Math.min(100, Math.round(((parsedFromJob ?? 0) / totalFound) * 100))
                : null;
            const progressValue = progressFromJob ?? fallbackProgress;
            const hasProgress = progressValue != null;
            const stageLabel = resolveStageLabel(job);
            const partDetail = getPartitionDetail(job);
            const isPartitioning = job.status === 'running' && partDetail != null;
            return (
              <div
                key={job.id}
                className={`w-full text-left px-6 py-4 hover:bg-gray-50 transition-colors ${
                  isActive ? 'bg-blue-50' : ''
                }`}
              >
                  <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <JobStatus status={job.status} errorMessage={job.error_message} />
                      <span className="text-xs text-gray-400">{formatDate(job.created_at)}</span>
                    </div>
                    <div className="mt-2 text-sm text-gray-700 line-clamp-2">
                      <span className="font-medium text-gray-900">Запрос:</span>{' '}
                      {clientMode ? (job.config?.text ?? '').replace(/\s*\|\s*/g, ', ') : job.config?.text}
                    </div>
                    {isPartitioning ? (
                      <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2">
                        <div className="flex items-center gap-2 text-xs font-medium text-blue-700">
                          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Разбиение на подзапросы: {partDetail.completed_subqueries} из {partDetail.total_subqueries}
                        </div>
                        {partDetail.current_subquery && partDetail.completed_subqueries < partDetail.total_subqueries ? (
                          <div className="mt-1 text-xs text-blue-600 truncate" title={partDetail.current_subquery}>
                            Текущий: {partDetail.current_subquery}
                          </div>
                        ) : null}
                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ width: `${Math.round((partDetail.completed_subqueries / partDetail.total_subqueries) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-3">
                      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                        {hasProgress ? (
                          <div
                            className={`h-full transition-all duration-300 ${
                              stoppedByUser
                                ? 'bg-amber-500'
                                : job.status === 'failed'
                                  ? 'bg-red-500'
                                : job.status === 'completed'
                                  ? 'bg-emerald-500'
                                  : 'bg-emerald-500'
                            }`}
                            style={{ width: `${progressValue ?? 0}%` }}
                          />
                        ) : (
                          <div className="h-full w-1/3 bg-emerald-400 animate-pulse" />
                        )}
                      </div>
                      <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
                        <span>
                          {hasProgress
                            ? `Прогресс: ${progressValue}%${stageLabel ? ` — ${stageLabel}` : ''}`
                            : stageLabel
                              ? `Статус: ${stageLabel}`
                              : 'Прогресс: —'}
                        </span>
                        {totalParsed != null ? (
                          <span>
                            Обработано: {totalParsed}
                          </span>
                        ) : null}
                        {job.error_message ? (
                          <span className={`${stoppedByUser ? 'text-amber-700' : 'text-red-600'} line-clamp-1`}>
                            {stoppedByUser
                              ? 'Остановлено'
                              : clientMode
                                ? 'Не удалось завершить — попробуйте запустить снова'
                                : job.error_message}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {clientMode && onRetry && job.status === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => onRetry(job)}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Повторить
                      </button>
                    ) : null}
                  </div>
                  <button
                    onClick={() => onSelect(job.id)}
                    className="inline-flex items-center justify-center rounded-full p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600"
                    aria-label="Открыть результаты"
                  >
                    <ChevronRight className={`h-5 w-5 flex-shrink-0 ${isActive ? 'text-blue-600' : ''}`} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

