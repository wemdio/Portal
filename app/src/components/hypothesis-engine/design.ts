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
  card: 'rounded-2xl border border-gray-200 bg-white',
  cardPad: 'p-5',
  btnPrimary:
    'h-10 rounded-lg bg-blue-600 px-4 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50',
  btnGhost:
    'h-10 rounded-lg border border-gray-300 bg-white px-4 text-[13px] font-medium text-gray-600 transition hover:border-gray-400 hover:text-gray-900 disabled:opacity-50',
  btnQuiet: 'text-[13px] font-medium text-blue-600 hover:underline disabled:opacity-50',
  btnSmall:
    'h-8 rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-600 transition hover:border-gray-400 hover:text-gray-900 disabled:opacity-50',
  pill: 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
  dot: 'inline-block h-1.5 w-1.5 rounded-full',
  secTitle: 'text-[13px] font-semibold text-gray-900',
  lead: 'text-[13.5px] leading-relaxed text-gray-600',
  muted: 'text-gray-400',
  muted2: 'text-gray-500',
  input:
    'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none',
  tierText: 'text-[10.5px] font-bold uppercase tracking-wider text-violet-600',
  chip: 'rounded-md border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-400',
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
