'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  resolveProjectStatus,
  isCompletedStatus,
  STATUS_TONE_VAR,
} from '@/lib/projectStatus';

const splitTasks = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|•|;+/)
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
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

/** 6px semantic dot + mono uppercase label — Status-as-Data. */
function StatusTag({ status }: { status: string | null | undefined }) {
  const { label, tone } = resolveProjectStatus(status);
  return (
    <span className="ds-status-tag" style={{ color: 'var(--cp-paper-mute)' }}>
      <span aria-hidden className="ds-status-dot" style={{ background: STATUS_TONE_VAR[tone] }} />
      {label}
    </span>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'amber' | 'red' }) {
  const color = tone === 'amber' ? 'var(--cp-amber)' : tone === 'red' ? 'var(--cp-red)' : 'var(--cp-paper)';
  return (
    <div className="neu-card p-4">
      <p className="ds-eyebrow">{label}</p>
      <p className="ds-mono mt-2 text-2xl font-semibold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--cp-divider)' }}>
      <h2 className="m-0 text-base font-semibold" style={{ color: 'var(--cp-paper)' }}>
        {title}
      </h2>
      {hint && (
        <p className="mt-0.5 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function DetailCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="ds-eyebrow">{label}</p>
      <p
        className="mt-0.5 truncate text-xs font-medium"
        style={{ color: highlight ? 'var(--cp-paper)' : 'var(--cp-paper-mute)' }}
      >
        {value}
      </p>
    </div>
  );
}

function ProjectExpandedDetails({ project }: { project: EnrichedProject }) {
  const contractUrl = normalizeUrl(project.contract_link);
  const handoffUrl = normalizeUrl(project.handoff_link);

  const hasAnyData =
    project.manager ||
    project.contacts_obligation ||
    project.contacts_done ||
    project.kpi_plan ||
    project.kpi_fact ||
    project.budget ||
    contractUrl ||
    handoffUrl;

  if (!hasAnyData) {
    return (
      <div className="px-5 pb-4 pt-3 text-xs" style={{ borderTop: '1px solid var(--cp-divider)', color: 'var(--cp-paper-faint)' }}>
        Нет дополнительных данных.{' '}
        <Link href={`/projects/${project.id}`} className="underline" style={{ color: 'var(--cp-paper-mute)' }}>
          Заполнить в проекте →
        </Link>
      </div>
    );
  }

  // Append contacts % when both sides are numeric (P2-D: stop forcing mental math).
  const cDone = Number(project.contacts_done);
  const cObl = Number(project.contacts_obligation);
  const contactsPct =
    Number.isFinite(cDone) && Number.isFinite(cObl) && cObl > 0
      ? Math.round((cDone / cObl) * 100)
      : null;

  return (
    <div className="px-5 pb-4 pt-3" style={{ borderTop: '1px solid var(--cp-divider)' }}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {project.manager && <DetailCell label="pm / лид" value={project.manager} />}
        {(project.contacts_done || project.contacts_obligation) && (
          <DetailCell
            label="контакты"
            value={`${project.contacts_done || '0'} / ${project.contacts_obligation || '—'}${
              contactsPct !== null ? ` · ${contactsPct}%` : ''
            }`}
            highlight={!!project.contacts_done}
          />
        )}
        {(project.kpi_plan || project.kpi_fact) && (
          <DetailCell label="kpi план / факт" value={`${project.kpi_plan || '—'} / ${project.kpi_fact || '—'}`} />
        )}
        {project.budget && <DetailCell label="бюджет" value={project.budget} />}
        {contractUrl && (
          <div className="min-w-0">
            <p className="ds-eyebrow">договор</p>
            <a
              href={contractUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block truncate text-xs font-medium underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              Открыть →
            </a>
          </div>
        )}
        {handoffUrl && (
          <div className="min-w-0">
            <p className="ds-eyebrow">пост передачи</p>
            <a
              href={handoffUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block truncate text-xs font-medium underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              Открыть →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="h-4 w-4 shrink-0 transition-transform duration-200"
      style={{ color: 'var(--cp-paper-faint)', transform: open ? 'rotate(180deg)' : 'none' }}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ProjectRow({ project, today, isFirst }: { project: EnrichedProject; today: Date; isFirst: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const days = project.deadlineDate ? diffDaysFrom(project.deadlineDate, today) : null;
  const isOverdue = days !== null && days < 0;
  const deadlineTone = isOverdue
    ? 'var(--cp-red)'
    : days !== null && days <= 7
      ? 'var(--cp-amber)'
      : 'var(--cp-paper-mute)';

  const toggle = () => setExpanded((v) => !v);

  return (
    <div
      style={{
        borderTop: isFirst ? undefined : '1px solid var(--cp-divider)',
        // The single tinted-background concession (Option B): overdue rows get
        // a faint red wash so they pull the eye in a long renewals list.
        background: isOverdue ? 'var(--cp-red-wash)' : undefined,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className="ds-card-pressable flex items-center gap-3 px-5 py-3"
      >
        <ChevronIcon open={expanded} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${project.id}`}
              onClick={(e) => e.stopPropagation()}
              className="truncate text-sm font-medium hover:underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              {project.client || 'Без названия'}
            </Link>
            {project.manager && (
              <span className="ds-mono hidden shrink-0 text-[10px] sm:inline" style={{ color: 'var(--cp-paper-faint)' }}>
                {project.manager}
              </span>
            )}
          </div>
          <p className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
            {project.specialist || 'Без специалиста'}
            <span style={{ color: 'var(--cp-paper-faint)' }}>
              {' · дедлайн '}
              {formatDateLabel(project.deadlineDate)}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {days !== null && (
            <span className="ds-mono text-xs font-medium" style={{ color: deadlineTone }}>
              {isOverdue ? `${Math.abs(days)} дн. назад` : `через ${days} дн.`}
            </span>
          )}
          <StatusTag status={project.status} />
        </div>
      </div>

      {expanded && <ProjectExpandedDetails project={project} />}
    </div>
  );
}

export default function ProjectsAnalyticsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: qErr } = await supabase.from('projects').select('*');
      if (qErr) throw qErr;
      setProjects((data ?? []) as Project[]);
    } catch (err) {
      void logError('analytics.projects.fetch.failed', err);
      setError('Не удалось загрузить проекты. Попробуйте ещё раз.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="admin-portal space-y-6">
      <header>
        <p className="ds-eyebrow mb-1">аналитика</p>
        <h1 className="m-0 text-2xl font-semibold" style={{ color: 'var(--cp-paper)' }}>
          Проекты
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Продления, дедлайны и проблемные задачи по проектам.
        </p>
      </header>

      {error ? (
        <div className="neu-card flex items-center gap-3 px-5 py-3.5" role="alert">
          <span aria-hidden className="ds-status-dot" style={{ background: 'var(--cp-red)' }} />
          <span className="flex-1 text-sm" style={{ color: 'var(--cp-paper)' }}>
            {error}
          </span>
          <button type="button" onClick={() => void load()} className="ds-btn-secondary shrink-0 text-xs">
            Повторить
          </button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="neu-spinner animate-spin" />
        </div>
      ) : (
        <>
          {/* Stat row — mono tabular numbers; renewals/overdue carry semantic colour. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="всего проектов" value={projects.length} />
            <StatCard label="активных" value={activeProjects.length} />
            <StatCard label="продления · 30 дней" value={renewals.length} tone="amber" />
            <StatCard label="просроченных" value={overdueProjects.length} tone="red" />
          </div>

          {/* Renewals — primary block */}
          <section className="neu-card overflow-hidden">
            <SectionHeader
              title="Продления"
              hint="Дедлайн в ближайшие 30 дней · нажмите на строку чтобы раскрыть детали"
            />
            <div>
              {renewals.map((project, idx) => (
                <ProjectRow key={project.id} project={project} today={today} isFirst={idx === 0} />
              ))}
              {renewals.length === 0 && (
                <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--cp-paper-faint)' }}>
                  Нет продлений на ближайшие 30 дней.
                </div>
              )}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* By specialist */}
            <section className="neu-card overflow-hidden">
              <SectionHeader title="Продления по специалистам" hint="Сколько проектов требует внимания" />
              <div>
                {renewalsBySpecialist.map(([name, count], idx) => (
                  <div
                    key={name}
                    className="flex items-center justify-between px-5 py-3"
                    style={{ borderTop: idx === 0 ? undefined : '1px solid var(--cp-divider)' }}
                  >
                    <span className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>
                      {name}
                    </span>
                    <span className="ds-mono text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
                      {count}
                    </span>
                  </div>
                ))}
                {renewalsBySpecialist.length === 0 && (
                  <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--cp-paper-faint)' }}>
                    Нет данных.
                  </div>
                )}
              </div>
            </section>

            {/* Overdue projects */}
            <section className="neu-card overflow-hidden">
              <SectionHeader title="Просроченные проекты" hint="Дедлайн уже прошёл, но проект не завершён" />
              <div>
                {overdueProjects.map((project, idx) => {
                  const days = project.deadlineDate ? diffDaysFrom(project.deadlineDate, today) : null;
                  return (
                    <div
                      key={project.id}
                      className="flex items-center justify-between gap-3 px-5 py-3"
                      style={{ borderTop: idx === 0 ? undefined : '1px solid var(--cp-divider)' }}
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/projects/${project.id}`}
                          className="text-sm font-medium hover:underline"
                          style={{ color: 'var(--cp-paper)' }}
                        >
                          {project.client || 'Без названия'}
                        </Link>
                        <p className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                          {project.specialist || 'Без специалиста'}
                          <span style={{ color: 'var(--cp-paper-faint)' }}>
                            {' · дедлайн '}
                            {formatDateLabel(project.deadlineDate)}
                          </span>
                        </p>
                      </div>
                      {days !== null && (
                        <span className="ds-mono shrink-0 text-xs font-medium" style={{ color: 'var(--cp-red)' }}>
                          {Math.abs(days)} дн. назад
                        </span>
                      )}
                    </div>
                  );
                })}
                {overdueProjects.length === 0 && (
                  <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--cp-paper-faint)' }}>
                    Просроченных нет.
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Overdue tasks — block title already says "просроченные", so the
              per-row "Просрочено" pill is dropped (P2-B, redundant signal). */}
          {overdueTasks.length > 0 && (
            <section className="neu-card overflow-hidden">
              <SectionHeader title="Проблемы по задачам" hint="Просроченные задачи по проектам" />
              <div>
                {overdueTasks.map((task, idx) => (
                  <div
                    key={task.id}
                    className="px-5 py-3"
                    style={{ borderTop: idx === 0 ? undefined : '1px solid var(--cp-divider)' }}
                  >
                    <p className="m-0 text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>
                      {task.title}
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                      <Link
                        href={`/projects/${task.projectId}`}
                        className="hover:underline"
                        style={{ color: 'var(--cp-paper-mute)' }}
                      >
                        {task.projectName}
                      </Link>
                      <span style={{ color: 'var(--cp-paper-faint)' }}>
                        {' · '}
                        {task.specialist}
                        {' · дедлайн '}
                        {formatDateLabel(task.deadlineDate)}
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
