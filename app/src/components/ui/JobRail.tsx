'use client';

import { Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';

export type JobRailStatus = 'pending' | 'running' | 'completed' | 'failed';

export const JOB_RAIL_STATUS_LABELS: Record<JobRailStatus, string> = {
  pending: 'в очереди',
  running: 'идёт',
  completed: 'готов',
  failed: 'остановлен',
};

const STATUS_CLS: Record<JobRailStatus, string> = {
  pending: 'bg-violet-50 text-violet-700',
  running: 'bg-violet-50 text-violet-700',
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
};

export interface JobRailItem {
  id: string;
  status: JobRailStatus;
  /** Крупная строка: чем этот запуск отличается от соседнего. */
  title: string;
  /** Мелкая строка под полосой: время и сколько готово. */
  subtitle: string;
  /** Доля выполненного, 0–100. Завершённый запуск вызывающая сторона отдаёт как 100. */
  percent: number;
  /** Запуск нельзя удалять, пока он идёт. */
  deletable: boolean;
}

interface Props {
  items: JobRailItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  /** Повторить запуск с теми же настройками. Не передан — кнопки нет. */
  onRepeat?: (id: string) => void;
  onDelete?: (id: string) => void;
  emptyText?: string;
}

/**
 * Колонка запусков слева от рабочей области: у каждого своя полоса прогресса,
 * статус и действия по наведению.
 *
 * Общая для русского и английского автоаутрича — раскладка и поведение у них
 * одни, различаются только подписи, которые собирает вызывающая сторона.
 */
export function JobRail({ items, activeId, onSelect, onNew, onRefresh, onRepeat, onDelete, emptyText }: Props) {
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

      {items.length === 0 ? (
        <p className="px-3 py-4 text-sm text-gray-500">{emptyText ?? 'Запусков ещё не было.'}</p>
      ) : (
        <div className="max-h-[70vh] overflow-y-auto p-2">
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <div
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={`group mb-1.5 cursor-pointer rounded-lg border p-2.5 last:mb-0 ${
                  active ? 'border-violet-300 bg-violet-50' : 'border-transparent hover:border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-gray-900">{item.title}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[item.status]}`}>
                    {JOB_RAIL_STATUS_LABELS[item.status]}
                  </span>
                </div>

                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-200">
                  <div
                    className={`h-1 rounded-full ${item.status === 'failed' ? 'bg-gray-400' : 'bg-violet-600'}`}
                    style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }}
                  />
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-gray-500">{item.subtitle}</span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {onRepeat && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRepeat(item.id);
                        }}
                        className="rounded p-1 text-gray-400 hover:bg-white hover:text-violet-700"
                        aria-label="Повторить этот запуск"
                        title="Повторить с теми же настройками"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {onDelete && item.deletable && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(item.id);
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
