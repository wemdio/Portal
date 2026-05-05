'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Nunito } from 'next/font/google';
import { supabase } from '@/lib/supabaseClient';
import { PortalLoadingProvider } from '@/components/PortalLoadingProvider';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';
import { commonDictionary, dict, normalizeLocale, type Locale } from '@/lib/i18n';
import { GlobalTextTranslator } from '@/components/GlobalTextTranslator';

const nunito = Nunito({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
});

const clientNav = [
  { name: 'Кампании', nameEn: 'Campaigns', href: '/client' },
  { name: 'Проекты', nameEn: 'Projects', href: '/client/projects' },
  { name: 'Лиды', nameEn: 'Leads', href: '/client/leads' },
  { name: 'Базы', nameEn: 'Databases', href: '/client/bases' },
  { name: 'Подготовить базу к запуску', nameEn: 'Prepare database', href: '/client/base-constructor' },
  { name: 'Отчёты', nameEn: 'Reports', href: '/client/reports' },
  { name: 'Парсеры', nameEn: 'Parsers', href: '/client/parsers' },
  { name: 'Запуск кампаний', nameEn: 'Launch campaigns', href: '/client/launch' },
  { name: 'Бриф', nameEn: 'Brief', href: '/client/brief' },
] as const;

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>('ru');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || cancelled) return;
      const res = await fetch('/api/user/locale', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as { locale?: Locale };
      const nextLocale = normalizeLocale(body.locale);
      setLocale(nextLocale);
      document.documentElement.lang = nextLocale;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = getPortalPageSectionTitle(pathname, locale);
  }, [locale, pathname]);

  const persistLocale = async (nextLocale: Locale) => {
    setLocale(nextLocale);
    document.documentElement.lang = nextLocale;
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    await fetch('/api/user/locale', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ locale: nextLocale }),
    });
  };

  const isActive = (href: string) =>
    href === '/client'
      ? pathname === '/client' || pathname.startsWith('/client/campaigns')
      : pathname.startsWith(href);

  return (
    <PortalLoadingProvider>
    <GlobalTextTranslator locale={locale} />
    <div className={`client-portal ${nunito.className} flex flex-col min-h-screen`}>
      <header className="sticky top-0 z-40 px-3 pt-3 pb-1 sm:px-4 sm:pt-5 sm:pb-2 md:px-8">
        <div className="neu-card flex items-center gap-2 sm:gap-3 px-3 py-2.5 sm:px-5 sm:py-3 max-w-6xl mx-auto">
          <span
            className="text-sm sm:text-base font-extrabold tracking-tight select-none shrink-0"
            style={{ color: 'var(--cp-accent)' }}
          >
            Portal
          </span>

          <div className="relative flex-1 min-w-0">
            <nav className="flex items-center gap-0.5 sm:gap-1 overflow-x-auto no-scrollbar">
              {clientNav.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href as Route}
                    className={`neu-pill shrink-0 px-2.5 py-1 sm:px-3 sm:py-1.5 text-[11px] sm:text-xs font-semibold whitespace-nowrap ${active ? 'active' : ''}`}
                    style={!active ? { color: 'var(--cp-text-m)' } : undefined}
                  >
                    {locale === 'en' ? item.nameEn : item.name}
                  </Link>
                );
              })}
            </nav>
            <div
              className="pointer-events-none absolute right-0 top-0 bottom-0 w-8"
              style={{ background: 'linear-gradient(to left, var(--cp-bg, #f0eeec) 30%, transparent)' }}
              aria-hidden="true"
            />
          </div>
          <div className="neu-pill inline-flex items-center gap-1 px-1.5 py-1">
            <button
              type="button"
              onClick={() => void persistLocale('ru')}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${locale === 'ru' ? 'active' : ''}`}
            >
              RU
            </button>
            <button
              type="button"
              onClick={() => void persistLocale('en')}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${locale === 'en' ? 'active' : ''}`}
            >
              EN
            </button>
          </div>

          <button
            type="button"
            onClick={async () => {
              await supabase.auth.signOut();
              router.push('/login' as Route);
              router.refresh();
            }}
            className="neu-pill px-2.5 py-1 sm:px-3 sm:py-1.5 text-[11px] sm:text-xs font-semibold shrink-0"
            style={{ color: 'var(--cp-text-l)' }}
          >
            {dict(commonDictionary.signOut, locale)}
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
