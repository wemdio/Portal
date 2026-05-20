'use client';

/**
 * Persistent setup checklist shown on /client/dashboard.
 *
 * Six steps in fixed order: brief → preset → first base → first clean →
 * first sequence → first launch. Done items render with a soft inset
 * checkmark; the next not-done item gets a highlighted ring and a
 * "следующий шаг" tag so the user always knows what to tackle next.
 *
 * When all six are done the widget collapses to a slim "Setup complete ✓"
 * badge with a chevron to expand for review.
 *
 * Status is fetched from /api/client/onboarding/status on mount and on
 * pathname changes (so completing a step on another page reflects here
 * after navigation back).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { AlertCircle, Check, ChevronDown, Circle, Clock, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

interface ChecklistItem {
  id: 'brief' | 'preset' | 'first_base' | 'first_clean' | 'first_sequence' | 'first_launch';
  label: string;
  done: boolean;
  href: string | null;
  blocked_reason?: string;
}

interface OnboardingResponse {
  items: ChecklistItem[];
  complete: boolean;
  next_id: ChecklistItem['id'] | null;
}

export function OnboardingChecklist() {
  const pathname = usePathname();
  const [data, setData] = useState<OnboardingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApiFetch<OnboardingResponse>('/onboarding/status');
      setData(res);
      // Auto-collapse on first render once user is fully onboarded; user can
      // expand again with the chevron.
      setCollapsed(res.complete);
    } catch (err) {
      // Non-critical surface — show a quiet inline error with retry so the
      // failure is visible (debugging) but does not block the dashboard.
      const message =
        err instanceof Error
          ? err.message
          : 'Не удалось загрузить чеклист.';
      // Surface to DevTools for backend debugging without spamming the user.
      console.warn('OnboardingChecklist load failed:', message);
      setError('Не удалось загрузить чеклист настройки.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, pathname]);

  const doneCount = useMemo(
    () => data?.items.filter((i) => i.done).length ?? 0,
    [data],
  );
  const total = data?.items.length ?? 6;

  if (loading && !data) {
    return (
      <div className="neu-card p-5 sm:p-6 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--cp-text-l)' }} />
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Загружаем чеклист…
        </p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        className="neu-inset rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 flex items-center gap-3"
        role="alert"
      >
        <AlertCircle
          className="h-4 w-4 shrink-0"
          style={{ color: 'var(--cp-danger)' }}
          aria-hidden
        />
        <p className="text-sm flex-1" style={{ color: 'var(--cp-text-m)' }}>
          {error}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold"
          style={{ color: 'var(--cp-text)' }}
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Повторить
        </button>
      </div>
    );
  }

  if (!data) return null;

  // ─── Collapsed (всё готово) ──────────────────────────────────────
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="neu-card p-4 sm:p-5 flex items-center gap-3 w-full text-left"
      >
        <span
          className="inline-flex items-center justify-center h-8 w-8 rounded-full"
          style={{ background: '#10B981', color: '#fff' }}
        >
          <Check className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
            Настройка завершена
          </p>
          <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
            Все {total} шагов пройдены — портал готов к работе
          </p>
        </div>
        <ChevronDown className="h-4 w-4" style={{ color: 'var(--cp-text-l)' }} />
      </button>
    );
  }

  return (
    <div className="neu-card p-5 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--cp-text)' }}>
            <Sparkles className="h-4 w-4" style={{ color: '#F59E0B' }} />
            С чего начать
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
            Пройдите {total} шагов — и ваша первая кампания запущена
          </p>
        </div>
        <span
          className="neu-pill px-2.5 py-1 text-[11px] font-bold shrink-0"
          style={{ color: 'var(--cp-accent)' }}
        >
          {doneCount} / {total}
        </span>
      </div>

      <div className="space-y-2">
        {data.items.map((item, idx) => (
          <ChecklistRow
            key={item.id}
            item={item}
            stepNumber={idx + 1}
            isNext={data.next_id === item.id}
          />
        ))}
      </div>
    </div>
  );
}

function ChecklistRow({
  item,
  stepNumber,
  isNext,
}: {
  item: ChecklistItem;
  stepNumber: number;
  isNext: boolean;
}) {
  const indicator = item.done ? (
    <Check className="h-4 w-4" style={{ color: '#fff' }} />
  ) : isNext ? (
    <Clock className="h-4 w-4" style={{ color: '#fff' }} />
  ) : (
    <Circle className="h-4 w-4" style={{ color: 'var(--cp-text-l)' }} />
  );

  const Wrapper: React.ElementType = item.href ? Link : 'div';
  const wrapperProps = item.href
    ? ({ href: item.href as Route } as { href: Route })
    : ({} as Record<string, never>);

  return (
    <Wrapper
      {...wrapperProps}
      className={`neu-row flex items-start gap-3 px-3.5 py-3 rounded-xl ${
        item.href ? 'cursor-pointer' : ''
      } ${isNext ? 'neu-inset' : ''}`}
      title={item.blocked_reason ?? undefined}
    >
      <span
        className="inline-flex items-center justify-center h-7 w-7 rounded-full shrink-0 mt-0.5"
        style={{
          background: item.done
            ? '#10B981'
            : isNext
              ? 'var(--cp-accent)'
              : 'transparent',
          boxShadow: !item.done && !isNext
            ? 'inset 1.5px 1.5px 3px var(--cp-shadow-d), inset -1.5px -1.5px 3px var(--cp-shadow-l)'
            : undefined,
        }}
      >
        {indicator}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[10px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--cp-text-l)' }}
          >
            Шаг {stepNumber}
          </span>
          {isNext && (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(74,111,165,0.15)', color: 'var(--cp-accent)' }}
            >
              следующий
            </span>
          )}
        </div>
        <p
          className={`text-sm mt-0.5 ${item.done ? 'font-medium' : 'font-bold'}`}
          style={{
            color: item.done ? 'var(--cp-text-l)' : 'var(--cp-text)',
          }}
        >
          {item.label}
        </p>
        {!item.done && item.blocked_reason && (
          <p className="text-[11px] mt-1" style={{ color: 'var(--cp-text-m)' }}>
            {item.blocked_reason}
          </p>
        )}
      </div>
    </Wrapper>
  );
}
