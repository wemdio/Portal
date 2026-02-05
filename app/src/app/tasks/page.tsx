'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Project } from '@/types';
import {
  formatDateLabel,
  isPastDate,
  isWithinDays,
  parseFlexibleDate,
} from '@/lib/dateUtils';
import { logError } from '@/lib/loggerClient';

type TaskItem = {
  id: string;
  title: string;
  projectId: string | number;
  projectName: string;
  specialist: string;
  manager: string;
  deadlineDate: Date | null;
  projectStatus: string | null | undefined;
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  overdue: { label: 'Просрочено', className: 'bg-red-50 text-red-700 border-red-200' },
  soon: { label: 'Скоро дедлайн', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  paused: { label: 'На паузе', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  done: { label: 'Завершено', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  active: { label: 'В работе', className: 'bg-blue-50 text-blue-700 border-blue-200' },
};

const splitTasks = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|•|;+/)
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
};

const isCompletedStatus = (status: string | null | undefined) => {
  if (!status) return false;
  const key = status.toLowerCase();
  return key.includes('заверш') || key.includes('completed');
};

const isPausedStatus = (status: string | null | undefined) => {
  if (!status) return false;
  return status.toLowerCase().includes('пауз');
};

const getTaskStatus = (
  projectStatus: string | null | undefined,
  deadlineDate: Date | null,
  today: Date,
) => {
  if (isCompletedStatus(projectStatus)) return STATUS_CONFIG.done;
  if (deadlineDate && isPastDate(deadlineDate, today)) return STATUS_CONFIG.overdue;
  if (deadlineDate && isWithinDays(deadlineDate, today, 7)) return STATUS_CONFIG.soon;
  if (isPausedStatus(projectStatus)) return STATUS_CONFIG.paused;
  return STATUS_CONFIG.active;
};

export default function TasksPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'specialists' | 'projects'>('specialists');

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const { data, error } = await supabase.from('projects').select('*');
        if (error) throw error;
        setProjects((data ?? []) as Project[]);
      } catch (error) {
        void logError('tasks.projects.fetch.failed', error);
      } finally {
        setLoading(false);
      }
    };

    void fetchProjects();
  }, []);

  const today = useMemo(() => new Date(), []);

  const tasks = useMemo<TaskItem[]>(() => {
    return projects.flatMap((project) => {
      const list = splitTasks(project.hypotheses || project.weekly_tasks);
      if (list.length === 0) return [];
      return list.map((title, index) => ({
        id: `${project.id ?? 'project'}-${index}`,
        title,
        projectId: project.id ?? 'project',
        projectName: project.name || 'Без названия',
        specialist: project.specialist || 'Без специалиста',
        manager: project.manager || 'Без менеджера',
        deadlineDate: parseFlexibleDate(project.deadline),
        projectStatus: project.status,
      }));
    });
  }, [projects]);

  const tasksBySpecialist = useMemo(() => {
    const map = new Map<string, TaskItem[]>();
    tasks.forEach((task) => {
      const key = task.specialist;
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(task);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [tasks]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string | number, { project: Project; tasks: TaskItem[] }>();
    projects.forEach((project) => {
      const list = tasks.filter((task) => task.projectId === (project.id ?? 'project'));
      map.set(project.id ?? 'project', { project, tasks: list });
    });
    return Array.from(map.values());
  }, [projects, tasks]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-gray-400">Главная / задачи</p>
          <h1 className="text-2xl font-semibold text-gray-900">Задачи</h1>
          <p className="mt-1 text-sm text-gray-500">Задачи специалистов и проектов в одном месте.</p>
        </div>
        <div className="flex items-center rounded-full bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => setView('specialists')}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
              view === 'specialists' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            специалисты
          </button>
          <button
            type="button"
            onClick={() => setView('projects')}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
              view === 'projects' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            проекты
          </button>
        </div>
      </div>

      {view === 'specialists' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {tasksBySpecialist.map(([specialist, list]) => (
            <div key={specialist} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{specialist}</h3>
                  <p className="text-xs text-gray-500">{list.length} задач</p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {list.map((task) => {
                  const status = getTaskStatus(task.projectStatus, task.deadlineDate, today);
                  return (
                    <div key={task.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs text-gray-500">{task.projectName}</p>
                          <p className="text-sm font-medium text-gray-900">{task.title}</p>
                        </div>
                        <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${status.className}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-gray-500">
                        Дедлайн: {formatDateLabel(task.deadlineDate)} · Менеджер: {task.manager}
                      </p>
                    </div>
                  );
                })}
                {list.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-200 p-3 text-center text-sm text-gray-400">
                    Нет задач
                  </div>
                )}
              </div>
            </div>
          ))}
          {tasksBySpecialist.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
              Задачи пока не добавлены.
            </div>
          )}
        </div>
      )}

      {view === 'projects' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {tasksByProject.map(({ project, tasks: list }) => {
            const deadlineDate = parseFlexibleDate(project.deadline);
            const status = getTaskStatus(project.status, deadlineDate, today);
            return (
              <div key={project.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{project.name || 'Без названия'}</h3>
                    <p className="text-xs text-gray-500">
                      {project.specialist || 'Без специалиста'} · дедлайн {formatDateLabel(deadlineDate)}
                    </p>
                  </div>
                  <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${status.className}`}>
                    {status.label}
                  </span>
                </div>
                <div className="mt-4 space-y-2">
                  {list.map((task) => (
                    <div key={task.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <p className="text-sm font-medium text-gray-900">{task.title}</p>
                      <p className="mt-1 text-xs text-gray-500">Исполнитель: {task.specialist}</p>
                    </div>
                  ))}
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
            <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
              Нет проектов для отображения.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
