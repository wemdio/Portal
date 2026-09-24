'use client';

import { Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { fmtDateTime, type RuJob } from './shared';

export const JOB_STATUS: Record<RuJob['status'], string> = {
  pending: 'в очереди',
  running: 'идёт',
  completed: 'готов',
  failed: 'остановлен',
};

const STATUS_CLS: Record<RuJob['status'], string> = {
  pending: 'bg-violet-50 text-violet-700',
  running: 'bg-violet-50 text-violet-700',
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
};

interface Props {
  jobs: RuJob[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRepeat: (job: RuJob) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

/** Доля выполненного, 0–100: пока идёт — из процента, у завершённого — всегда полная. */
function percentOf(job: RuJob): number {
  if (job.status === 'completed') return 100;
  const raw = job.progress_percent ?? 0;
  return Math.max(0, Math.min(100, raw));
}

export function JobList({ jobs, activeId, onSelect, onNew, onRepeat, onDelete, onRefresh }: Props) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-200 p-3">
        <button
          type="button"
          onClick={onNew}
          className="inline-flex flex-1 items-center justify-center rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700"
        >
          <Plus className="mr-1.5 h-4 w-4" /> Новый запуск
        </button>
        <button type="button" onClick={onRefresh} className="rounded-md p-2 text-gray-500 hover:bg-gray-100" aria-label="Обновить список запусков">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {jobs.length === 0 ? (
        <p className="px-3 py-4 text-sm text-gray-500">Запусков ещё не было.</p>
      ) : (
        <div className="max-h-[70vh] overflow-y-auto p-2">
          {jobs.map((job) => {
            const active = job.id === activeId;
            const done = job.total_parsed ?? 0;
            const target = job.config?.limit ?? null;
            const pct = percentOf(job);
            return (
              <div
                key={job.id}
                onClick={() => onSelect(job.id)}
                className={`group mb-1.5 cursor-pointer rounded-lg border p-2.5 last:mb-0 ${
                  active ? 'border-violet-300 bg-violet-50' : 'border-transparent hover:border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-gray-900">
                    {target ? `На ${target} компаний` : 'Запуск'}
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[job.status]}`}>{JOB_STATUS[job.status]}</span>
                </div>

                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-200">
                  <div
                    className={`h-1 rounded-full ${job.status === 'failed' ? 'bg-gray-400' : 'bg-violet-600'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-gray-500">
                    {fmtDateTime(job.created_at)} · готово {done}
                    {target ? ` из ${target}` : ''}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRepeat(job);
                      }}
                      className="rounded p-1 text-gray-400 hover:bg-white hover:text-violet-700"
                      aria-label="Повторить этот запуск"
                      title="Повторить с теми же настройками"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    {job.status !== 'running' && job.status !== 'pending' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(job.id);
                        }}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Удалить запуск"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
