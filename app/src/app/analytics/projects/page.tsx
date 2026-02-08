'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Project } from '@/types';
import { logError } from '@/lib/loggerClient';
import {
  diffDaysFrom,
  formatDateLabel,
  isPastDate,
  isSameMonth,
  isWithinDays,
  parseFlexibleDate,
} from '@/lib/dateUtils';

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  'в работе': { label: 'В работе', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'тестирование': { label: 'Тестирование', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  'на паузе': { label: 'На паузе', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  'подготовка': { label: 'Подготовка', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  'завершен': { label: 'Завершен', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  'completed': { label: 'Завершен', className: 'bg-gray-100 text-gray-600 border-gray-200' },
};

const splitTasks = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|•|;+/)
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
};

const getStatusBadge = (status: string | null | undefined) => {
  if (!status) return { label: 'В работе', className: STATUS_CONFIG['в работе'].className };
  const key = status.toLowerCase();
  const entry = Object.entries(STATUS_CONFIG).find(([needle]) => key.includes(needle));
  if (entry) return entry[1];
  return { label: status, className: 'bg-gray-100 text-gray-600 border-gray-200' };
};

const isCompletedStatus = (status: string | null | undefined) => {
  if (!status) return false;
  const key = status.toLowerCase();
  return key.includes('заверш') || key.includes('completed');
};

type EnrichedProject = Project & {
  deadlineDate: Date | null;
};

export default function ProjectsAnalyticsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const { data, error } = await supabase.from('projects').select('*');
        if (error) throw error;
        setProjects((data ?? []) as Project[]);
      } catch (error) {
        void logError('analytics.projects.fetch.failed', error);
      } finally {
        setLoading(false);
      }
    };

    void fetchProjects();
  }, []);

  const today = useMemo(() => new Date(), []);

  const enrichedProjects = useMemo<EnrichedProject[]>(
    () =>
      projects.map((project) => ({
        ...project,
        deadlineDate: parseFlexibleDate(project.deadline),
      })),
    [projects],
  );

  const endingThisMonth = useMemo(
    () =>
      enrichedProjects.filter(
        (project) => project.deadlineDate && isSameMonth(project.deadlineDate, today),
      ),
    [enrichedProjects, today],
  );

  const renewals = useMemo(
    () =>
      enrichedProjects.filter(
        (project) =>
          project.deadlineDate &&
          isWithinDays(project.deadlineDate, today, 30) &&
          !isCompletedStatus(project.status),
      ),
    [enrichedProjects, today],
  );

  const overdueProjects = useMemo(
    () =>
      enrichedProjects.filter(
        (project) =>
          project.deadlineDate &&
          isPastDate(project.deadlineDate, today) &&
          !isCompletedStatus(project.status),
      ),
    [enrichedProjects, today],
  );

  const overdueTasks = useMemo(
    () =>
      overdueProjects.flatMap((project) => {
        const tasks = splitTasks(project.hypotheses || project.weekly_tasks);
        return tasks.map((task, index) => ({
          id: `${project.id ?? 'project'}-${index}`,
          title: task,
          projectName: project.client || 'Без названия',
          specialist: project.specialist || 'Без специалиста',
          deadlineDate: project.deadlineDate,
          status: project.status,
        }));
      }),
    [overdueProjects],
  );

  const renewalsBySpecialist = useMemo(() => {
    const map = new Map<string, number>();
    renewals.forEach((project) => {
      const name = project.specialist || 'Без специалиста';
      map.set(name, (map.get(name) ?? 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [renewals]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Аналитика проектов</h1>
        <p className="mt-1 text-sm text-gray-500">
          Продления, дедлайны и проблемные задачи по проектам.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm text-gray-500">Всего проектов</p>
              <p className="text-2xl font-semibold text-gray-900">{projects.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm text-gray-500">Заканчиваются в этом месяце</p>
              <p className="text-2xl font-semibold text-gray-900">{endingThisMonth.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm text-gray-500">Продления в 30 дней</p>
              <p className="text-2xl font-semibold text-gray-900">{renewals.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm text-gray-500">Просроченных задач</p>
              <p className="text-2xl font-semibold text-gray-900">{overdueTasks.length}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Продления</h2>
            <p className="text-sm text-gray-500">Проекты с дедлайном в ближайшие 30 дней</p>
          </div>
          <div className="divide-y divide-gray-200">
            {renewals.map((project) => {
              const badge = getStatusBadge(project.status);
              const days = project.deadlineDate ? diffDaysFrom(project.deadlineDate, today) : null;
              return (
                <div key={project.id} className="px-6 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{project.client || 'Без названия'}</p>
                      <p className="text-xs text-gray-500">
                        {project.specialist || 'Без специалиста'} · дедлайн {formatDateLabel(project.deadlineDate)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {days !== null && (
                        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                          через {days} дн.
                        </span>
                      )}
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {renewals.length === 0 && (
              <div className="px-6 py-8 text-center text-sm text-gray-500">Нет продлений на 30 дней.</div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Продления по специалистам</h2>
            <p className="text-sm text-gray-500">Сколько проектов требует внимания</p>
          </div>
          <div className="divide-y divide-gray-200">
            {renewalsBySpecialist.map(([name, count]) => (
              <div key={name} className="flex items-center justify-between px-6 py-4">
                <span className="text-sm font-medium text-gray-900">{name}</span>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                  {count}
                </span>
              </div>
            ))}
            {renewalsBySpecialist.length === 0 && (
              <div className="px-6 py-8 text-center text-sm text-gray-500">Нет данных.</div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Проекты, заканчиваются в этом месяце</h2>
        </div>
        <div className="divide-y divide-gray-200">
          {endingThisMonth.map((project) => {
            const badge = getStatusBadge(project.status);
            return (
              <div key={project.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">{project.client || 'Без названия'}</p>
                  <p className="text-xs text-gray-500">
                    {project.specialist || 'Без специалиста'} · дедлайн {formatDateLabel(project.deadlineDate)}
                  </p>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
                  {badge.label}
                </span>
              </div>
            );
          })}
          {endingThisMonth.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-gray-500">Нет проектов с дедлайном в этом месяце.</div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Проблемы по задачам</h2>
          <p className="text-sm text-gray-500">Просроченные задачи по проектам</p>
        </div>
        <div className="divide-y divide-gray-200">
          {overdueTasks.map((task) => (
            <div key={task.id} className="px-6 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{task.title}</p>
                  <p className="text-xs text-gray-500">
                    {task.projectName} · {task.specialist} · дедлайн {formatDateLabel(task.deadlineDate)}
                  </p>
                </div>
                <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
                  Просрочено
                </span>
              </div>
            </div>
          ))}
          {overdueTasks.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-gray-500">Просроченных задач нет.</div>
          )}
        </div>
      </div>
    </div>
  );
}
