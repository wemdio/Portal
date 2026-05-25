'use client';

/**
 * Slide-out drawer for screens < md. Triggered by the burger button in the
 * top bar. Closes on:
 *   - tapping the backdrop
 *   - pressing Escape
 *   - selecting any nav item
 *
 * No external dependencies (Headless UI / Radix) — chosen to keep the bundle
 * lean since this is the only modal-ish surface in the client portal.
 */

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { ClientNavList } from './ClientNavList';
import type { Locale } from '@/lib/i18n';
import type { ClientNavMode } from '@/lib/clientNav';

export interface ClientMobileDrawerProps {
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  locale: Locale;
  mode?: ClientNavMode;
}

export function ClientMobileDrawer({ open, onClose, activeId, locale, mode }: ClientMobileDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Lock body scroll while drawer is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={locale === 'en' ? 'Navigation' : 'Меню'}
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] overflow-y-auto px-4 py-5 transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: 'var(--cp-bg)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <span
            className="text-base font-extrabold tracking-tight"
            style={{ color: 'var(--cp-paper)' }}
          >
            Portal
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="neu-pill p-1.5"
            aria-label={locale === 'en' ? 'Close menu' : 'Закрыть меню'}
            style={{ color: 'var(--cp-text-m)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ClientNavList activeId={activeId} locale={locale} mode={mode} onItemClick={onClose} />
      </div>
    </>
  );
}
