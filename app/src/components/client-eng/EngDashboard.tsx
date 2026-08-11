'use client';

/**
 * Command Center (/client/eng/dashboard): общий экран по всем ENG-проектам
 * клиента. IA карточки вертикали — «карта пайплайна»: вертикальный список
 * стадий человеческими именами (Research → Letters → Lead base → Email
 * enrichment → Analysis → Template → Launch, у live-вертикали + Daily refill)
 * с маркерами done/current/future и короткими доказательствами цифрами из
 * агрегата; строка «next: …» внизу — следующий шаг конвейера.
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
  Check,
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

/* ── Статус вертикали: dot + uppercase mono-tag (status-tag из DESIGN.md).
   Цвет — только как данные: amber — работа идёт или нужен шаг клиента,
   grey — этап пройден, конвейер ждёт следующего, green — вертикаль live. ── */

const STAGE_STATUS: Record<EngDashStage, { tag: string; dot: string; text: string }> = {
  research: { tag: 'research', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  letters: { tag: 'letters', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  collecting: { tag: 'collecting', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  construct: { tag: 'enrichment', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  analyzing: { tag: 'analysis', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  analyzed: { tag: 'analyzed', dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
  template: { tag: 'ready to launch', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  launched: { tag: 'live', dot: 'var(--cp-green)', text: 'var(--cp-green)' },
};

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
    // prefers-reduced-motion: без нарастания — сразу финальное значение
    // (matchMedia может отсутствовать в jsdom — тогда анимируем как обычно).
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (from === to || reduceMotion) {
      setDisplay(to);
      fromRef.current = to;
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
      <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-amber)' }}>
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
    <span className="ds-mono text-base font-medium tabular-nums" style={{ color: 'var(--cp-paper)' }}>
      {pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

/* ── Карта пайплайна вертикали ── */

/** Человеческие имена стадий конвейера (без внутреннего жаргона этапов). */
interface PipeRow {
  key: string;
  label: string;
  state: 'done' | 'current' | 'future';
  /** Маркер текущей строки: amber — работа идёт, green — живой цикл (refill). */
  marker?: 'amber' | 'green';
  /** Короткое доказательство цифрами; только то, что есть в агрегате. */
  evidence?: React.ReactNode;
}

/** Индекс текущей стадии в пайплайне (0 Research … 6 Launch). */
function currentIndexFor(vertical: EngDashboardVertical): number {
  switch (vertical.stage) {
    case 'research':
      return 0;
    case 'letters':
      // Цепочка уже готова (вторая точка агрегата) — фронт работы сместился
      // на сбор базы; сами письма при этом показываем пройденными.
      return vertical.dots[1] === true ? 2 : 1;
    case 'collecting':
      return 2;
    case 'construct':
      return 3;
    case 'analyzing':
      return 4;
    case 'analyzed':
      return 5;
    case 'template':
      return 6;
    case 'launched':
      return 6;
  }
}

/** Строка «next: …» — следующий шаг конвейера из текущей стадии. */
function nextLineFor(stage: EngDashStage, refillEnabled: boolean): string {
  switch (stage) {
    case 'research':
      return 'next: verticals review';
    case 'letters':
      return 'next: base collection';
    case 'collecting':
      return 'next: email enrichment (after collection)';
    case 'construct':
      return 'next: analysis (after enrichment)';
    case 'analyzing':
      return 'next: template';
    case 'analyzed':
      return 'next: 85/15 template';
    case 'template':
      return 'next: launch from Review & Launch';
    case 'launched':
      return refillEnabled ? 'next: daily refill 03:20 UTC' : 'next: daily refill — not configured';
  }
}

function buildPipelineRows(
  vertical: EngDashboardVertical,
  job: EngDashboardActiveJob | undefined,
  refillEnabled: boolean,
): PipeRow[] {
  const s = vertical.stats;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const launched = vertical.stage === 'launched';
  const cur = currentIndexFor(vertical);
  const stateOf = (i: number): PipeRow['state'] =>
    launched || i < cur ? 'done' : i === cur ? 'current' : 'future';

  // ETA — только из данных: done/total активной джобы → «~N% done». Если
  // stageDetail уже несёт дробь («task 1/2», «87/147 valid»), не дублируем.
  const pct =
    job?.progress && (job.progress.total ?? 0) > 0
      ? Math.round(((job.progress.done ?? 0) / (job.progress.total ?? 1)) * 100)
      : null;
  const withEta = (text: string): string =>
    pct !== null && !text.includes('/') ? `${text} · ~${pct}% done` : text;

  const rows: PipeRow[] = [
    {
      key: 'research',
      label: 'Research',
      state: stateOf(0),
      // У research почти нет своих цифр — done-строка честно остаётся пустой.
      evidence: vertical.stage === 'research' ? withEta(vertical.stageDetail) : '',
    },
    {
      key: 'letters',
      label: 'Letters',
      state: stateOf(1),
      // Счётчика писем в агрегате нет — показываем только живую строку этапа.
      evidence:
        vertical.stage === 'letters' && vertical.dots[1] !== true
          ? withEta(vertical.stageDetail)
          : '',
    },
    {
      key: 'lead-base',
      label: 'Lead base',
      state: stateOf(2),
      evidence:
        vertical.stage === 'collecting'
          ? withEta(vertical.stageDetail)
          : stateOf(2) === 'done' && s.companies > 0
            ? `${fmt(s.companies)} companies`
            : '',
    },
    {
      key: 'enrichment',
      label: 'Email enrichment',
      state: stateOf(3),
      evidence:
        stateOf(3) !== 'future' && s.emails_found > 0
          ? `${fmt(s.valid_count)} / ${fmt(s.emails_found)} valid`
          : vertical.stage === 'construct'
            ? 'finding & validating emails…'
            : '',
    },
    {
      key: 'analysis',
      label: 'Analysis',
      state: stateOf(4),
      evidence:
        vertical.stage === 'analyzing'
          ? withEta(vertical.stageDetail)
          : stateOf(4) === 'done' && s.companies > 0
            ? `analyzed ${fmt(s.companies)} companies`
            : '',
    },
    {
      key: 'template',
      label: 'Template',
      state: stateOf(5),
      evidence:
        stateOf(5) === 'done'
          ? 'template ready'
          : vertical.stage === 'analyzed' && job?.stage === 'template'
            ? withEta('building template…')
            : '',
    },
    {
      key: 'launch',
      label: 'Launch',
      state: stateOf(6),
      evidence: launched ? (
        <>
          {s.leads_launched > 0 ? `${fmt(s.leads_launched)} leads` : ''}
          {s.leads_launched > 0 && vertical.launch?.campaign_url ? ' · ' : ''}
          {vertical.launch?.campaign_url && (
            <a
              href={vertical.launch.campaign_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              {vertical.launch.campaign_name || 'campaign'}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </>
      ) : (
        ''
      ),
    },
  ];

  if (launched) {
    const refillRunning = job?.stage === 'base_collect';
    rows.push({
      key: 'refill',
      label: 'Daily refill',
      state: 'current',
      marker: refillRunning ? 'amber' : 'green',
      evidence: refillRunning
        ? withEta('collecting refill…')
        : `${s.appended_today > 0 ? `+${fmt(s.appended_today)} today · ` : ''}${
            refillEnabled ? 'next 03:20 UTC' : 'not configured'
          }`,
    });
  }

  return rows;
}

function PipelineRows({ rows }: { rows: PipeRow[] }) {
  return (
    <ol className="flex flex-col">
      {rows.map((row, i) => (
        <li key={row.key} className="flex items-stretch gap-2.5">
          {/* Маркер стадии + hairline-коннектор к следующей строке */}
          <span className="flex w-3 shrink-0 flex-col items-center">
            <span className="mt-[4px] flex h-3 w-3 items-center justify-center">
              {row.state === 'done' ? (
                <Check className="h-3 w-3" style={{ color: 'var(--cp-paper-mute)' }} aria-hidden />
              ) : row.state === 'current' ? (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    background: row.marker === 'green' ? 'var(--cp-green)' : 'var(--cp-amber)',
                    animation:
                      row.marker === 'green' ? undefined : 'eng-dash-pulse 1.6s ease-in-out infinite',
                  }}
                />
              ) : (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ border: '1px solid var(--cp-divider-strong)' }}
                />
              )}
            </span>
            {i < rows.length - 1 && (
              <span className="w-px flex-1" style={{ background: 'var(--cp-divider)' }} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 pb-2">
            <span
              className={`text-xs ${row.state === 'current' ? 'font-medium' : ''}`}
              style={{
                color:
                  row.state === 'done'
                    ? 'var(--cp-paper-mute)'
                    : row.state === 'current'
                      ? 'var(--cp-paper)'
                      : 'var(--cp-paper-faint)',
              }}
            >
              {row.label}
            </span>
            {row.evidence ? (
              <span
                className="ds-mono text-right text-[11px]"
                style={{
                  color: row.state === 'current' ? 'var(--cp-paper-mute)' : 'var(--cp-paper-faint)',
                }}
              >
                {row.evidence}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
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

/* Иконки ленты — lucide фиксированного размера; цвет только со смыслом:
   green — запуск/долив (заработанный плюс), red — сбой, остальное — спокойный
   paper-faint. Никакой «радуги» по типам событий. */
const EVENT_ICON: Record<EngDashboardEvent['type'], { Icon: typeof Mail; color: string }> = {
  letters_ready: { Icon: Mail, color: 'var(--cp-paper-faint)' },
  base_collected: { Icon: Database, color: 'var(--cp-paper-faint)' },
  base_analyzed: { Icon: CheckCircle2, color: 'var(--cp-paper-faint)' },
  template_ready: { Icon: Wand2, color: 'var(--cp-paper-faint)' },
  launched: { Icon: Rocket, color: 'var(--cp-green)' },
  refill_appended: { Icon: RefreshCw, color: 'var(--cp-green)' },
  refill_empty: { Icon: RefreshCw, color: 'var(--cp-paper-faint)' },
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
      <span className="shrink-0 text-[10px] ds-mono" style={{ color: 'var(--cp-paper-faint)' }}>
        {relTime(event.at)}
      </span>
    </li>
  );
}

/* ── «Right now»: активные джобы строками в ds-card ── */

function ActiveJobsCard({
  jobs,
  verticalNames,
}: {
  jobs: EngDashboardActiveJob[];
  verticalNames: Map<string, string>;
}) {
  return (
    <section aria-label="Right now">
      <div className="ds-card px-4 py-3" style={{ animation: 'eng-dash-in 0.5s ease-out both' }}>
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: 'var(--cp-amber)', animation: 'eng-dash-pulse 1.2s ease-in-out infinite' }}
          />
          <span className="ds-eyebrow" style={{ color: 'var(--cp-amber)' }}>
            Right now
          </span>
        </div>
        <ul className="mt-1 flex flex-col">
          {jobs.map((job, i) => {
            const label = JOB_STAGE_LABELS[job.stage] ?? job.stage;
            const verticalName = job.vertical_id ? (verticalNames.get(job.vertical_id) ?? '') : '';
            const progress =
              job.progress && (job.progress.total ?? 0) > 0
                ? `${job.progress.done ?? 0}/${job.progress.total}${job.progress.label ? ` · ${job.progress.label}` : ''}`
                : (job.progress?.label ?? '');
            return (
              <li
                key={job.id}
                className="flex items-baseline gap-3 py-1.5"
                style={i > 0 ? { borderTop: '1px solid var(--cp-divider)' } : undefined}
              >
                <span className="min-w-0 truncate text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                  {label}
                  {verticalName ? ` · ${verticalName}` : ''}
                </span>
                {progress && (
                  <span
                    className="ml-auto shrink-0 ds-mono text-[11px]"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    {progress}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/* ── Карточка вертикали: заголовок + карта пайплайна + next + действия ── */

function VerticalCard({
  vertical,
  index,
  showProject,
  projectName,
  activeJob,
  refillEnabled,
}: {
  vertical: EngDashboardVertical;
  index: number;
  showProject: boolean;
  projectName: string;
  activeJob: EngDashboardActiveJob | undefined;
  refillEnabled: boolean;
}) {
  const step = wizardStepFor(vertical.stage);
  const launched = vertical.stage === 'launched';
  const status = STAGE_STATUS[vertical.stage];
  const rows = buildPipelineRows(vertical, activeJob, refillEnabled);

  return (
    <div
      data-testid="vertical-card"
      className="ds-card p-4 sm:p-5 flex flex-col gap-3"
      style={{ animation: `eng-dash-in 0.5s ease-out ${index * 70}ms both` }}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
          {vertical.name}
        </span>
        <span className="ds-status-tag ml-auto shrink-0" style={{ color: status.text }}>
          <span className="ds-status-dot" style={{ background: status.dot }} />
          {status.tag}
        </span>
      </div>
      {showProject && <div className="ds-eyebrow truncate">{projectName}</div>}

      <PipelineRows rows={rows} />

      {(vertical.forecast || vertical.actual) && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] ds-mono"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {vertical.forecast && (
            <span>
              forecast <b style={{ color: 'var(--cp-paper-mute)' }}>{vertical.forecast.pct}%</b>
            </span>
          )}
          {vertical.actual && (
            <span>
              actual{' '}
              <b
                style={{
                  color: vertical.actual.reply_pct > 0 ? 'var(--cp-green)' : 'var(--cp-paper-mute)',
                }}
              >
                {vertical.actual.reply_pct}%
              </b>{' '}
              replies · {vertical.actual.sent.toLocaleString('en-US')} sent
            </span>
          )}
        </div>
      )}

      <div className="pt-2.5" style={{ borderTop: '1px solid var(--cp-divider)' }}>
        <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
          {nextLineFor(vertical.stage, refillEnabled)}
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2">
        {vertical.launch?.campaign_url && (
          <a
            href={vertical.launch.campaign_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ds-btn-ghost inline-flex items-center gap-1.5"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Instantly
          </a>
        )}
        <Link
          href={`/client/eng/projects/${vertical.project_id}?step=${step}` as Route}
          prefetch={false}
          className="ds-btn-secondary ml-auto inline-flex items-center gap-1.5"
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
  const refillEnabled = autoRefill?.enabled === true;
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const verticalNames = new Map(verticals.map((v) => [v.id, v.name]));
  // Джоба вертикали для ETA/живых подписей (свежие первыми — берём первую).
  const jobByVertical = new Map<string, EngDashboardActiveJob>();
  for (const job of activeJobs) {
    if (job.vertical_id && !jobByVertical.has(job.vertical_id)) {
      jobByVertical.set(job.vertical_id, job);
    }
  }

  return (
    <div className="eng-dash flex flex-col gap-5">
      <style>{`
        @keyframes eng-dash-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes eng-dash-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @media (prefers-reduced-motion: reduce) {
          .eng-dash, .eng-dash * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
            Command Center
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Live view across all your verticals — refreshed every 15s.
          </p>
        </div>
        <Link
          href={'/client/eng?list=1' as Route}
          prefetch={false}
          className="ds-btn-ghost ml-auto inline-flex items-center gap-1.5"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          All projects
        </Link>
      </header>

      {error && !data ? (
        <div className="ds-card p-5 text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          <EngSpinner /> Loading the command center…
        </div>
      ) : (
        <>
          {/* 01 → Today: три тихих счётчика + авто-добор */}
          <section aria-label="Today">
            <h2 className="ds-eyebrow mb-2">01 → Today</h2>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {(
                [
                  // Счётчики — тихие mono-числа + label, без hero-метрик;
                  // цвет только paper, статусной окраски у агрегатов дня нет.
                  { label: 'Collected today', value: today.collected, hint: 'new companies harvested' },
                  { label: 'Valid today', value: today.valid, hint: 'emails passed validation' },
                  { label: 'Appended today', value: today.appended, hint: 'leads added to campaigns' },
                ] as const
              ).map((card, i) => (
                <div
                  key={card.label}
                  className="ds-card p-4 flex flex-col gap-1"
                  style={{ animation: `eng-dash-in 0.5s ease-out ${i * 70}ms both` }}
                >
                  <span className="ds-eyebrow">{card.label}</span>
                  <CountUp
                    value={card.value}
                    style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--cp-paper)' }}
                  />
                  <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                    {card.hint}
                  </span>
                </div>
              ))}
              <div
                className="ds-card p-4 flex flex-col gap-1"
                style={{ animation: 'eng-dash-in 0.5s ease-out 210ms both' }}
              >
                <span className="ds-eyebrow">Auto-refill</span>
                {autoRefill?.enabled ? (
                  <>
                    <RefillCountdown nextRunAt={autoRefill.next_run_at} />
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      next run 03:20 UTC · daily cap {autoRefill.daily_cap.toLocaleString('en-US')}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-paper-faint)' }}>
                      off
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      daily refill is not configured
                    </span>
                  </>
                )}
              </div>
            </div>
          </section>

          {activeJobs.length > 0 && <ActiveJobsCard jobs={activeJobs} verticalNames={verticalNames} />}

          {/* 02 → Verticals */}
          {verticals.length === 0 ? (
            <EngCard className="flex flex-col items-center gap-3 py-10 text-center">
              <Rocket className="h-8 w-8" style={{ color: 'var(--cp-paper-faint)' }} />
              <p className="text-sm font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
                No verticals yet — create a project
              </p>
              <p className="text-xs m-0 max-w-md" style={{ color: 'var(--cp-paper-mute)' }}>
                The engine researches your market, drafts letters, collects a base and launches
                campaigns — every vertical shows up here live.
              </p>
              <Link
                href={'/client/eng?list=1' as Route}
                prefetch={false}
                className="ds-btn-primary inline-flex items-center gap-2"
              >
                Create a project
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </EngCard>
          ) : (
            <section aria-label="Verticals" className="flex flex-col gap-4">
              <h2 className="ds-eyebrow">02 → Verticals</h2>
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
                          activeJob={v.id ? jobByVertical.get(v.id) : undefined}
                          refillEnabled={refillEnabled}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* 03 → Recent activity */}
          {events.length > 0 && (
            <section aria-label="Recent activity">
              <h2 className="ds-eyebrow mb-2">03 → Recent activity</h2>
              <EngCard>
                <ul className="flex flex-col">
                  {events.map((e, i) => (
                    <EventRow key={`${e.at}-${i}`} event={e} withBorder={i > 0} />
                  ))}
                </ul>
              </EngCard>
            </section>
          )}
        </>
      )}
    </div>
  );
}
