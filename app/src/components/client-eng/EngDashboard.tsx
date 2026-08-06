'use client';

/**
 * ENG Command Center (/client/eng/dashboard): общий экран по всем ENG-проектам
 * клиента — этап каждой вертикали, статистика за сегодня, следующий авто-добор
 * (countdown до 03:20 UTC, тикает локально), активные джобы и лента событий.
 *
 * Данные — один агрегат GET /api/client/eng/dashboard, опрос раз в 15с
 * (в скрытой вкладке сервер не дёргаем); countdown и анимации — чисто
 * клиентские (CSS keyframes + rAF), realtime-подписок нет. Тексты — английские.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  ExternalLink,
  LayoutGrid,
  Mail,
  RefreshCw,
  Rocket,
  Wand2,
} from 'lucide-react';
import {
  fetchEngDashboard,
  type EngDashboardActiveJob,
  type EngDashboardEvent,
  type EngDashboardVertical,
  type EngDashboardResponse,
  type EngDashStage,
} from './api-client';
import { EngCard, EngSpinner } from './ui';

const POLL_INTERVAL_MS = 15000;

/* ── Визуальная модель этапов: серый → синий → фиолетовый → зелёный ── */

const STAGE_META: Record<EngDashStage, { color: string; pulse: boolean }> = {
  research: { color: '#84848c', pulse: true },
  letters: { color: '#4f9cf9', pulse: false },
  collecting: { color: '#8b5cf6', pulse: true },
  construct: { color: '#8b5cf6', pulse: true },
  analyzing: { color: '#8b5cf6', pulse: true },
  analyzed: { color: '#8b5cf6', pulse: false },
  template: { color: '#c084fc', pulse: false },
  launched: { color: 'var(--cp-green)', pulse: false },
};

const DOT_LABELS = ['research', 'letters', 'base', 'template', 'launched'] as const;

const JOB_STAGE_LABELS: Record<string, string> = {
  site_profile: 'profiling the site',
  competitors: 'mapping competitors',
  brand_cloud: 'building brand cloud',
  hypotheses: 'drafting hypotheses',
  evidence: 'collecting evidence',
  clustering: 'clustering verticals',
  chain: 'writing letters',
  vocab: 'building vocabulary',
  base_collect: 'collecting the base',
  base_analyze: 'analyzing the base',
  template: 'building the template',
  dossier: 'writing the dossier',
};

/** Шаг мастера проекта, куда ведёт кнопка вертикали. */
function wizardStepFor(stage: EngDashStage): number {
  switch (stage) {
    case 'research':
      return 2; // Verticals: там живёт прогресс research
    case 'letters':
      return 3; // Letters
    default:
      return 4; // Bases & Launch
  }
}

/* ── Анимированный счётчик (ease-out нарастание при изменении значения) ── */

function CountUp({ value, style }: { value: number; style?: React.CSSProperties }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    let raf = 0;
    const started = performance.now();
    const DURATION = 700;
    const tick = (t: number) => {
      const p = Math.min(1, (t - started) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className="ds-mono" style={style}>
      {display.toLocaleString('en-US')}
    </span>
  );
}

/* ── Countdown до следующего авто-добора (тикает локально, без запросов) ── */

function RefillCountdown({ nextRunAt }: { nextRunAt: string }) {
  const target = Date.parse(nextRunAt);
  // Текущее время — состояние, тикает раз в секунду; остаток выводится на
  // рендере (setState только в callback интервала, без sync-стейта в effect).
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const leftMs = Math.max(0, target - nowTs);
  if (leftMs <= 0) {
    return (
      <span className="ds-mono text-2xl font-bold" style={{ color: 'var(--cp-amber)' }}>
        starting…
      </span>
    );
  }
  const totalSec = Math.floor(leftMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="ds-mono text-2xl font-bold tabular-nums" style={{ color: 'var(--cp-paper)' }}>
      {pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

/* ── Пилюля этапа с цветом и пульсом активных ── */

function StagePill({ stage }: { stage: EngDashStage }) {
  const meta = STAGE_META[stage];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: meta.color, border: `1px solid ${meta.color}` }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: meta.color,
          animation: meta.pulse ? 'eng-dash-pulse 1.6s ease-in-out infinite' : undefined,
        }}
      />
      {stage}
    </span>
  );
}

/* ── Мини-прогресс из 5 точек ── */

function DotsProgress({ dots, stage }: { dots: boolean[]; stage: EngDashStage }) {
  const activeIdx = dots.findIndex((d) => !d);
  const color = STAGE_META[stage].color;
  return (
    <div className="flex items-start gap-0" role="img" aria-label={`Stage: ${stage}`}>
      {DOT_LABELS.map((label, i) => {
        const done = dots[i] === true;
        const active = i === activeIdx;
        const dotColor = done || active ? color : 'var(--cp-divider-strong)';
        return (
          <div key={label} className="flex items-start">
            {i > 0 && (
              <span
                className="mt-[5px] inline-block h-px w-3 sm:w-4"
                style={{ background: dots[i - 1] ? color : 'var(--cp-divider-strong)' }}
              />
            )}
            <span className="flex flex-col items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                title={label}
                style={{
                  background: dotColor,
                  animation: active ? 'eng-dash-pulse 1.6s ease-in-out infinite' : undefined,
                }}
              />
              <span
                className="text-[8px] uppercase tracking-wide"
                style={{ color: done || active ? 'var(--cp-text-m)' : 'var(--cp-text-l)' }}
              >
                {label}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Лента событий ── */

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const EVENT_ICON: Record<EngDashboardEvent['type'], { Icon: typeof Mail; color: string }> = {
  letters_ready: { Icon: Mail, color: '#4f9cf9' },
  base_collected: { Icon: Database, color: '#8b5cf6' },
  base_analyzed: { Icon: CheckCircle2, color: '#8b5cf6' },
  template_ready: { Icon: Wand2, color: '#c084fc' },
  launched: { Icon: Rocket, color: 'var(--cp-green)' },
  refill_appended: { Icon: RefreshCw, color: 'var(--cp-green)' },
  refill_empty: { Icon: RefreshCw, color: 'var(--cp-text-l)' },
  failed: { Icon: AlertTriangle, color: 'var(--cp-red)' },
};

function EventRow({ event, withBorder }: { event: EngDashboardEvent; withBorder: boolean }) {
  const { Icon, color } = EVENT_ICON[event.type] ?? EVENT_ICON.refill_empty;
  return (
    <li
      className="flex items-center gap-2.5 py-1.5"
      style={withBorder ? { borderTop: '1px solid var(--cp-divider)' } : undefined}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
        {event.text}
      </span>
      <span className="shrink-0 text-[10px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
        {relTime(event.at)}
      </span>
    </li>
  );
}

/* ── Полоска «Right now»: активные джобы ── */

function activeJobText(job: EngDashboardActiveJob, verticalName: string): string {
  const label = JOB_STAGE_LABELS[job.stage] ?? job.stage;
  const progress =
    job.progress && (job.progress.total ?? 0) > 0
      ? ` ${job.progress.done ?? 0}/${job.progress.total}${job.progress.label ? ` · ${job.progress.label}` : ''}`
      : job.progress?.label
        ? ` · ${job.progress.label}`
        : '';
  return `${label}${progress}${verticalName ? ` · ${verticalName}` : ''}`;
}

function ActiveJobsStrip({
  jobs,
  verticalNames,
}: {
  jobs: EngDashboardActiveJob[];
  verticalNames: Map<string, string>;
}) {
  return (
    <div
      className="neu-card px-4 py-2.5 flex items-center gap-2.5 text-xs"
      style={{ animation: 'eng-dash-in 0.5s ease-out both' }}
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{
          background: 'var(--cp-amber)',
          animation: 'eng-dash-pulse 1.2s ease-in-out infinite',
        }}
      />
      <span className="font-semibold shrink-0" style={{ color: 'var(--cp-amber)' }}>
        Right now
      </span>
      <span className="min-w-0 truncate" style={{ color: 'var(--cp-text-m)' }}>
        {jobs.map((j) => activeJobText(j, j.vertical_id ? (verticalNames.get(j.vertical_id) ?? '') : '')).join('  ·  ')}
      </span>
    </div>
  );
}

/* ── Карточка вертикали ── */

function VerticalCard({
  vertical,
  index,
  showProject,
  projectName,
}: {
  vertical: EngDashboardVertical;
  index: number;
  showProject: boolean;
  projectName: string;
}) {
  const step = wizardStepFor(vertical.stage);
  const launched = vertical.stage === 'launched';
  return (
    <div
      className="neu-card p-4 flex flex-col gap-2.5 transition-colors hover:border-[var(--cp-divider-strong)]"
      style={{ animation: `eng-dash-in 0.5s ease-out ${index * 70}ms both` }}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
          {vertical.name}
        </span>
        <span className="ml-auto shrink-0">
          <StagePill stage={vertical.stage} />
        </span>
      </div>
      {showProject && (
        <div className="truncate text-[10px] uppercase tracking-wide" style={{ color: 'var(--cp-text-l)' }}>
          {projectName}
        </div>
      )}

      <DotsProgress dots={vertical.dots} stage={vertical.stage} />

      <div className="text-[11px]" style={{ color: STAGE_META[vertical.stage].color }}>
        {vertical.stageDetail}
      </div>

      {(() => {
        const s = vertical.stats;
        const hasAny =
          s.companies > 0 || s.emails_found > 0 || s.valid_count > 0 ||
          s.appended_today > 0 || s.leads_launched > 0;
        // Все нули (ранняя вертикаль) — строка статистики только шумит.
        if (!hasAny) return null;
        return (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
            <span>{s.companies.toLocaleString('en-US')} companies</span>
            <span>{s.emails_found.toLocaleString('en-US')} emails</span>
            <span>{s.valid_count.toLocaleString('en-US')} valid</span>
            {s.appended_today > 0 && (
              <span style={{ color: 'var(--cp-green)' }}>+{s.appended_today.toLocaleString('en-US')} today</span>
            )}
            {s.leads_launched > 0 && (
              <span>{s.leads_launched.toLocaleString('en-US')} launched</span>
            )}
          </div>
        );
      })()}

      <div className="mt-auto flex items-center gap-2 pt-1">
        {vertical.launch?.campaign_url && (
          <a
            href={vertical.launch.campaign_url}
            target="_blank"
            rel="noopener noreferrer"
            className="neu-pill px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5"
            style={{ color: 'var(--cp-green)' }}
          >
            <ExternalLink className="h-3 w-3" />
            Open in Instantly
          </a>
        )}
        <Link
          href={`/client/eng/projects/${vertical.project_id}?step=${step}` as Route}
          prefetch={false}
          className="neu-pill px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 ml-auto"
          style={{ color: 'var(--cp-paper)' }}
        >
          {launched ? 'View' : 'Continue'}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

/* ── Дашборд ── */

export function EngDashboard() {
  const [data, setData] = useState<EngDashboardResponse | null>(null);
  const [error, setError] = useState('');
  const loadingRef = useRef(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    // Тихий полл не плодит параллельные запросы при медленной БД.
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setData(await fetchEngDashboard());
      setError('');
    } catch (e) {
      if (!opts.silent) {
        setError(e instanceof Error ? e.message : 'Failed to load the dashboard');
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Один запрос агрегата раз в 15с; в фоновой вкладке сервер не дёргаем.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const projects = data?.projects ?? [];
  const verticals = data?.verticals ?? [];
  const events = data?.events ?? [];
  const activeJobs = data?.activeJobs ?? [];
  const today = data?.today ?? { appended: 0, valid: 0, collected: 0 };
  const autoRefill = data?.autoRefill;
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const verticalNames = new Map(verticals.map((v) => [v.id, v.name]));

  return (
    <div className="flex flex-col gap-5">
      <style>{`
        @keyframes eng-dash-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes eng-dash-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>

      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
            ENG Command Center
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Live view across all your verticals — refreshed every 15s.
          </p>
        </div>
        <Link
          href={'/client/eng?list=1' as Route}
          prefetch={false}
          className="neu-pill ml-auto px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5"
          style={{ color: 'var(--cp-paper)' }}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          All projects
        </Link>
      </header>

      {error && !data ? (
        <div className="neu-card p-5 text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner /> Loading the command center…
        </div>
      ) : (
        <>
          {/* Статистика за сегодня + авто-добор */}
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Today">
            {(
              [
                { label: 'Appended today', value: today.appended, color: 'var(--cp-green)', hint: 'leads added to campaigns' },
                { label: 'Valid today', value: today.valid, color: '#8b5cf6', hint: 'emails passed validation' },
                { label: 'Collected today', value: today.collected, color: '#4f9cf9', hint: 'new companies harvested' },
              ] as const
            ).map((card, i) => (
              <div
                key={card.label}
                className="neu-card p-4 sm:p-5 flex flex-col gap-1"
                style={{ animation: `eng-dash-in 0.5s ease-out ${i * 70}ms both` }}
              >
                <span className="ds-eyebrow">{card.label}</span>
                <CountUp value={card.value} style={{ fontSize: '1.75rem', fontWeight: 700, color: card.color }} />
                <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
                  {card.hint}
                </span>
              </div>
            ))}
            <div
              className="neu-card p-4 sm:p-5 flex flex-col gap-1"
              style={{ animation: 'eng-dash-in 0.5s ease-out 210ms both' }}
            >
              <span className="ds-eyebrow">Auto-refill</span>
              {autoRefill?.enabled ? (
                <>
                  <RefillCountdown nextRunAt={autoRefill.next_run_at} />
                  <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
                    until the next run · daily cap {autoRefill.daily_cap.toLocaleString('en-US')} · 03:20 UTC
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold" style={{ color: 'var(--cp-text-l)' }}>
                    Off
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
                    daily refill is not configured yet
                  </span>
                </>
              )}
            </div>
          </section>

          {activeJobs.length > 0 && <ActiveJobsStrip jobs={activeJobs} verticalNames={verticalNames} />}

          {/* Вертикали */}
          {verticals.length === 0 ? (
            <EngCard className="flex flex-col items-center gap-3 py-10 text-center">
              <Rocket className="h-8 w-8" style={{ color: 'var(--cp-text-l)' }} />
              <p className="text-sm font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
                No verticals yet — create a project
              </p>
              <p className="text-xs m-0 max-w-md" style={{ color: 'var(--cp-text-m)' }}>
                The engine researches your market, drafts letters, collects a base and launches
                campaigns — every vertical shows up here live.
              </p>
              <Link
                href={'/client/eng?list=1' as Route}
                prefetch={false}
                className="neu-pill active px-4 py-2 text-sm font-semibold inline-flex items-center gap-2"
                style={{ color: 'var(--cp-paper)' }}
              >
                Create a project
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </EngCard>
          ) : (
            <section aria-label="Verticals" className="flex flex-col gap-4">
              {(projects.length > 1 ? projects : [{ id: '', name: '' }]).map((p) => {
                const list = projects.length > 1 ? verticals.filter((v) => v.project_id === p.id) : verticals;
                if (list.length === 0) return null;
                return (
                  <div key={p.id || 'all'} className="flex flex-col gap-2.5">
                    {projects.length > 1 && <h3 className="ds-eyebrow">{projectNames.get(p.id) ?? p.name}</h3>}
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {list.map((v, i) => (
                        <VerticalCard
                          key={v.id}
                          vertical={v}
                          index={i}
                          showProject={projects.length > 1}
                          projectName={projectNames.get(v.project_id) ?? ''}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* Лента событий */}
          {events.length > 0 && (
            <EngCard>
              <h3 className="ds-eyebrow mb-2">Recent events</h3>
              <ul className="flex flex-col">
                {events.map((e, i) => (
                  <EventRow key={`${e.at}-${i}`} event={e} withBorder={i > 0} />
                ))}
              </ul>
            </EngCard>
          )}
        </>
      )}
    </div>
  );
}
