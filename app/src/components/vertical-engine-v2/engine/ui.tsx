'use client';

/**
 * Мелкие презентационные блоки «Движка вертикалей»: бейджи, статусные плашки,
 * подсветка {{operators}} в письмах, форматтеры дат/хостов.
 * Без иконок: статус = цветная точка + текст (StatusDot из ./design),
 * спиннер — CSS-кольцо. Стили — scoped-классы ../ve2.css (токены --ve2-*,
 * обе темы); сигнатуры экспортов не менялись.
 */

import { toUnicode } from 'punycode';
import type { VeHypothesisTier, VeProjectStatus } from '@/lib/verticalEngineV2/types';
import { OPERATOR_RE } from '@/lib/verticalEngineV2/renderPreview';
import { HE, StatusDot } from './design';

export { Spinner } from './design';

export type BadgeTone = 'gray' | 'emerald' | 'amber' | 'red' | 'blue' | 'violet';

/**
 * Статус = данные: точка + моно-тег, без заливок. Цветовые «акцентные» тона
 * (blue/violet) сведены к нейтральному — семантику несут ok/warn/err.
 */
const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  gray: 've2-tg-q',
  emerald: 've2-tg-ok',
  amber: 've2-tg-warn',
  red: 've2-tg-err',
  blue: 've2-tg-q',
  violet: 've2-tg-q',
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
    <span title={title} className={`ve2-tag ${BADGE_TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

/** Статусная плашка: цветная точка + текст на нейтральной поверхности. */
export function StatusBox({
  tone,
  children,
}: {
  tone: 'info' | 'error';
  children: React.ReactNode;
}) {
  const isError = tone === 'error';
  return (
    <div
      className={`ve2-nt ${isError ? 've2-nt-err' : 've2-nt-info'} flex items-start gap-2.5 px-4 py-3 text-sm`}
      role={isError ? 'alert' : undefined}
    >
      <StatusDot tone={isError ? 'err' : 'info'} className="mt-[7px] shrink-0" />
      <span className="flex-1">{children}</span>
    </div>
  );
}

/**
 * Подсветка операторов персонализации {{var}} моно-чипом.
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
          <mark key={i} className="ve2-op">
            {`{{${part}}}`}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/** Процент потенциала: ≥50 зелёный, ≥25 янтарный, <25 нейтральный. */
export function PotentialBadge({ pct }: { pct: number }) {
  const toneClass = pct >= 50 ? 've2-pct-hi' : pct >= 25 ? 've2-pct-mid' : 've2-pct-lo';
  return <span className={`ve2-pct ${toneClass}`}>{pct}%</span>;
}

export const TIER_META: Record<VeHypothesisTier, { label: string; hint: string; tone: BadgeTone }> = {
  1: { label: 'T1', hint: 'Очевидная ЦА', tone: 'blue' },
  2: { label: 'T2', hint: 'Смежный сегмент', tone: 'violet' },
  3: { label: 'T3', hint: 'Неочевидный рынок', tone: 'gray' },
};

export function TierBadge({ tier }: { tier: VeHypothesisTier }) {
  const meta = TIER_META[tier] ?? TIER_META[3];
  return (
    <span className={HE.tierText} title={meta.hint}>
      {meta.label}
    </span>
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

/** Статус проекта: цветная точка + моно-тег. */
export function ProjectStatusBadge({ status }: { status: VeProjectStatus }) {
  const meta = PROJECT_STATUS_META[status] ?? PROJECT_STATUS_META.draft;
  return (
    <span className={`${HE.pill} ${BADGE_TONE_CLASS[meta.tone]}`}>
      <StatusDot tone={meta.dot} className={meta.pulse ? 'motion-safe:animate-pulse' : undefined} />
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
