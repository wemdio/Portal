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
import { ENG_REFILL_SPEND_PAUSED_SHORT_EN, engAutopilotHoldText, engRefillHoldText } from './engText';
import { HE_TEAM_ON_IT_SHORT_EN } from './clientFailureText';
// Только тип — см. пояснение в engText.ts: набор состояний один на оба конца
// провода, а сам модуль проекции в клиентский бандл не уезжает.
import type { HeClientRefillState } from '@/lib/hypothesisEngine/clientEngProjection';
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
  // Запуск записан, но не закончен — нужен шаг клиента (шаг 5), поэтому amber.
  launch_unfinished: { tag: 'launch unfinished', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  launched: { tag: 'live', dot: 'var(--cp-green)', text: 'var(--cp-green)' },
};

/**
 * Письма шаблона этапа запуск откажет (`letters_need_rewrite` агрегата: роут
 * считает признак проекции `needs_rewrite`, heTemplateNeedsRewrite, для
 * шаблона этапа 'template' или 'launch_unfinished'). Нет поля (ответ старше)
 * — false, подписи прежние.
 */
function lettersNeedRewrite(vertical: EngDashboardVertical): boolean {
  return vertical.letters_need_rewrite === true;
}

/** Тег вместо «ready to launch»: шаблон есть, но запуск его письма откажет. */
const LETTERS_REWRITE_STATUS = { tag: 'letters need rewriting', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
/** Следующий шаг такой вертикали — за менеджером, а не за кнопкой запуска. */
const LETTERS_REWRITE_NEXT_LINE = 'next: ask your manager to rewrite the letters';

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

/**
 * Шаг мастера проекта, куда ведёт кнопка вертикали. Сухая вертикаль ведёт на
 * шаг 2: кнопка «Resume auto-refill» живёт там.
 */
function wizardStepFor(stage: EngDashStage, refillHeldHere: boolean): number {
  switch (stage) {
    case 'research':
      return 2; // Verticals: там живёт прогресс research
    case 'letters':
      return 3; // Letters
    case 'launch_unfinished':
      return 5; // Review & Launch: там достраивается запуск
    case 'launched':
      return refillHeldHere ? 2 : 4;
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
  /**
   * Маркер текущей строки: amber — работа идёт (точка пульсирует), held —
   * остановлено и само не возобновится (точка янтарная, неподвижная),
   * green — остальные состояния живой вертикали (точка зелёная, неподвижная).
   */
  marker?: 'amber' | 'green' | 'held';
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
    case 'launch_unfinished':
      return 6;
    case 'launched':
      return 6;
  }
}

/**
 * Что кабинет говорит про ночной добор одной строкой — по ВСЕМ пяти
 * состояниям проекта, без шестого «наверное».
 *
 * `paused` НЕ схлопывается в `not configured`: добор настроен и нужен, просто
 * сегодня его некуда грузить, и обещать «next run 03:20 UTC» проекту, который
 * ночь пропустит, нельзя (эта фраза и была ложью до правки). Срок здесь не
 * называется намеренно: возвращает проект в добор сотрудник, руками, и когда
 * освободится место — кабинет не знает. Причину не называем (решение владельца
 * 04.10.2026): короткая общая фраза справочника, правдивая потому, что пауза по
 * ёмкости шлёт алерт команде (см. HE_TEAM_ON_IT_EN в clientFailureText.ts).
 *
 * `spend_paused` — та же колонка, записанная потолком расхода проекта: алерт
 * у неё есть, но это не сбой, и «временная проблема» про неё неправда —
 * короткая фраза в духе HE_SPEND_PAUSED_EN (ENG_REFILL_SPEND_PAUSED_SHORT_EN).
 *
 * `stopped` — та же колонка паузы, но записанная отменой проекта («Cancel all
 * jobs»): алерта у неё нет, проблемы на нашей стороне нет, поэтому фраза своя —
 * что произошло и кто вернёт (engRefillHoldText).
 */
const REFILL_NEXT_LINE: Record<HeClientRefillState, string> = {
  running: 'next: daily refill 03:20 UTC',
  paused: `next: daily refill on hold — ${HE_TEAM_ON_IT_SHORT_EN}`,
  spend_paused: `next: daily refill on hold — ${ENG_REFILL_SPEND_PAUSED_SHORT_EN}`,
  stopped: 'next: daily refill stopped — project cancelled, your manager can restart it',
  off: 'next: daily refill — not configured',
};

/** То же коротко — в строку «Daily refill» карты пайплайна. */
const REFILL_PIPE_EVIDENCE: Record<HeClientRefillState, string> = {
  running: 'next 03:20 UTC',
  paused: `on hold — ${HE_TEAM_ON_IT_SHORT_EN}`,
  spend_paused: 'on hold — paused on our side',
  stopped: 'stopped — project cancelled',
  off: 'not configured',
};

/**
 * Ночной добор ПРОЕКТА идёт, но ЭТУ вертикаль правило сухой вертикали с него
 * сняло (`refill_dry`). Только для `running`: у `paused`, `spend_paused`,
 * `stopped` и `off` своя, более общая правда — добора нет у всего проекта.
 */
const REFILL_DRY_NEXT_LINE = 'next: daily refill paused for this vertical — resume it on step 2';
const REFILL_DRY_PIPE_EVIDENCE = 'paused for this vertical';

/** Строка «next: …» — следующий шаг конвейера из текущей стадии. */
function nextLineFor(stage: EngDashStage, refill: HeClientRefillState, dry: boolean, rewrite: boolean): string {
  // Шаблон этапа запуск откажет: ни «launch», ни «finish the launch» не сработают.
  if (rewrite && (stage === 'template' || stage === 'launch_unfinished')) return LETTERS_REWRITE_NEXT_LINE;
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
    case 'launch_unfinished':
      return 'next: finish the launch on step 5 «Review & Launch»';
    case 'launched':
      return refill === 'running' && dry ? REFILL_DRY_NEXT_LINE : REFILL_NEXT_LINE[refill];
  }
}

function buildPipelineRows(
  vertical: EngDashboardVertical,
  job: EngDashboardActiveJob | undefined,
  refill: HeClientRefillState,
): PipeRow[] {
  const s = vertical.stats;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const launched = vertical.stage === 'launched';
  const launchUnfinished = vertical.stage === 'launch_unfinished';
  // Признак ставится только шаблону этапа 'template' / 'launch_unfinished'.
  const rewrite = lettersNeedRewrite(vertical) && (vertical.stage === 'template' || launchUnfinished);
  const dryHere = refill === 'running' && vertical.refill_dry === true;
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

  // «Сколько собрано»: компании, если стадия их посчитала, иначе строки — и
  // тогда под своим именем. `stats.companies` (companies_total) у баз старше
  // 26.09.2026 нет, роут отдаёт 0; строки известны всегда, но строка ≠ компания
  // (ENG разносит один адрес на строку), поэтому делить их на кап и называть
  // компаниями нельзя — печатаем «rows». Обе цифры пусты → подписи нет.
  const collected = (prefix: string): string =>
    s.companies > 0
      ? `${prefix}${fmt(s.companies)} companies`
      : s.rows > 0
        ? `${prefix}${fmt(s.rows)} rows`
        : '';

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
          : stateOf(2) === 'done'
            ? collected('')
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
          : stateOf(4) === 'done'
            ? collected('analyzed ')
            : '',
    },
    {
      key: 'template',
      label: 'Template',
      state: stateOf(5),
      evidence:
        stateOf(5) === 'done'
          ? rewrite
            ? 'letters need rewriting'
            : 'template ready'
          : vertical.stage === 'analyzed' && job?.stage === 'template'
            ? withEta('building template…')
            : '',
    },
    {
      key: 'launch',
      label: 'Launch',
      state: stateOf(6),
      // Незаконченный запуск сам не достроится — точка неподвижная (held), а
      // не «идёт работа». Так же у шаблона, чьи письма запуск откажет: до
      // переписки писем запуска не будет.
      ...(launchUnfinished || rewrite ? { marker: 'held' as const } : {}),
      // White-label: имя кампании — подпись, а не ссылка. Наружу вести некуда:
      // у клиента нет своего входа в рассыльщик, а сама ссылка светила бы бренд.
      evidence: launchUnfinished ? (
        rewrite ? 'unfinished — these letters cannot finish it' : 'unfinished — finish it on step 5'
      ) : launched ? (
        <>
          {s.leads_launched > 0 ? `${fmt(s.leads_launched)} leads` : ''}
          {s.leads_launched > 0 && vertical.launch?.campaign_name ? ' · ' : ''}
          {vertical.launch?.campaign_name && (
            <span style={{ color: 'var(--cp-paper)' }}>{vertical.launch.campaign_name}</span>
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
      // Маркер — тоже утверждение, и под паузой оба прежних врали: зелёная
      // точка значит «живой цикл», пульсирующая янтарная — «прямо сейчас
      // работает». Остановленный добор не то и не другое, поэтому у него своя
      // точка: янтарная, но неподвижная — и у пауз (ёмкость, потолок расхода), и
      // у отмены проекта. Сухая вертикаль — тот же «held»: проект идёт, а её
      // ночь не берёт.
      marker: refillRunning
        ? 'amber'
        : refill === 'paused' || refill === 'spend_paused' || refill === 'stopped' || dryHere
          ? 'held'
          : 'green',
      evidence: refillRunning
        ? withEta('collecting refill…')
        : `${s.appended_today > 0 ? `+${fmt(s.appended_today)} today · ` : ''}${
            dryHere ? REFILL_DRY_PIPE_EVIDENCE : REFILL_PIPE_EVIDENCE[refill]
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
                      row.marker === 'green' || row.marker === 'held'
                        ? undefined
                        : 'eng-dash-pulse 1.6s ease-in-out infinite',
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
   green — запуск/долив (заработанный плюс), red — сбой, amber — нужен шаг
   клиента (незаконченный запуск, как и у статуса вертикали), остальное —
   спокойный paper-faint. Никакой «радуги» по типам событий. */
const EVENT_ICON: Record<EngDashboardEvent['type'], { Icon: typeof Mail; color: string }> = {
  letters_ready: { Icon: Mail, color: 'var(--cp-paper-faint)' },
  base_collected: { Icon: Database, color: 'var(--cp-paper-faint)' },
  base_analyzed: { Icon: CheckCircle2, color: 'var(--cp-paper-faint)' },
  template_ready: { Icon: Wand2, color: 'var(--cp-paper-faint)' },
  launched: { Icon: Rocket, color: 'var(--cp-green)' },
  launch_unfinished: { Icon: Rocket, color: 'var(--cp-amber)' },
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
  refill,
}: {
  vertical: EngDashboardVertical;
  index: number;
  showProject: boolean;
  projectName: string;
  activeJob: EngDashboardActiveJob | undefined;
  /** Состояние ночного добора ПРОЕКТА этой вертикали, а не аккаунта. */
  refill: HeClientRefillState;
}) {
  const dryHere = refill === 'running' && vertical.refill_dry === true;
  const step = wizardStepFor(vertical.stage, dryHere);
  const launched = vertical.stage === 'launched';
  const rewrite = lettersNeedRewrite(vertical);
  // Незаконченный запуск остаётся «launch unfinished» (это правда и с
  // признаком) — меняются его строка Launch и «next»; готовый шаблон теряет
  // «ready to launch».
  const status = rewrite && vertical.stage === 'template' ? LETTERS_REWRITE_STATUS : STAGE_STATUS[vertical.stage];
  const rows = buildPipelineRows(vertical, activeJob, refill);

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
          {nextLineFor(vertical.stage, refill, vertical.refill_dry === true, rewrite)}
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2">
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
  /*
   * «Collected today» — КОМПАНИИ, когда роут их знает, иначе СТРОКИ под своим
   * именем (то же правило, что у карточки вертикали). Строки — не адреса: у
   * компании без найденного адреса одна пустая строка, и таких часто
   * большинство, поэтому подпись «address rows» над этим числом врала.
   * `collected_companies` = 0 при ненулевых строках значит «не знаем» (база без
   * счётчика компаний) — тогда печатаем строки.
   */
  const collectedCompanies = today.collected_companies ?? 0;
  const collectedTile =
    collectedCompanies > 0 || today.collected === 0
      ? { value: collectedCompanies, hint: 'companies collected' }
      : { value: today.collected, hint: 'rows collected, incl. companies with no address found' };
  const autoRefill = data?.autoRefill;
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  /**
   * Состояние ночного добора — ПО ПРОЕКТАМ, и весь набор целиком.
   *
   * Карточка «Auto-refill» одна на аккаунт, а пауза ставится проекту, поэтому
   * карточка печатает не одно состояние, а СОСТАВ: сколько проектов идёт,
   * сколько на паузе (по ёмкости — `paused`, по потолку расхода —
   * `spend_paused`; «on hold» правда про обе) и сколько остановлено отменой
   * (`stopped`); `off` в состав не входит — добора у него нет. Ветки карточки
   * ниже перебирают всё: есть идущие — обратный отсчёт и рядом счётчики
   * стоящих; идущих нет, но есть на паузе — «on hold» с фразой своего повода
   * (есть по ёмкости — её фраза и счётчик пауз по потолку рядом; только по
   * потолку — его фраза) и счётчик отменённых, если они тоже есть; только
   * отменённые — «stopped»; иначе — «off». Смешанный случай и есть тот, из-за
   * которого одного булева флага мало: обратный отсчёт для идущих правдив, но
   * умолчать про стоящие рядом с ним было бы тем же обещанием добора, которого
   * не будет.
   *
   * Поля может не быть (ответ старше этой волны) — читаем как `off`: до
   * механизма паузы кабинет ровно так и считал проект без конфига.
   */
  const refillByProject = new Map<string, HeClientRefillState>(
    projects.map((p) => [p.id, p.refill ?? 'off']),
  );
  const refillCapacityHeldCount = projects.filter((p) => p.refill === 'paused').length;
  const refillSpendHeldCount = projects.filter((p) => p.refill === 'spend_paused').length;
  const refillHeldCount = refillCapacityHeldCount + refillSpendHeldCount;
  const refillStoppedProjects = projects.filter((p) => p.refill === 'stopped');
  const refillRunningCount = projects.filter((p) => p.refill === 'running').length;
  // Блок объяснений под карточками: паузы и отмена — каждая своей фразой.
  const refillExplainedProjects = projects.flatMap((p) =>
    p.refill === 'paused' || p.refill === 'spend_paused' || p.refill === 'stopped'
      ? [{ id: p.id, name: p.name, state: p.refill }]
      : [],
  );
  const projectsWord = (n: number) => `${n} project${n === 1 ? '' : 's'}`;
  // Хвост подписи про стоящие проекты — только ненулевые части.
  const stoppedSuffix = refillStoppedProjects.length > 0 ? ` · ${projectsWord(refillStoppedProjects.length)} stopped` : '';
  // Паузы по потолку рядом с фразой паузы по ёмкости: у них своя правда.
  const spendHeldSuffix =
    refillSpendHeldCount > 0 ? ` · ${projectsWord(refillSpendHeldCount)} paused on our side` : '';
  // Проекты, которые автопилот не продвинул на последней сверке. Роут отдаёт
  // сюда только код причины и только по проектам без активных джоб, поэтому
  // здесь остаётся отобрать непустые — и сразу с СУЖЕННЫМ кодом, чтобы экран
  // не подпирал его восклицательным знаком.
  const heldProjects = projects.flatMap((p) =>
    p.autopilot_hold ? [{ id: p.id, name: p.name, hold: p.autopilot_hold }] : [],
  );
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
                  // Единица «Collected today» выбрана выше (collectedTile).
                  { label: 'Collected today', value: collectedTile.value, hint: collectedTile.hint },
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
                {/* Обратный отсчёт показываем ровно тогда, когда в ближайшую
                    ночь реально пойдёт хотя бы один проект; если при этом
                    другие стоят, подпись их называет. Ни одного идущего —
                    отсчёта нет вовсе: тикать до ночи, которая проекту ничего
                    не поставит, и есть то самое обещание. */}
                {autoRefill && refillRunningCount > 0 ? (
                  <>
                    <RefillCountdown nextRunAt={autoRefill.next_run_at} />
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      next run 03:20 UTC · daily cap {autoRefill.daily_cap.toLocaleString('en-US')}
                      {refillHeldCount > 0 ? ` · ${projectsWord(refillHeldCount)} on hold` : ''}
                      {stoppedSuffix}
                    </span>
                  </>
                ) : refillHeldCount > 0 ? (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-amber)' }}>
                      on hold
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      {refillCapacityHeldCount > 0
                        ? `${HE_TEAM_ON_IT_SHORT_EN}${spendHeldSuffix}`
                        : ENG_REFILL_SPEND_PAUSED_SHORT_EN}
                      {stoppedSuffix}
                    </span>
                  </>
                ) : refillStoppedProjects.length > 0 ? (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-paper-mute)' }}>
                      stopped
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      {refillStoppedProjects.length === 1 ? 'project' : 'projects'} cancelled — your manager can
                      restart the daily refill
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

          {/* Проект, который автопилот не продвинул. Место выбрано по вопросу,
              с которым клиент сюда и приходит: «почему ничего не происходит?» —
              поэтому блок стоит сразу под «Right now», где идущих стадий как
              раз нет. Ссылка ведёт в мастер проекта: там та же фраза и шаг 2 с
              «Start outreach»; собственной кнопки здесь нет намеренно —
              дашборд ничего не запускает. */}
          {heldProjects.length > 0 && (
            <EngCard className="flex flex-col gap-2">
              <span className="ds-eyebrow">Autopilot</span>
              {heldProjects.map((p) => (
                <Link
                  key={p.id}
                  href={`/client/eng/projects/${p.id}` as Route}
                  prefetch={false}
                  className="text-xs hover:underline"
                  style={{ color: 'var(--cp-amber)' }}
                >
                  <span className="font-semibold">{p.name}</span> — {engAutopilotHoldText(p.hold.code)}
                </Link>
              ))}
            </EngCard>
          )}

          {/* Проект, которому остановили ночной добор: из-за нехватки места под
              новые контакты (`paused`) или потолком расхода (`spend_paused`) —
              клиенту причина не называется — или отменой проекта (`stopped`):
              у каждого своя фраза (engRefillHoldText). Отдельный блок, а не
              строка в карточке: карточка отвечает «когда следующая ночь», а
              здесь нужно сказать, что произошло и кто это разберёт, — в 10
              пикселей подписи это не влезает, а недосказанность здесь и была
              ложью.
              Ссылки нет намеренно, в отличие от блока автопилота: в мастере
              проекта клиенту с этим делать нечего — паузу снимает сотрудник,
              и кнопки для клиента у неё нет и не должно быть (мутирующая
              клиентская ручка означала бы право клиента запускать платную
              работу провайдера). Отмена — не тревога, поэтому её строка не
              янтарная. */}
          {refillExplainedProjects.length > 0 && (
            <EngCard className="flex flex-col gap-2">
              <span className="ds-eyebrow">Auto-refill</span>
              {refillExplainedProjects.map((p) => (
                <p
                  key={p.id}
                  className="text-xs m-0"
                  style={{ color: p.state === 'stopped' ? 'var(--cp-paper-mute)' : 'var(--cp-amber)' }}
                >
                  <span className="font-semibold">{p.name}</span> — {engRefillHoldText(p.state)}
                </p>
              ))}
            </EngCard>
          )}

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
                          refill={refillByProject.get(v.project_id) ?? 'off'}
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
