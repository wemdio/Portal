'use client';

/**
 * Мелкие UI-примитивы клиентского ENG-кабинета: статус-тег, спиннер, карточка.
 * Хром — по DESIGN.md («Decisive Editorial Dark»): EngBadge — это status-tag
 * (6px dot + uppercase mono-tag, цвет только как данные), EngCard — ds-card.
 * Тексты компонентов кабинета — английские.
 */

import { Loader2 } from 'lucide-react';

export type EngTone = 'neutral' | 'accent' | 'green' | 'amber' | 'red';

/** Цвета dot/текста status-tag по тонам; только токены, никаких fill-карточек. */
const TONE_COLORS: Record<EngTone, { dot: string; text: string }> = {
  // quiet-вариант DESIGN.md — единственный, где dot и текст разного цвета.
  neutral: { dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
  accent: { dot: 'var(--cp-paper)', text: 'var(--cp-paper)' },
  green: { dot: 'var(--cp-green)', text: 'var(--cp-green)' },
  amber: { dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  red: { dot: 'var(--cp-red)', text: 'var(--cp-red)' },
};

export function EngBadge({ label, tone = 'neutral' }: { label: string; tone?: EngTone }) {
  const color = TONE_COLORS[tone];
  return (
    <span className="ds-status-tag" style={{ color: color.text }}>
      <span className="ds-status-dot" style={{ background: color.dot }} />
      {label}
    </span>
  );
}

export function EngSpinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} style={{ color: 'var(--cp-paper-mute)' }} />;
}

export function EngCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`ds-card p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function EngEyebrow({ children }: { children: React.ReactNode }) {
  return <h3 className="ds-eyebrow mb-2">{children}</h3>;
}

/** Дата/время коротко (en-US — кабинет англоязычный). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Тон бейджа для статуса проекта HE. */
export function projectStatusTone(status: string | undefined): EngTone {
  switch (status) {
    case 'researched':
      return 'green';
    case 'researching':
      return 'amber';
    case 'failed':
      return 'red';
    default:
      return 'neutral';
  }
}

/** Тон бейджа для статуса базы HE. */
export function baseStatusTone(status: string | undefined): EngTone {
  switch (status) {
    case 'analyzed':
      return 'green';
    case 'collecting':
    case 'analyzing':
      return 'amber';
    case 'failed':
      return 'red';
    default:
      return 'neutral';
  }
}

/** Тон бейджа для статуса гипотезы HE. */
export function hypothesisStatusTone(status: string | undefined): EngTone {
  switch (status) {
    case 'accepted':
      return 'green';
    case 'rejected':
      return 'red';
    default:
      return 'neutral';
  }
}
