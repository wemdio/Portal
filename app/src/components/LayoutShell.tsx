'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { useIsTma } from '@/lib/useIsTma';
import { TmaHeader } from './TmaHeader';

const MD_BREAKPOINT = 768;

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';
  const isRdpPage = pathname === '/tools/rdp';
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

  // When switching to desktop layout, treat menu as closed without setState in effect
  const mobileMenuOpenResolved = isMobileLayout && mobileMenuOpen;

  const isToolsPage = pathname === '/tools';
  const mainOverflowClass = !isTma && isSpreadsheetPage ? 'overflow-hidden' : 'overflow-y-auto';
  const contentPadding = isTma
    ? (isSpreadsheetPage ? 'p-1.5' : 'px-4 py-4')
    : (isSpreadsheetPage ? 'p-1.5' : isToolsPage ? 'px-4 py-6 md:p-8' : 'p-8');
  const contentWidth =
    isRdpPage || isSpreadsheetPage ? 'w-full flex flex-1 min-h-0 flex-col' : 'w-full';

  const shellClassName = isTma
    ? 'flex min-h-screen overflow-hidden'
    : 'flex min-h-screen overflow-x-hidden';

  return (
    <div
      className={shellClassName}
      style={{
        minHeight: 'var(--app-viewport-height, 100vh)',
      }}
    >
      {!isTma ? (
        isSpreadsheetPage ? null : (
          <>
            {isMobileLayout ? (
              <>
                <header className="fixed left-0 right-0 top-0 z-30 flex h-12 items-center border-b border-gray-200 bg-white px-4 md:hidden">
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(true)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
                    aria-label="Открыть меню"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                  <span className="ml-3 text-sm font-semibold text-gray-900">Portal</span>
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
              <>
                <Sidebar collapsed={false} isTma={false} />
                <div className="flex-shrink-0 w-40" />
              </>
            )}
          </>
        )
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {isTma && <TmaHeader />}
        <main
          className={`flex-1 flex flex-col min-h-0 ${mainOverflowClass} ${contentPadding}${isTma ? ' tma-safe-bottom' : ''} ${!isTma && isMobileLayout && !isSpreadsheetPage ? 'pt-12' : ''}`}
        >
          <div className={contentWidth}>{children}</div>
        </main>
      </div>
    </div>
  );
}
