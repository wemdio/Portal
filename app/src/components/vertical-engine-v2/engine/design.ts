/**
 * Дизайн-система «Движка вертикалей»: токены (HE) и мелкие атомарные
 * компоненты. Концепция редизайна: редакторский инструмент — hairline-
 * структура, невидимый акцент (primary = самый контрастный объект без
 * цвета), статус как данные (точка 6px + моно-тег).
 *
 * Строки классов ссылаются на scoped-классы ../ve2.css: они работают только
 * под корнем .ve2 (VerticalEngineV2View) и наружу не утекают. Обе темы
 * поддержаны токенами --ve2-* (тёмная: html[data-portal-theme='dark'] .ve2),
 * мост globals.css для этих классов не нужен. Tailwind-утилиты компоновки
 * (flex, grid, gap, mt-*) применяются поверх — цветов они не задают.
 *
 * Файл намеренно .ts (без JSX-синтаксиса): компоненты собираются через
 * createElement, тип возврата — JSX.Element из react.
 */

import { createElement, type JSX } from 'react';

export const HE = {
  // ── Поверхности ──────────────────────────────────────────────────────────
  /** Рабочая поверхность: белая/графитовая карточка с hairline-рамкой. */
  card: 've2-card',
  /** Hover-фидбек для кликабельных поверхностей. */
  cardHover: 've2-card-h',
  cardPad: 've2-p-5',
  /** Вторичная панель (вложенный блок, мета-зона): заливка без рамки. */
  panelSoft: 've2-soft',
  /** Панель формы внутри шага: единая рамка, фон и отступ. */
  formPanel: 've2-form',
  /** Пустое состояние: пунктирная рамка. */
  emptyState: 've2-empty',
  /** Информационная плашка (нейтральная). */
  infoPanel: 've2-nt ve2-nt-info',
  /** Успешная плашка: статус остаётся точкой + текстом. */
  successPanel: 've2-nt ve2-nt-ok',
  /** Разделительная линия секций. */
  divider: 've2-div',

  // ── Типографика ──────────────────────────────────────────────────────────
  /** Заголовок страницы/экрана. */
  pageTitle: 've2-h1',
  /** Заголовок секции внутри экрана. */
  sectionTitle: 've2-h2',
  /** Заголовок карточки/блока. */
  cardTitle: 've2-h3',
  /** Лид-абзац под заголовком. */
  lead: 've2-lead',
  /** Тихий текст (мета, подписи). */
  muted: 've2-mut',
  muted2: 've2-mut',
  /** Совсем тихий (даты, вторичные факты), моно. */
  faint: 've2-faint',
  /** Моно-маркер секции (editorial eyebrow). */
  eyebrow: 've2-eb',

  // ── Кнопки ───────────────────────────────────────────────────────────────
  btnPrimary: 've2-btn ve2-b-pri',
  btnGhost: 've2-btn ve2-b-sec',
  btnQuiet: 've2-b-quiet',
  btnSmall: 've2-btn ve2-b-sec ve2-b-sm',

  // ── Статусы и мелочь ─────────────────────────────────────────────────────
  pill: 've2-st',
  dot: 've2-dot',
  secTitle: 've2-h4',
  /** Поле ввода. */
  input: 've2-input',
  tierText: 've2-tier',
  chip: 've2-mchip',

  // ── Рейтинги ─────────────────────────────────────────────────────────────
  rankNum: 've2-rank',
} as const;

const DOT_TONE_CLASS = {
  ok: 've2-d-g',
  warn: 've2-d-w',
  err: 've2-d-r',
  info: 've2-d-n',
  muted: 've2-d-q',
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
    className: `ve2-spin ${className}`,
  });
}
