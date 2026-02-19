'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Project, Task, TaskStatus } from '@/types';
import {
  formatDateLabel,
  isPastDate,
  isWithinDays,
  parseFlexibleDate,
} from '@/lib/dateUtils';
import { logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';

const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; className: string }> = {
  pending: { label: 'Ожидает', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  in_progress: { label: 'В работе', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  done: { label: 'Завершено', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

const DEADLINE_STATUS: Record<string, { label: string; className: string }> = {
  overdue: { label: 'Просрочено', className: 'bg-red-50 text-red-700 border-red-200' },
  soon: { label: 'Скоро дедлайн', className: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const splitLegacyTasks = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|•|;+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
};

type EnrichedTask = Task & {
  projectName: string;
  specialist: string;
  manager: string;
  deadlineDate: Date | null;
  isLegacy?: boolean;
};

export default function TasksPage() {
  const isTma = useIsTma();
  const [projects, setProjects] = useState<Project[]>([]);
  const [dbTasks, setDbTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'specialists' | 'projects'>('specialists');
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editingResultValue, setEditingResultValue] = useState('');

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      const [projRes, taskRes] = await Promise.all([
        supabase.from('projects').select('*'),
        supabase.from('tasks').select('*').order('created_at', { ascending: false }),
      ]);
      if (projRes.error) throw projRes.error;
      setProjects((projRes.data ?? []) as Project[]);
      setDbTasks((taskRes.data ?? []) as Task[]);
    } catch (error) {
      void logError('tasks.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  const updateTaskStatus = useCallback(async (taskId: string, newStatus: TaskStatus) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));
    await supabase.from('tasks').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', taskId);
  }, []);

  const updateTaskResult = useCallback(async (taskId: string, result: string) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, result } : t)));
    await supabase.from('tasks').update({ result, updated_at: new Date().toISOString() }).eq('id', taskId);
    setEditingResultId(null);
  }, []);

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const allTasks = useMemo<EnrichedTask[]>(() => {
    const enriched: EnrichedTask[] = dbTasks.map((t) => {
      const p = projectMap.get(t.project_id);
      return {
        ...t,
        projectName: p?.client || 'Без названия',
        specialist: p?.specialist || 'Без специалиста',
        manager: p?.manager || 'Без менеджера',
        deadlineDate: p ? parseFlexibleDate(p.deadline) : null,
      };
    });

    const dbProjectIds = new Set(dbTasks.map((t) => t.project_id));
    projects.forEach((project) => {
      if (dbProjectIds.has(project.id)) return;
      const legacy = splitLegacyTasks(project.hypotheses || project.weekly_tasks);
      legacy.forEach((title, idx) => {
        enriched.push({
          id: `legacy-${project.id}-${idx}`,
          project_id: project.id,
          title,
          status: 'pending' as TaskStatus,
          projectName: project.client || 'Без названия',
          specialist: project.specialist || 'Без специалиста',
          manager: project.manager || 'Без менеджера',
          deadlineDate: parseFlexibleDate(project.deadline),
          isLegacy: true,
        });
      });
    });

    return enriched;
  }, [dbTasks, projects, projectMap]);

  const today = useMemo(() => new Date(), []);

  const tasksBySpecialist = useMemo(() => {
    const map = new Map<string, EnrichedTask[]>();
    allTasks.forEach((t) => {
      if (!map.has(t.specialist)) map.set(t.specialist, []);
      map.get(t.specialist)!.push(t);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [allTasks]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, { project: Project; tasks: EnrichedTask[] }>();
    projects.forEach((p) => map.set(p.id, { project: p, tasks: [] }));
    allTasks.forEach((t) => map.get(t.project_id)?.tasks.push(t));
    return Array.from(map.values()).filter((e) => e.tasks.length > 0);
  }, [allTasks, projects]);

  function getDeadlineBadge(deadlineDate: Date | null) {
    if (!deadlineDate) return null;
    if (isPastDate(deadlineDate, today)) return DEADLINE_STATUS.overdue;
    if (isWithinDays(deadlineDate, today, 7)) return DEADLINE_STATUS.soon;
    return null;
  }

  function renderTaskCard(task: EnrichedTask) {
    const deadlineBadge = getDeadlineBadge(task.deadlineDate);
    const statusCfg = TASK_STATUS_CONFIG[task.status];
    const isEditingResult = editingResultId === task.id;
    const statusOptions: TaskStatus[] = ['pending', 'in_progress', 'done'];

    return (
      <div key={task.id} className={`rounded-lg border p-3 transition-colors ${task.status === 'done' ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-200'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500">{task.projectName}</p>
            <p className={`text-sm font-medium mt-0.5 ${task.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
              {task.title}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {deadlineBadge && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${deadlineBadge.className}`}>
                {deadlineBadge.label}
              </span>
            )}
            {task.isLegacy ? (
              <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${statusCfg.className}`}>
                {statusCfg.label}
              </span>
            ) : (
              <select
                value={task.status}
                onChange={(e) => void updateTaskStatus(task.id, e.target.value as TaskStatus)}
                className={`appearance-none cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] font-semibold outline-none ${statusCfg.className}`}
              >
                {statusOptions.map((s) => (
                  <option key={s} value={s}>{TASK_STATUS_CONFIG[s].label}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
          <span>Дедлайн: {formatDateLabel(task.deadlineDate)}</span>
          <span>Менеджер: {task.manager}</span>
          {task.isLegacy && (
            <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">legacy</span>
          )}
        </div>

        {!task.isLegacy && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            {isEditingResult ? (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={editingResultValue}
                  onChange={(e) => setEditingResultValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void updateTaskResult(task.id, editingResultValue);
                    if (e.key === 'Escape') setEditingResultId(null);
                  }}
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400"
                  placeholder="Результат задачи..."
                />
                <button
                  type="button"
                  onClick={() => void updateTaskResult(task.id, editingResultValue)}
                  className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700"
                >
                  ✓
                </button>
              </div>
            ) : (
              <div
                className="cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5 -mx-1 transition-colors"
                onClick={() => {
                  setEditingResultId(task.id);
                  setEditingResultValue(task.result || '');
                }}
              >
                {task.result ? (
                  <p className="text-xs text-gray-700"><span className="font-medium text-gray-500">Результат:</span> {task.result}</p>
                ) : (
                  <p className="text-xs text-gray-400">+ Добавить результат</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className={isTma ? 'space-y-4' : 'space-y-6'}>
      <div className={isTma ? 'flex flex-col gap-3' : 'flex flex-wrap items-center justify-between gap-4'}>
        <div>
          <p className="text-sm text-gray-400">Главная / задачи</p>
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-semibold text-gray-900`}>Задачи</h1>
          <p className="mt-1 text-sm text-gray-500">Задачи специалистов и проектов в одном месте.</p>
        </div>
        <div className={isTma ? 'flex w-full items-center rounded-full bg-gray-100 p-1' : 'flex items-center rounded-full bg-gray-100 p-1'}>
          <button
            type="button"
            onClick={() => setView('specialists')}
            className={`${isTma ? 'flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition' : 'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition'} ${
              view === 'specialists' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            специалисты
          </button>
          <button
            type="button"
            onClick={() => setView('projects')}
            className={`${isTma ? 'flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition' : 'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition'} ${
              view === 'projects' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            проекты
          </button>
        </div>
      </div>

      {view === 'specialists' && (
        <div className={isTma ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-6 lg:grid-cols-3'}>
          {tasksBySpecialist.map(([specialist, list]) => (
            <div key={specialist} className={`rounded-xl border border-gray-200 bg-white shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{specialist}</h3>
                  <p className="text-xs text-gray-500">{list.length} задач</p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {list.map(renderTaskCard)}
                {list.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-200 p-3 text-center text-sm text-gray-400">
                    Нет задач
                  </div>
                )}
              </div>
            </div>
          ))}
          {tasksBySpecialist.length === 0 && (
            <div className={`rounded-xl border border-dashed border-gray-200 text-center text-sm text-gray-500 ${isTma ? 'p-5' : 'p-6'}`}>
              Задачи пока не добавлены.
            </div>
          )}
        </div>
      )}

      {view === 'projects' && (
        <div className={isTma ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-6 lg:grid-cols-3'}>
          {tasksByProject.map(({ project, tasks: list }) => {
            const deadlineDate = parseFlexibleDate(project.deadline);
            const deadlineBadge = getDeadlineBadge(deadlineDate);
            return (
              <div key={project.id} className={`rounded-xl border border-gray-200 bg-white shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{project.client || 'Без названия'}</h3>
                    <p className="text-xs text-gray-500">
                      {project.specialist || 'Без специалиста'} · дедлайн {formatDateLabel(deadlineDate)}
                    </p>
                  </div>
                  {deadlineBadge && (
                    <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${deadlineBadge.className}`}>
                      {deadlineBadge.label}
                    </span>
                  )}
                </div>
                <div className="mt-4 space-y-2">
                  {list.map(renderTaskCard)}
                  {list.length === 0 && (
                    <div className="rounded-lg border border-dashed border-gray-200 p-3 text-center text-sm text-gray-400">
                      Нет задач
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {tasksByProject.length === 0 && (
            <div className={`rounded-xl border border-dashed border-gray-200 text-center text-sm text-gray-500 ${isTma ? 'p-5' : 'p-6'}`}>
              Нет проектов для отображения.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
