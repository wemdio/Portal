'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopNav } from './TopNav';
import { useIsTma } from '@/lib/useIsTma';
import { TmaHeader } from './TmaHeader';
import { UserProvider, useUser } from '@/lib/UserProvider';
import { PortalLoadingProvider } from '@/components/PortalLoadingProvider';
import { PortalDocumentTitle } from '@/components/PortalDocumentTitle';
import { GlobalTextTranslator, LanguageLoadingOverlay } from '@/components/GlobalTextTranslator';
import { ToolsAssistant } from '@/components/ToolsAssistant';
import { dict, commonDictionary, normalizeLocale, type Locale } from '@/lib/i18n';

const MD_BREAKPOINT = 768;

function LocaleTextTranslator() {
  const { locale } = useUser();
  return (
    <>
      <GlobalTextTranslator locale={locale} />
      <LanguageLoadingOverlay />
    </>
  );
}

export function LayoutShell({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale: Locale;
}) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';
  const isRdpPage = pathname === '/tools/rdp';
  const isGuestReviewPage = pathname.startsWith('/review/');
  const isMaintenancePage = pathname === '/maintenance';
  const isTma = useIsTma();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const locale = normalizeLocale(initialLocale);

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
  const contentPadding = isMaintenancePage
    ? 'p-0'
    : isTma
    ? (isSpreadsheetPage ? 'p-1.5' : 'px-4 py-4')
    : (isSpreadsheetPage ? 'p-1.5' : isRdpPage ? 'p-2' : isToolsPage ? desktopToolsPadding : desktopDefaultPadding);
  const shouldUseFullHeightContent =
    isRdpPage || isSpreadsheetPage || isGuestReviewPage || isMaintenancePage || pathname === '/';
  const contentWidth = shouldUseFullHeightContent ? 'w-full flex flex-1 min-h-0 flex-col' : 'w-full';

  /** Высота = окно + скролл только в main — иначе тянется вся страница и уезжает TopNav. */
  const shellClassName = isTma
    ? 'flex flex-col min-h-screen overflow-hidden'
    : isSpreadsheetPage
      ? 'flex flex-col h-screen overflow-hidden'
      : 'flex flex-col min-h-0 overflow-hidden';

  const isClientPortal = pathname.startsWith('/client');
  // Public offer agreement page (/offer) is the legal footer linked from
  // both /login and the client sidebar. It must render as a bare standalone
  // sheet — no TopNav, no client sidebar, no container chrome — so an
  // unauthenticated visitor reading the offer doesn't see Portal navigation
  // they can't use, and an authenticated user gets a clean printable-feeling
  // legal page instead of the page nested inside the workflow shell.
  const isOfferPage = pathname === '/offer';
  const hideNav = isSpreadsheetPage || isGuestReviewPage || isMaintenancePage || isClientPortal || isOfferPage;

  if (isClientPortal || isOfferPage) {
    return <>{children}</>;
  }

  return (
    <>
    <UserProvider initialLocale={locale}>
    <LocaleTextTranslator />
    <PortalDocumentTitle />
    <PortalLoadingProvider>
    <div
      className={shellClassName}
      style={{
        minHeight: 'var(--app-viewport-height, 100vh)',
        ...(!isTma ? { height: 'var(--app-viewport-height, 100vh)' } : {}),
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
                    aria-label={dict(commonDictionary.openMenu, locale)}
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                  <span className="ml-3 text-sm font-semibold text-zinc-900">{dict(commonDictionary.portal, locale)}</span>
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
    {/* Плавающий помощник по инструментам — только для авторизованного портала.
        Прячем на чужих/гостевых/служебных страницах, где /api/tools-assistant
        всё равно вернёт 401. */}
    {!isTma && !hideNav && pathname !== '/login' && <ToolsAssistant />}
    </PortalLoadingProvider>
    </UserProvider>
    </>
  );
}
