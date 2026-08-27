/**
 * Дизайн-система «Движка вертикалей»: токены (HE) и мелкие атомарные
 * компоненты. Концепция: минимализм без иконок — иерархия весом и размером,
 * один blue-акцент, статус = цветная точка + текст, шаги = номера.
 * Только светлые классы палитры gray/blue/emerald/amber/violet/red: тёмная
 * тема портала подхватывает их через overrides в globals.css
 * (html[data-portal-theme='dark'] .portal-shell …), dark:-варианты не нужны.
 *
 * Файл намеренно .ts (без JSX-синтаксиса): компоненты собираются через
 * createElement, тип возврата — JSX.Element из react.
 */

import { createElement, type JSX } from 'react';

export const HE = {
  // ── Поверхности ──────────────────────────────────────────────────────────
  /** Карточка: тонкая рамка + мягкая тень поднимает её над фоном страницы. */
  card: 'rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]',
  /** Hover-фидбек для кликабельных карточек: рамка темнеет, тень растёт. */
  cardHover: 'hover:border-gray-300/90 hover:shadow-[0_6px_24px_rgba(15,23,42,0.09)]',
  cardPad: 'p-5',
  /** Вторичная панель (вложенный блок, мета-зона): заливка без рамки. */
  panelSoft: 'rounded-xl bg-gray-50/80',
  /** Разделительная линия секций. */
  divider: 'border-gray-200/80',

  // ── Типографика (шкала ~1.125–1.2, иерархия размером и весом) ────────────
  /** Заголовок страницы/экрана. */
  pageTitle: 'text-[26px] font-semibold leading-tight tracking-tight text-gray-900',
  /** Заголовок секции внутри экрана. */
  sectionTitle: 'text-[15px] font-semibold tracking-tight text-gray-900',
  /** Заголовок карточки/блока. */
  cardTitle: 'text-[15px] font-semibold tracking-tight text-gray-900',
  /** Лид-абзац под заголовком. */
  lead: 'text-sm leading-relaxed text-gray-600',
  /** Тихий текст (мета, подписи). */
  muted: 'text-[13px] text-gray-500',
  muted2: 'text-[13px] text-gray-500',
  /** Совсем тихий (даты, вторичные факты). */
  faint: 'text-xs text-gray-500',

  // ── Кнопки ───────────────────────────────────────────────────────────────
  btnPrimary:
    'h-10 rounded-lg bg-blue-600 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',
  btnGhost:
    'h-10 rounded-lg border border-gray-300 bg-white px-4 text-[13px] font-medium text-gray-600 transition hover:border-gray-400 hover:text-gray-900 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',
  btnQuiet:
    'text-[13px] font-medium text-blue-600 transition hover:underline active:opacity-70 disabled:opacity-50 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',
  btnSmall:
    'h-8 rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-600 transition hover:border-gray-400 hover:text-gray-900 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300',

  // ── Статусы и мелочь ─────────────────────────────────────────────────────
  pill: 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
  dot: 'inline-block h-1.5 w-1.5 rounded-full',
  secTitle: 'text-[13px] font-semibold text-gray-900',
  /** Поле ввода. */
  input:
    'w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100',
  tierText: 'text-[10.5px] font-bold uppercase tracking-wider text-violet-600',
  chip: 'rounded-md border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500',
  rankNum: 'text-[22px] font-light leading-none tabular-nums text-gray-300 translate-y-[2px]',
} as const;

const DOT_TONE_CLASS = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  err: 'bg-red-500',
  info: 'bg-blue-500',
  muted: 'bg-gray-300',
} as const;

/** Цветная точка статуса; смысл всегда дублируется соседним текстом. */
export function StatusDot({
  tone,
  className,
}: {
  tone: 'ok' | 'warn' | 'err' | 'info' | 'muted';
  className?: string;
}): JSX.Element {
  return createElement('span', {
    'aria-hidden': true,
    className: `${HE.dot} ${DOT_TONE_CLASS[tone]}${className ? ` ${className}` : ''}`,
  });
}

/**
 * Маленький CSS-спиннер-кольцо (не иконка). className заменяет размер
 * по умолчанию (h-4 w-4) и может нести утилиты вроде mr-1 или shrink-0.
 */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }): JSX.Element {
  return createElement('span', {
    'aria-hidden': true,
    className: `inline-block animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 ${className}`,
  });
}

const STEP_NUM_CLASS = {
  done: 'border-blue-600 bg-blue-600 text-white',
  active: 'border-blue-600 bg-white text-blue-600',
  idle: 'border-gray-300 bg-white text-gray-400',
} as const;

/** Нумерованный кружок шага мастера: номер всегда виден, без галочек. */
export function StepNum({
  n,
  state,
}: {
  n: number | string;
  state: 'done' | 'active' | 'idle';
}): JSX.Element {
  return createElement(
    'span',
    {
      className: `flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${STEP_NUM_CLASS[state]}`,
    },
    n,
  );
}
