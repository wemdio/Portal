'use client';

/**
 * Мелкие презентационные блоки «Движка вертикалей»: бейджи, статусные плашки,
 * подсветка {{operators}} в письмах, форматтеры дат/хостов.
 * Палитра — как у соседних инструментов (sales-hypotheses и др.).
 */

import { AlertCircle, Loader2 } from 'lucide-react';
import type { HeHypothesisTier, HeProjectStatus } from '@/lib/hypothesisEngine/types';

export type BadgeTone = 'gray' | 'emerald' | 'amber' | 'red' | 'blue' | 'violet';

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  gray: 'bg-gray-100 text-gray-600',
  emerald: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-700',
  violet: 'bg-violet-100 text-violet-700',
};

export function Badge({
  tone = 'gray',
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${BADGE_TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBox({
  tone,
  children,
}: {
  tone: 'info' | 'error';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-600';
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${toneClass}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {tone === 'error' ? (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-gray-400" aria-hidden />
      )}
      <span className="flex-1">{children}</span>
    </div>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden />;
}

/** Подсветка операторов персонализации {{var}} янтарной плашкой. */
export function OperatorText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\{\{[^{}]+\}\})/g);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        /^\{\{[^{}]+\}\}$/.test(part) ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 font-mono text-[0.92em] text-amber-800">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/** Бейдж процента потенциала: ≥50 зелёный, ≥25 янтарный, <25 серый. */
export function PotentialBadge({ pct }: { pct: number }) {
  const tone: BadgeTone = pct >= 50 ? 'emerald' : pct >= 25 ? 'amber' : 'gray';
  return <Badge tone={tone}>{pct}%</Badge>;
}

export const TIER_META: Record<HeHypothesisTier, { label: string; hint: string; tone: BadgeTone }> = {
  1: { label: 'T1', hint: 'Очевидная ЦА', tone: 'blue' },
  2: { label: 'T2', hint: 'Смежный сегмент', tone: 'violet' },
  3: { label: 'T3', hint: 'Неочевидный рынок', tone: 'gray' },
};

export function TierBadge({ tier }: { tier: HeHypothesisTier }) {
  const meta = TIER_META[tier] ?? TIER_META[3];
  return (
    <Badge tone={meta.tone} title={meta.hint}>
      {meta.label}
    </Badge>
  );
}

export const PROJECT_STATUS_META: Record<HeProjectStatus, { label: string; tone: BadgeTone; pulse?: boolean }> = {
  draft: { label: 'Черновик', tone: 'gray' },
  researching: { label: 'Исследование…', tone: 'amber', pulse: true },
  researched: { label: 'Готово', tone: 'emerald' },
  failed: { label: 'Ошибка', tone: 'red' },
};

export function ProjectStatusBadge({ status }: { status: HeProjectStatus }) {
  const meta = PROJECT_STATUS_META[status] ?? PROJECT_STATUS_META.draft;
  return (
    <Badge tone={meta.tone}>
      {meta.pulse ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden /> : null}
      {meta.label}
    </Badge>
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Короткий хост для показа: «https://www.acme.com/» → «acme.com». */
export function prettyHost(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
}
