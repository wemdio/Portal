'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { useIsTma } from '@/lib/useIsTma';
import { TmaHeader } from './TmaHeader';
import { navItems } from '@/lib/navigation';
import { canAccessBillingCalendar, getCurrentUserRole, isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

const MD_BREAKPOINT = 768;
const NAV_ACTIVE_ALIASES: Record<string, string[]> = {
  '/tools': ['/parsers'],
};

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';
  const isRdpPage = pathname === '/tools/rdp';
  const isTma = useIsTma();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [userRole, setUserRole] = useState<UserRole | null>(null);

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

  useEffect(() => {
    if (isTma || !isSpreadsheetPage) return;
    let cancelled = false;
    void (async () => {
      const role = await getCurrentUserRole();
      if (!cancelled) {
        setUserRole(role);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSpreadsheetPage, isTma]);

  const compactNavItems = useMemo(() => {
    if (!isSpreadsheetPage || isTma) return [];
    return navItems.filter((item) => {
      if (item.adminOnly && !isAdmin(userRole)) return false;
      if (item.billingCalendarOnly && !canAccessBillingCalendar(userRole)) return false;
      return true;
    });
  }, [isSpreadsheetPage, isTma, userRole]);

  const isNavItemActive = (href: string) => {
    const aliases = NAV_ACTIVE_ALIASES[href] ?? [];
    return href === '/'
      ? pathname === '/'
      : pathname === href ||
          pathname.startsWith(`${href}/`) ||
          aliases.some((alias) => pathname === alias || pathname.startsWith(`${alias}/`));
  };

  // When switching to desktop layout, treat menu as closed without setState in effect
  const mobileMenuOpenResolved = isMobileLayout && mobileMenuOpen;

  const isToolsPage = pathname === '/tools';
  const contentPadding = isTma
    ? (isSpreadsheetPage ? 'p-1.5' : 'px-4 py-4')
    : (isSpreadsheetPage ? 'p-1.5' : isToolsPage ? 'px-4 py-6 md:p-8' : 'p-8');
  const contentWidth = 'w-full';

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
          className={`flex-1 flex flex-col min-h-0 overflow-y-auto ${contentPadding}${isTma ? ' tma-safe-bottom' : ''} ${!isTma && isMobileLayout && !isSpreadsheetPage ? 'pt-12' : ''}`}
        >
          {!isTma && isSpreadsheetPage && (
            <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
              <div className="flex items-center gap-1 overflow-x-auto px-2 py-1.5 no-scrollbar">
                {compactNavItems.map((item) => (
                  <Link
                    key={item.name}
                    href={item.href as Route}
                    className={`whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      isNavItemActive(item.href)
                        ? 'bg-gray-900 text-white'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className={`${contentWidth}${isRdpPage ? ' flex flex-col flex-1 min-h-0' : ''}`}>{children}</div>
        </main>
      </div>
    </div>
  );
}
