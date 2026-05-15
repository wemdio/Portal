'use client';

/**
 * Lightweight banner shown at the top of /client (Кампании) for users who
 * haven't completed onboarding yet, nudging them to the dashboard checklist.
 *
 * Dismissible — once dismissed, the choice is persisted in localStorage so
 * the banner doesn't keep re-appearing on every visit. The dismiss is
 * automatically forgotten once onboarding is fully complete (so a user who
 * dismissed it early gets a fresh "all done" experience too).
 *
 * Loads /api/client/onboarding/status itself; mounted as a sibling of the
 * Кампании page header. If status fetch fails, banner silently hides.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Sparkles, X } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

const DISMISS_KEY = 'client.dashboard.banner.dismissed';

interface OnboardingResponse {
  complete: boolean;
}

export function OnboardingBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await clientApiFetch<OnboardingResponse>('/onboarding/status');
        if (cancelled) return;
        if (res.complete) {
          // User finished onboarding — clear any stale dismiss flag and hide.
          try {
            window.localStorage.removeItem(DISMISS_KEY);
          } catch { /* sandboxed iframes / private mode — ignore */ }
          setShow(false);
          return;
        }
        let dismissed = false;
        try {
          dismissed = window.localStorage.getItem(DISMISS_KEY) === '1';
        } catch { /* localStorage unavailable — keep showing */ }
        setShow(!dismissed);
      } catch {
        // status endpoint failed → don't show banner (avoid blocking page).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className="neu-card flex items-center gap-3 px-4 py-3 sm:px-5 sm:py-3.5 mb-5 sm:mb-6"
      role="status"
    >
      <span
        className="inline-flex items-center justify-center h-8 w-8 rounded-xl shrink-0"
        style={{ background: 'rgba(99,102,241,0.12)', color: '#6366F1' }}
      >
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold leading-tight" style={{ color: 'var(--cp-text)' }}>
          Только начинаете?
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
          На дашборде есть пошаговый онбординг — за 5 шагов запустите первую кампанию.
        </p>
      </div>
      <Link
        href={'/client/dashboard' as Route}
        className="neu-pill px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0"
        style={{ color: '#6366F1' }}
      >
        Открыть дашборд →
      </Link>
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(DISMISS_KEY, '1');
          } catch { /* ignore */ }
          setShow(false);
        }}
        aria-label="Скрыть"
        className="neu-pill p-1.5 shrink-0"
        style={{ color: 'var(--cp-text-l)' }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
