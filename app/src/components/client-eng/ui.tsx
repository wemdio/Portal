'use client';

/**
 * Мелкие UI-примитивы клиентского ENG-кабинета: бейджи статусов, спиннер,
 * карточка. Стили — общие с клиентским порталом (neu-card, ds-eyebrow,
 * CSS-переменные --cp-*); тексты компонентов кабинета — английские.
 */

import { Loader2 } from 'lucide-react';

export type EngTone = 'neutral' | 'accent' | 'green' | 'amber' | 'red';

const TONE_COLORS: Record<EngTone, string> = {
  neutral: 'var(--cp-paper-mute)',
  accent: 'var(--cp-paper)',
  green: 'var(--cp-green)',
  amber: 'var(--cp-amber)',
  red: 'var(--cp-red)',
};

export function EngBadge({ label, tone = 'neutral' }: { label: string; tone?: EngTone }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        color: TONE_COLORS[tone],
        border: `1px solid ${TONE_COLORS[tone]}`,
      }}
    >
      {label}
    </span>
  );
}

export function EngSpinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} style={{ color: 'var(--cp-paper-mute)' }} />;
}

export function EngCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`neu-card p-4 sm:p-5 ${className}`}>{children}</div>;
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
