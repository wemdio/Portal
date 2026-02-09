'use client';

import type { ParserJob } from '@/types';
import { JobStatus } from './JobStatus';
import { ChevronRight, RefreshCw } from 'lucide-react';

const STAGE_LABELS: Record<string, string> = {
  pending: 'Ожидание',
  partitioning: 'Подготавливаем запрос',
  fetching_vacancies: 'Ищем вакансии',
  fetching_employers: 'Подгружаем работодателей',
  saving: 'Сохраняем в базу',
  completed: 'Завершено',
  failed: 'Ошибка',
  cancelled: 'Остановлено',
};

function resolveStageLabel(job: ParserJob) {
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

type Props = {
  jobs: ParserJob[];
  activeJobId: string | null;
  onSelect: (jobId: string) => void;
  onRefresh: () => void;
  busy: boolean;
  refreshing?: boolean;
};

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
}: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4 flex-nowrap">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 whitespace-nowrap">
            История запусков ({jobs.length})
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

      {jobs.length === 0 ? (
        <div className="px-6 py-10 text-center text-gray-500">Запусков пока нет</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {jobs.map((job) => {
            const isActive = activeJobId === job.id;
            const totalFound = typeof job.total_found === 'number' ? job.total_found : null;
            const totalParsed = typeof job.total_parsed === 'number' ? job.total_parsed : null;
            const hasTotal = totalFound != null && totalFound > 0;
            const progressFromJob = typeof job.progress_percent === 'number'
              ? Math.max(0, Math.min(100, Math.round(job.progress_percent)))
              : null;
            const shouldHideFallback = progressFromJob == null &&
              (job.progress_stage === 'fetching_employers' || job.progress_stage === 'saving');
            const fallbackProgress = job.status === 'completed'
              ? 100
              : hasTotal && !shouldHideFallback
                ? Math.min(100, Math.round(((totalParsed ?? 0) / totalFound) * 100))
                : null;
            const progressValue = progressFromJob ?? fallbackProgress;
            const hasProgress = progressValue != null;
            const stageLabel = resolveStageLabel(job);
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
                      <JobStatus status={job.status} />
                      <span className="text-xs text-gray-400">{formatDate(job.created_at)}</span>
                    </div>
                    <div className="mt-2 text-sm text-gray-700 line-clamp-2">
                      <span className="font-medium text-gray-900">text:</span> {job.config?.text}
                    </div>
                    <div className="mt-3">
                      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                        {hasProgress ? (
                          <div
                            className={`h-full transition-all duration-300 ${
                              job.status === 'failed'
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
                        {totalFound != null || totalParsed != null ? (
                          <span>
                            Найдено: {totalFound ?? '—'} · Обработано: {totalParsed ?? '—'}
                          </span>
                        ) : null}
                        {job.error_message ? <span className="text-red-600 line-clamp-1">{job.error_message}</span> : null}
                      </div>
                    </div>
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

