'use client';

/**
 * Desktop sidebar (≥ md). Below the breakpoint the layout falls back to
 * <ClientMobileDrawer/>, so this component renders nothing on small screens.
 *
 * Width is fixed at 240px (lg) / 220px (md). Sticky to viewport top so long
 * pages keep the nav visible without re-scrolling.
 */

import { ClientNavList } from './ClientNavList';
import type { Locale } from '@/lib/i18n';

export interface ClientSidebarProps {
  activeId: string | null;
  locale: Locale;
}

export function ClientSidebar({ activeId, locale }: ClientSidebarProps) {
  return (
    <aside
      className="hidden md:block sticky top-0 self-start h-screen overflow-y-auto px-4 py-5 shrink-0 w-[220px] lg:w-[240px]"
      aria-label={locale === 'en' ? 'Sidebar' : 'Боковое меню'}
    >
      <ClientNavList activeId={activeId} locale={locale} />
    </aside>
  );
}
