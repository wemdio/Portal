'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopNav } from './TopNav';
import { useIsTma } from '@/lib/useIsTma';
import { TmaHeader } from './TmaHeader';

const MD_BREAKPOINT = 768;

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';
  const isRdpPage = pathname === '/tools/rdp';
  const isGuestReviewPage = pathname.startsWith('/review/');
  const isTma = useIsTma();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MD_BREAKPOINT - 1}px)`);
    const update = () => setIsMobileLayout(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!isTma) return;
    document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isTma, pathname]);

  const mobileMenuOpenResolved = isMobileLayout && mobileMenuOpen;

  const isToolsPage = pathname === '/tools';
  const shouldUseCompactDensity =
    !isTma &&
    (
      pathname === '/projects/new' ||
      pathname === '/analytics/projects' ||
      pathname === '/tasks' ||
      pathname === '/team' ||
      pathname === '/finance' ||
      pathname === '/payments' ||
      pathname === '/billing-calendar' ||
      (pathname.startsWith('/tools') && !isSpreadsheetPage && !isRdpPage) ||
      pathname.startsWith('/admin')
    );
  const mainOverflowClass = !isTma && (isSpreadsheetPage || isGuestReviewPage) ? 'overflow-hidden' : 'overflow-y-auto';
  const desktopDefaultPadding = shouldUseCompactDensity ? 'p-3 md:p-4' : 'p-6';
  const desktopToolsPadding = shouldUseCompactDensity ? 'px-6 py-6 md:p-8' : 'px-6 py-6 md:p-8';
  const contentPadding = isTma
    ? (isSpreadsheetPage ? 'p-1.5' : 'px-4 py-4')
    : (isSpreadsheetPage ? 'p-1.5' : isToolsPage ? desktopToolsPadding : desktopDefaultPadding);
  const contentWidth =
    isRdpPage || isSpreadsheetPage || isGuestReviewPage ? 'w-full flex flex-1 min-h-0 flex-col' : 'w-full';

  const shellClassName = isTma
    ? 'flex flex-col min-h-screen overflow-hidden'
    : isSpreadsheetPage
      ? 'flex flex-col h-screen overflow-hidden'
      : 'flex flex-col min-h-screen overflow-x-hidden';

  const hideNav = isSpreadsheetPage || isGuestReviewPage;

  return (
    <div
      className={shellClassName}
      style={{
        minHeight: 'var(--app-viewport-height, 100vh)',
      }}
    >
      {!isTma ? (
        hideNav ? null : (
          <>
            {isMobileLayout ? (
              <>
                <header className="fixed left-0 right-0 top-0 z-30 flex h-14 items-center border-b border-zinc-200/80 bg-white/80 backdrop-blur-md px-4 md:hidden">
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(true)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100"
                    aria-label="Открыть меню"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                  <span className="ml-3 text-sm font-semibold text-zinc-900">Portal</span>
                </header>
                <Sidebar
                  collapsed={false}
                  isTma={false}
                  mobileOnlyDrawer
                  mobileOpen={mobileMenuOpenResolved}
                  onMobileClose={() => setMobileMenuOpen(false)}
                />
              </>
            ) : (
              <TopNav />
            )}
          </>
        )
      ) : null}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        {isTma && <TmaHeader />}
        <main
          className={`flex-1 flex flex-col min-h-0 ${mainOverflowClass} ${contentPadding}${isTma ? ' tma-safe-bottom' : ''} ${!isTma && isMobileLayout && !isSpreadsheetPage ? 'pt-12' : ''}`}
        >
          <div className={`${contentWidth}${shouldUseCompactDensity ? ' ui-density-compact' : ''}`}>{children}</div>
        </main>
      </div>
    </div>
  );
}
