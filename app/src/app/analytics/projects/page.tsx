'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { Project } from '@/types';
import { logError } from '@/lib/loggerClient';
import {
  diffDaysFrom,
  formatDateLabel,
  isPastDate,
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

const normalizeUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return null;
};

type EnrichedProject = Project & {
  deadlineDate: Date | null;
};

function ProjectExpandedDetails({ project }: { project: EnrichedProject }) {
  const contractUrl = normalizeUrl(project.contract_link);
  const handoffUrl = normalizeUrl(project.handoff_link);

  const hasAnyData =
    project.manager ||
    project.contacts_obligation ||
    project.contacts_done ||
    project.kpi_plan ||
    project.kpi_fact ||
    contractUrl ||
    handoffUrl;

  if (!hasAnyData) {
    return (
      <div className="px-6 pb-4 pt-1 text-xs text-gray-400">
        Нет дополнительных данных.{' '}
        <Link href={`/projects/${project.id}`} className="text-blue-500 hover:underline">
          Заполнить в проекте &rarr;
        </Link>
      </div>
    );
  }

  return (
    <div className="px-6 pb-4 pt-1">
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        {project.manager && (
          <DetailCell label="PM / Лид" value={project.manager} />
        )}
        {(project.contacts_done || project.contacts_obligation) && (
          <DetailCell
            label="Контакты"
            value={`${project.contacts_done || '0'} / ${project.contacts_obligation || '—'}`}
            highlight={!!project.contacts_done}
          />
        )}
        {(project.kpi_plan || project.kpi_fact) && (
          <DetailCell
            label="KPI план / факт"
            value={`${project.kpi_plan || '—'} / ${project.kpi_fact || '—'}`}
          />
        )}
        {project.budget && (
          <DetailCell label="Бюджет" value={project.budget} />
        )}
        {contractUrl && (
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Договор</p>
            <a
              href={contractUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block truncate text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              Открыть &rarr;
            </a>
          </div>
        )}
        {handoffUrl && (
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Пост передачи</p>
            <a
              href={handoffUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block truncate text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              Открыть &rarr;
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">{label}</p>
      <p className={`mt-0.5 truncate text-xs font-medium ${highlight ? 'text-gray-900' : 'text-gray-700'}`}>
        {value}
      </p>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ProjectRow({ project, today }: { project: EnrichedProject; today: Date }) {
  const [expanded, setExpanded] = useState(false);
  const badge = getStatusBadge(project.status);
  const days = project.deadlineDate ? diffDaysFrom(project.deadlineDate, today) : null;
  const isOverdue = days !== null && days < 0;

  return (
    <div className={`border-b border-gray-100 last:border-b-0 ${isOverdue ? 'bg-red-50/30' : ''}`}>
      <div
        className="flex cursor-pointer items-center gap-3 px-6 py-4 transition-colors hover:bg-gray-50/70"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronIcon open={expanded} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${project.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-medium text-gray-900 hover:text-blue-600 hover:underline transition-colors truncate"
            >
              {project.client || 'Без названия'}
            </Link>
            {project.manager && (
              <span className="hidden shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 sm:inline-flex">
                {project.manager}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            {project.specialist || 'Без специалиста'} · дедлайн {formatDateLabel(project.deadlineDate)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {(project.contacts_done || project.contacts_obligation) && (
            <span className="hidden rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-medium text-gray-600 md:inline-flex">
              {project.contacts_done || '0'} / {project.contacts_obligation || '—'} контактов
            </span>
          )}
          {days !== null && (
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                isOverdue
                  ? 'bg-red-50 text-red-700'
                  : days <= 7
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-gray-50 text-gray-600'
              }`}
            >
              {isOverdue ? `${Math.abs(days)} дн. назад` : `через ${days} дн.`}
            </span>
          )}
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
            {badge.label}
          </span>
        </div>
      </div>

      {expanded && <ProjectExpandedDetails project={project} />}
    </div>
  );
}

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

  const renewals = useMemo(
    () =>
      enrichedProjects
        .filter(
          (project) =>
            project.deadlineDate &&
            isWithinDays(project.deadlineDate, today, 30) &&
            !isCompletedStatus(project.status),
        )
        .sort((a, b) => {
          const da = a.deadlineDate ? diffDaysFrom(a.deadlineDate, today) : 999;
          const db = b.deadlineDate ? diffDaysFrom(b.deadlineDate, today) : 999;
          return da - db;
        }),
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
          projectId: project.id,
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

  const activeProjects = useMemo(
    () => enrichedProjects.filter((p) => !isCompletedStatus(p.status)),
    [enrichedProjects],
  );

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

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Всего проектов</p>
          <p className="text-2xl font-semibold text-gray-900">{projects.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Активных</p>
          <p className="text-2xl font-semibold text-gray-900">{activeProjects.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Продления (30 дней)</p>
          <p className="text-2xl font-semibold text-amber-600">{renewals.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Просроченных</p>
          <p className="text-2xl font-semibold text-red-600">{overdueProjects.length}</p>
        </div>
      </div>

      {/* Renewals — main block */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Продления</h2>
          <p className="text-sm text-gray-500">
            Проекты с дедлайном в ближайшие 30 дней · нажмите на строку чтобы раскрыть детали
          </p>
        </div>
        <div>
          {renewals.map((project) => (
            <ProjectRow key={project.id} project={project} today={today} />
          ))}
          {renewals.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-gray-500">Нет продлений на ближайшие 30 дней.</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* By specialist */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Продления по специалистам</h2>
            <p className="text-sm text-gray-500">Сколько проектов требует внимания</p>
          </div>
          <div className="divide-y divide-gray-100">
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

        {/* Overdue projects */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 bg-red-50/50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Просроченные проекты</h2>
            <p className="text-sm text-gray-500">Дедлайн уже прошёл, но проект не завершён</p>
          </div>
          <div className="divide-y divide-gray-100">
            {overdueProjects.map((project) => {
              const days = project.deadlineDate ? diffDaysFrom(project.deadlineDate, today) : null;
              return (
                <div key={project.id} className="flex items-center justify-between gap-3 px-6 py-4">
                  <div className="min-w-0">
                    <Link
                      href={`/projects/${project.id}`}
                      className="text-sm font-medium text-gray-900 hover:text-blue-600 hover:underline"
                    >
                      {project.client || 'Без названия'}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {project.specialist || 'Без специалиста'} · дедлайн {formatDateLabel(project.deadlineDate)}
                    </p>
                  </div>
                  {days !== null && (
                    <span className="shrink-0 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
                      {Math.abs(days)} дн. назад
                    </span>
                  )}
                </div>
              );
            })}
            {overdueProjects.length === 0 && (
              <div className="px-6 py-8 text-center text-sm text-gray-500">Просроченных нет.</div>
            )}
          </div>
        </div>
      </div>

      {/* Overdue tasks */}
      {overdueTasks.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Проблемы по задачам</h2>
            <p className="text-sm text-gray-500">Просроченные задачи по проектам</p>
          </div>
          <div className="divide-y divide-gray-100">
            {overdueTasks.map((task) => (
              <div key={task.id} className="px-6 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{task.title}</p>
                    <p className="text-xs text-gray-500">
                      <Link href={`/projects/${task.projectId}`} className="hover:text-blue-600 hover:underline">
                        {task.projectName}
                      </Link>
                      {' · '}{task.specialist} · дедлайн {formatDateLabel(task.deadlineDate)}
                    </p>
                  </div>
                  <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
                    Просрочено
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
