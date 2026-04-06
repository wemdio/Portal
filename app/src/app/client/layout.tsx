'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Nunito } from 'next/font/google';
import { supabase } from '@/lib/supabaseClient';
import { PortalLoadingProvider } from '@/components/PortalLoadingProvider';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';

const nunito = Nunito({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
});

const clientNav = [
  { name: 'Кампании', href: '/client' },
  { name: 'Лиды', href: '/client/leads' },
  { name: 'Базы', href: '/client/bases' },
  { name: 'Отчёты', href: '/client/reports' },
  { name: 'Парсеры', href: '/client/parsers' },
  { name: 'Запуск кампаний', href: '/client/launch' },
] as const;

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    document.title = getPortalPageSectionTitle(pathname);
  }, [pathname]);

  const isActive = (href: string) =>
    href === '/client'
      ? pathname === '/client' || pathname.startsWith('/client/campaigns')
      : pathname.startsWith(href);

  return (
    <PortalLoadingProvider>
    <div className={`client-portal ${nunito.className} flex flex-col min-h-screen`}>
      <header className="sticky top-0 z-40 px-3 pt-3 pb-1 sm:px-4 sm:pt-5 sm:pb-2 md:px-8">
        <div className="neu-card flex items-center gap-2 sm:gap-4 px-3 py-2.5 sm:px-6 sm:py-3.5 max-w-5xl mx-auto">
          <span
            className="text-sm sm:text-base font-extrabold tracking-tight select-none shrink-0"
            style={{ color: 'var(--cp-accent)' }}
          >
            Portal
          </span>

          <nav className="flex-1 flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar">
            {clientNav.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  className={`neu-pill px-3 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-[13px] font-semibold whitespace-nowrap ${active ? 'active' : ''}`}
                  style={!active ? { color: 'var(--cp-text-m)' } : undefined}
                >
                  {item.name}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={async () => {
              await supabase.auth.signOut();
              router.push('/login' as Route);
              router.refresh();
            }}
            className="neu-pill px-3 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-[13px] font-semibold shrink-0"
            style={{ color: 'var(--cp-text-l)' }}
          >
            Выйти
          </button>
        </div>
      </header>

      <main className="flex-1 px-3 py-4 sm:px-4 sm:py-6 md:px-8 md:py-8">
        {children}
      </main>
    </div>
    </PortalLoadingProvider>
  );
}
