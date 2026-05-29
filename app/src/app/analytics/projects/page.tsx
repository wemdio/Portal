'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { Project } from '@/types';
import { logError } from '@/lib/loggerClient';
import { diffDaysFrom, formatDateLabel, parseFlexibleDate } from '@/lib/dateUtils';
import { resolveProjectStatus, isCompletedStatus, STATUS_TONE_VAR } from '@/lib/projectStatus';
import { getDemoProjects } from '@/lib/demo/analyticsProjectsDemo';

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

type EnrichedProject = Project & { deadlineDate: Date | null };

// Urgency tiers — the spine of the redesign. The old page split renewals
// (<=30d) and overdue into two blocks far apart; here everything that needs
// attention lives in ONE feed, ranked overdue → due-soon → renewal.
type Tier = 'overdue' | 'soon' | 'renewal';

const TIER_META: Record<Tier, { label: string; dot: string; text: string }> = {
  overdue: { label: 'Просрочено', dot: 'var(--cp-red)', text: 'var(--cp-red)' },
  soon: { label: 'Скоро дедлайн · ≤7 дней', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  renewal: { label: 'Продления · ≤30 дней', dot: 'var(--cp-paper-faint)', text: 'var(--cp-paper-mute)' },
};

function tierOf(days: number | null): Tier | null {
  if (days === null) return null;
  if (days < 0) return 'overdue';
  if (days <= 7) return 'soon';
  if (days <= 30) return 'renewal';
  return null;
}

function deadlineText(days: number): string {
  if (days < 0) return `${Math.abs(days)} дн. назад`;
  if (days === 0) return 'сегодня';
  return `через ${days} дн.`;
}

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

function DetailCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="ds-eyebrow">{label}</p>
      <p className="mt-0.5 truncate text-xs font-medium" style={{ color: highlight ? 'var(--cp-paper)' : 'var(--cp-paper-mute)' }}>
        {value}
      </p>
    </div>
  );
}

function ProjectExpandedDetails({ project }: { project: EnrichedProject }) {
  const contractUrl = normalizeUrl(project.contract_link);
  const handoffUrl = normalizeUrl(project.handoff_link);
  const hasAnyData =
    project.manager || project.contacts_obligation || project.contacts_done ||
    project.kpi_plan || project.kpi_fact || project.budget || contractUrl || handoffUrl;

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

  const cDone = Number(project.contacts_done);
  const cObl = Number(project.contacts_obligation);
  const contactsPct =
    Number.isFinite(cDone) && Number.isFinite(cObl) && cObl > 0 ? Math.round((cDone / cObl) * 100) : null;

  return (
    <div className="px-5 pb-4 pt-3" style={{ borderTop: '1px solid var(--cp-divider)' }}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {project.manager && <DetailCell label="pm / лид" value={project.manager} />}
        {(project.contacts_done || project.contacts_obligation) && (
          <DetailCell
            label="контакты"
            value={`${project.contacts_done || '0'} / ${project.contacts_obligation || '—'}${contactsPct !== null ? ` · ${contactsPct}%` : ''}`}
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
            <a href={contractUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 block truncate text-xs font-medium underline" style={{ color: 'var(--cp-paper)' }}>Открыть →</a>
          </div>
        )}
        {handoffUrl && (
          <div className="min-w-0">
            <p className="ds-eyebrow">пост передачи</p>
            <a href={handoffUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 block truncate text-xs font-medium underline" style={{ color: 'var(--cp-paper)' }}>Открыть →</a>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className="h-4 w-4 shrink-0 transition-transform duration-200" style={{ color: 'var(--cp-paper-faint)', transform: open ? 'rotate(180deg)' : 'none' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/** One project in the unified attention feed. Expandable, keyboard-accessible. */
function AttentionRow({ project, days, isFirst }: { project: EnrichedProject; days: number; isFirst: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const tier = tierOf(days)!;
  const toggle = () => setExpanded((v) => !v);

  return (
    <div style={{ borderTop: isFirst ? undefined : '1px solid var(--cp-divider)' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
        className="ds-card-pressable flex items-center gap-3 px-5 py-3"
      >
        <span aria-hidden className="ds-status-dot" style={{ background: TIER_META[tier].dot }} />
        <ChevronIcon open={expanded} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${project.id}`}
              onClick={(e) => e.stopPropagation()}
              className="truncate text-sm font-medium hover:underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              {project.client || project.name || 'Без названия'}
            </Link>
            {project.manager && (
              <span className="ds-mono hidden shrink-0 text-[10px] sm:inline" style={{ color: 'var(--cp-paper-faint)' }}>
                {project.manager}
              </span>
            )}
          </div>
          <p className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
            {project.specialist || 'Без специалиста'}
            <span style={{ color: 'var(--cp-paper-faint)' }}>{' · дедлайн '}{formatDateLabel(project.deadlineDate)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="ds-mono text-xs font-medium" style={{ color: TIER_META[tier].text }}>
            {deadlineText(days)}
          </span>
          <span className="hidden sm:inline"><StatusTag status={project.status} /></span>
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
  const [specialist, setSpecialist] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const demoMode = process.env.NEXT_PUBLIC_UI_DEMO === '1';
    try {
      const { data, error: qErr } = await supabase.from('projects').select('*');
      if (qErr) throw qErr;
      const rows = (data ?? []) as Project[];
      setProjects(rows.length === 0 && demoMode ? getDemoProjects() : rows);
    } catch (err) {
      // UI-only/demo mode has no backend — show representative data instead of
      // an error so the layout can be reviewed populated.
      if (demoMode) {
        setProjects(getDemoProjects());
      } else {
        void logError('analytics.projects.fetch.failed', err);
        setError('Не удалось загрузить проекты. Попробуйте ещё раз.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const today = useMemo(() => new Date(), []);

  const enriched = useMemo<EnrichedProject[]>(
    () => projects.map((p) => ({ ...p, deadlineDate: parseFlexibleDate(p.deadline) })),
    [projects],
  );

  // The attention feed: every non-completed project with a deadline inside a
  // tier, ranked most-overdue → furthest-renewal.
  const attention = useMemo(
    () =>
      enriched
        .filter((p) => !isCompletedStatus(p.status) && p.deadlineDate)
        .map((p) => ({ p, days: diffDaysFrom(p.deadlineDate as Date, today) }))
        .filter((x) => tierOf(x.days) !== null)
        .sort((a, b) => a.days - b.days),
    [enriched, today],
  );

  const specialists = useMemo(() => {
    const set = new Set<string>();
    attention.forEach((x) => set.add(x.p.specialist || 'Без специалиста'));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [attention]);

  const visible = useMemo(
    () => (specialist === 'all' ? attention : attention.filter((x) => (x.p.specialist || 'Без специалиста') === specialist)),
    [attention, specialist],
  );

  // Group the visible feed by tier, preserving the overdue→soon→renewal order.
  const grouped = useMemo(() => {
    const order: Tier[] = ['overdue', 'soon', 'renewal'];
    return order
      .map((tier) => ({ tier, items: visible.filter((x) => tierOf(x.days) === tier) }))
      .filter((g) => g.items.length > 0);
  }, [visible]);

  const stats = useMemo(() => {
    const overdue = attention.filter((x) => x.days < 0).length;
    const renewals = attention.filter((x) => x.days >= 0).length; // 0..30
    const active = enriched.filter((p) => !isCompletedStatus(p.status)).length;
    return { total: projects.length, active, renewals, overdue };
  }, [attention, enriched, projects.length]);

  const specialistLoad = useMemo(() => {
    const map = new Map<string, { overdue: number; total: number }>();
    attention.forEach((x) => {
      const name = x.p.specialist || 'Без специалиста';
      const cur = map.get(name) ?? { overdue: 0, total: 0 };
      cur.total += 1;
      if (x.days < 0) cur.overdue += 1;
      map.set(name, cur);
    });
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.overdue - a.overdue || b.total - a.total);
  }, [attention]);

  const overdueTasks = useMemo(
    () =>
      attention
        .filter((x) => x.days < 0)
        .flatMap(({ p }) =>
          splitTasks(p.hypotheses || p.weekly_tasks).map((task, i) => ({
            id: `${p.id ?? 'p'}-${i}`,
            title: task,
            projectName: p.client || p.name || 'Без названия',
            projectId: p.id,
            specialist: p.specialist || 'Без специалиста',
            deadlineDate: p.deadlineDate,
          })),
        ),
    [attention],
  );

  return (
    // Capped reading column: the attention feed is a triage list, not a wide
    // data table — full width left rows sparse with a huge empty middle on big
    // screens. max-w-5xl is NOT in the .ui-density-compact override list (which
    // forces 100% on 6xl/1400/1600/900), so the cap actually holds here.
    <div className="space-y-6 max-w-5xl">
      <header>
        <p className="ds-eyebrow mb-1">аналитика</p>
        <h1 className="m-0 text-2xl font-semibold" style={{ color: 'var(--cp-paper)' }}>Проекты</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Что требует внимания: продления, дедлайны и просроченные задачи.
        </p>
      </header>

      {error ? (
        <div className="neu-card flex items-center gap-3 px-5 py-3.5" role="alert">
          <span aria-hidden className="ds-status-dot" style={{ background: 'var(--cp-red)' }} />
          <span className="flex-1 text-sm" style={{ color: 'var(--cp-paper)' }}>{error}</span>
          <button type="button" onClick={() => void load()} className="ds-btn-secondary shrink-0 text-xs">Повторить</button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-24"><div className="neu-spinner animate-spin" /></div>
      ) : (
        <>
          {/* Distilled portfolio signal — replaces the 4 stat cards with one
              editorial mono line; the two urgent figures carry semantic colour. */}
          <p className="ds-mono text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            <span className="font-semibold" style={{ color: 'var(--cp-paper)' }}>{stats.total}</span> проектов
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            <span className="font-semibold" style={{ color: 'var(--cp-paper)' }}>{stats.active}</span> активных
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            <span className="font-semibold" style={{ color: 'var(--cp-amber)' }}>{stats.renewals}</span> продлений ≤30 дн
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            <span className="font-semibold" style={{ color: 'var(--cp-red)' }}>{stats.overdue}</span> просрочено
          </p>

          {/* Specialist filter — triage one person's at-risk projects fast. */}
          {specialists.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Фильтр по специалисту">
              {['all', ...specialists].map((name) => {
                const active = specialist === name;
                return (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSpecialist(name)}
                    className="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                    style={
                      active
                        ? { color: 'var(--cp-ink)', background: 'var(--cp-paper)' }
                        : { color: 'var(--cp-paper-mute)', background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }
                    }
                  >
                    {name === 'all' ? 'Все' : name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Unified attention feed — overdue → due-soon → renewals, ranked. */}
          <section className="neu-card overflow-hidden">
            {grouped.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm" style={{ color: 'var(--cp-paper-faint)' }}>
                Ничего не требует внимания в ближайшие 30 дней.
              </div>
            ) : (
              grouped.map((group, gi) => (
                <div key={group.tier}>
                  <div
                    className="flex items-center gap-2 px-5 py-2.5"
                    style={{
                      borderTop: gi === 0 ? undefined : '1px solid var(--cp-divider)',
                      background: 'var(--cp-surface-elev)',
                    }}
                  >
                    <span aria-hidden className="ds-status-dot" style={{ background: TIER_META[group.tier].dot }} />
                    <span className="ds-eyebrow" style={{ color: TIER_META[group.tier].text }}>
                      {TIER_META[group.tier].label}
                    </span>
                    <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      {group.items.length}
                    </span>
                  </div>
                  {group.items.map((x, i) => (
                    <AttentionRow key={x.p.id} project={x.p} days={x.days} isFirst={i === 0} />
                  ))}
                </div>
              ))
            )}
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Specialist load */}
            <section className="neu-card overflow-hidden">
              <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--cp-divider)' }}>
                <h2 className="m-0 text-base font-semibold" style={{ color: 'var(--cp-paper)' }}>Загрузка по специалистам</h2>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>Сколько проектов в зоне внимания · из них просрочено</p>
              </div>
              <div>
                {specialistLoad.map(({ name, total, overdue }, i) => (
                  <div key={name} className="flex items-center justify-between px-5 py-3" style={{ borderTop: i === 0 ? undefined : '1px solid var(--cp-divider)' }}>
                    <span className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>{name}</span>
                    <span className="ds-mono text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
                      <span className="font-semibold" style={{ color: 'var(--cp-paper)' }}>{total}</span>
                      {overdue > 0 && (
                        <>
                          <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
                          <span className="font-semibold" style={{ color: 'var(--cp-red)' }}>{overdue}</span>
                          <span style={{ color: 'var(--cp-paper-faint)' }}> просроч.</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {specialistLoad.length === 0 && (
                  <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--cp-paper-faint)' }}>Нет данных.</div>
                )}
              </div>
            </section>

            {/* Problem tasks on overdue projects */}
            <section className="neu-card overflow-hidden">
              <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--cp-divider)' }}>
                <h2 className="m-0 text-base font-semibold" style={{ color: 'var(--cp-paper)' }}>Проблемные задачи</h2>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>Задачи на просроченных проектах</p>
              </div>
              <div>
                {overdueTasks.map((task, i) => (
                  <div key={task.id} className="px-5 py-3" style={{ borderTop: i === 0 ? undefined : '1px solid var(--cp-divider)' }}>
                    <p className="m-0 text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>{task.title}</p>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                      <Link href={`/projects/${task.projectId}`} className="hover:underline" style={{ color: 'var(--cp-paper-mute)' }}>{task.projectName}</Link>
                      <span style={{ color: 'var(--cp-paper-faint)' }}>{' · '}{task.specialist}{' · дедлайн '}{formatDateLabel(task.deadlineDate)}</span>
                    </p>
                  </div>
                ))}
                {overdueTasks.length === 0 && (
                  <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--cp-paper-faint)' }}>Просроченных задач нет.</div>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
