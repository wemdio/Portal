'use client';

/**
 * Мелкие презентационные блоки «Движка вертикалей»: бейджи, статусные плашки,
 * подсветка {{operators}} в письмах, форматтеры дат/хостов.
 * Без иконок: статус = цветная точка + текст (StatusDot из ./design),
 * спиннер — CSS-кольцо. Палитра — светлые тона gray/blue/emerald/amber/
 * violet/red, тёмную тему подхватывают overrides в globals.css.
 */

import { toUnicode } from 'punycode';
import type { VeHypothesisTier, VeProjectStatus } from '@/lib/verticalEngineV2/types';
import { OPERATOR_RE } from '@/lib/verticalEngineV2/renderPreview';
import { HE, StatusDot } from './design';

export { Spinner } from './design';

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

/** Статусная плашка: цветная точка + текст (info — синяя, error — красная). */
export function StatusBox({
  tone,
  children,
}: {
  tone: 'info' | 'error';
  children: React.ReactNode;
}) {
  const isError = tone === 'error';
  const toneClass = isError
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-gray-200 bg-blue-50/40 text-gray-600';
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${toneClass}`}
      role={isError ? 'alert' : undefined}
    >
      <StatusDot tone={isError ? 'err' : 'info'} className="mt-[7px] shrink-0" />
      <span className="flex-1">{children}</span>
    </div>
  );
}

/**
 * Подсветка операторов персонализации {{var}} янтарной плашкой.
 * Регексп — тот же, что в боевой экстракции операторов (OPERATOR_RE):
 * split с единственной capture-группой отдаёт чётные части как текст,
 * нечётные — имена операторов (без скобок).
 */
export function OperatorText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(OPERATOR_RE);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 font-mono text-[0.92em] text-amber-800">
            {`{{${part}}}`}
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

export const TIER_META: Record<VeHypothesisTier, { label: string; hint: string; tone: BadgeTone }> = {
  1: { label: 'T1', hint: 'Очевидная ЦА', tone: 'blue' },
  2: { label: 'T2', hint: 'Смежный сегмент', tone: 'violet' },
  3: { label: 'T3', hint: 'Неочевидный рынок', tone: 'gray' },
};

export function TierBadge({ tier }: { tier: VeHypothesisTier }) {
  const meta = TIER_META[tier] ?? TIER_META[3];
  return (
    <Badge tone={meta.tone} title={meta.hint}>
      {meta.label}
    </Badge>
  );
}

type StatusDotTone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

export const PROJECT_STATUS_META: Record<
  VeProjectStatus,
  { label: string; tone: BadgeTone; dot: StatusDotTone; pulse?: boolean }
> = {
  draft: { label: 'Черновик', tone: 'gray', dot: 'muted' },
  researching: { label: 'Исследование…', tone: 'amber', dot: 'warn', pulse: true },
  researched: { label: 'Готово', tone: 'emerald', dot: 'ok' },
  failed: { label: 'Ошибка', tone: 'red', dot: 'err' },
};

/** Статус проекта: пилюля с цветной точкой и подписью. */
export function ProjectStatusBadge({ status }: { status: VeProjectStatus }) {
  const meta = PROJECT_STATUS_META[status] ?? PROJECT_STATUS_META.draft;
  return (
    <span className={`${HE.pill} ${BADGE_TONE_CLASS[meta.tone]}`}>
      <StatusDot tone={meta.dot} className={meta.pulse ? 'animate-pulse' : undefined} />
      {meta.label}
    </span>
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

/** Короткий хост для показа: «https://www.acme.com/» → «acme.com»; punycode IDN → Unicode. */
export function prettyHost(url: string): string {
  const host = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
  return decodePunycodeHost(host);
}

/**
 * Имя проекта для показа. У проектов, созданных до Unicode-нормализации,
 * имя могло сохраниться как punycode-домен («xn--…») — такие декодируем,
 * обычные имена не трогаем. Пустое имя → хост сайта.
 */
export function prettyProjectName(name: string | null | undefined, websiteUrl: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return prettyHost(websiteUrl);
  return decodePunycodeHost(trimmed);
}

/** «xn--e1aaa….xn--p1ai» → «цельныерешения.рф»; обычные строки возвращает как есть. */
function decodePunycodeHost(value: string): string {
  if (!/^[a-z0-9.-]+$/i.test(value) || !value.toLowerCase().includes('xn--')) return value;
  const decoded = toUnicode(value.toLowerCase());
  return decoded || value;
}
