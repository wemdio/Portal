/**
 * Дизайн-система «Движка вертикалей»: токены (HE) и мелкие атомарные
 * компоненты. Концепция: плотный рабочий интерфейс с нейтральным chrome,
 * blue-акцентом только для выбора/focus и семантическими статусами.
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
  /** Рабочая поверхность: короткий радиус, hairline и без декоративной тени. */
  card: 'rounded-lg border border-gray-200 bg-white',
  /** Hover-фидбек для кликабельных поверхностей. */
  cardHover: 'hover:border-gray-300 hover:bg-gray-50/70',
  cardPad: 'p-5',
  /** Вторичная панель (вложенный блок, мета-зона): заливка без рамки. */
  panelSoft: 'rounded-lg bg-gray-50/80',
  /** Панель формы внутри шага: единая рамка, фон и отступ. */
  formPanel: 'rounded-lg border border-gray-200 bg-white p-4',
  /** Пустое состояние: пунктирная рамка без отдельного декоративного стиля. */
  emptyState: 'rounded-lg border border-dashed border-gray-300 bg-gray-50/50 p-8 text-center',
  /** Информационная плашка с тем же радиусом, что у вложенных панелей. */
  infoPanel: 'rounded-lg border border-blue-200 bg-blue-50/50',
  /** Успешная плашка: статус остаётся точкой + текстом. */
  successPanel: 'rounded-lg border border-emerald-200 bg-emerald-50/70',
  /** Разделительная линия секций. */
  divider: 'border-gray-200/80',

  // ── Типографика (шкала ~1.125–1.2, иерархия размером и весом) ────────────
  /** Заголовок страницы/экрана. */
  pageTitle: 'text-[26px] font-semibold leading-tight text-gray-900',
  /** Заголовок секции внутри экрана. */
  sectionTitle: 'text-[17px] font-semibold text-gray-900',
  /** Заголовок карточки/блока. */
  cardTitle: 'text-[15px] font-semibold text-gray-900',
  /** Лид-абзац под заголовком. */
  lead: 'text-sm leading-relaxed text-gray-600',
  /** Тихий текст (мета, подписи). */
  muted: 'text-[13px] text-gray-500',
  muted2: 'text-[13px] text-gray-500',
  /** Совсем тихий (даты, вторичные факты). */
  faint: 'text-xs text-gray-500',
  /** Небольшой моно/uppercase маркер секции в рабочих шагах. */
  eyebrow: 'text-[11px] font-semibold text-gray-500',

  // ── Кнопки ───────────────────────────────────────────────────────────────
  btnPrimary:
    'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-gray-900 px-4 text-[13px] font-semibold text-white transition hover:bg-gray-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2',
  btnGhost:
    'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 text-[13px] font-medium text-gray-700 transition hover:border-gray-400 hover:bg-gray-50 hover:text-gray-900 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2',
  btnQuiet:
    'text-[13px] font-medium text-gray-600 transition hover:text-gray-900 active:opacity-70 disabled:opacity-45 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
  btnSmall:
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-600 transition hover:border-gray-400 hover:bg-gray-50 hover:text-gray-900 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',

  // ── Статусы и мелочь ─────────────────────────────────────────────────────
  pill: 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold',
  dot: 'inline-block h-1.5 w-1.5 rounded-full',
  secTitle: 'text-[13px] font-semibold text-gray-900',
  /** Поле ввода. */
  input:
    'min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100',
  tierText: 'text-[10.5px] font-bold uppercase text-violet-600',
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
