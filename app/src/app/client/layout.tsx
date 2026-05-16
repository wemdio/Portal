'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Menu } from 'lucide-react';
import { Nunito } from 'next/font/google';
import { supabase } from '@/lib/supabaseClient';
import { PortalLoadingProvider } from '@/components/PortalLoadingProvider';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';
import { commonDictionary, dict, normalizeLocale, type Locale } from '@/lib/i18n';
import { GlobalTextTranslator } from '@/components/GlobalTextTranslator';
import { resolveActiveNavId } from '@/lib/clientNav';
import { ClientSidebar } from '@/components/client/ClientSidebar';
import { ClientMobileDrawer } from '@/components/client/ClientMobileDrawer';

const nunito = Nunito({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
});

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>('ru');
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  const activeId = useMemo(() => resolveActiveNavId(pathname), [pathname]);

  return (
    <PortalLoadingProvider>
    <GlobalTextTranslator locale={locale} />
    <div className={`client-portal ${nunito.className} flex flex-col min-h-screen`}>
      <header className="sticky top-0 z-40 px-3 pt-3 pb-1 sm:px-4 sm:pt-4 sm:pb-2">
        <div className="neu-card flex items-center gap-2 sm:gap-3 px-3 py-2.5 sm:px-5 sm:py-3 mx-auto max-w-[1400px]">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="md:hidden neu-pill p-1.5 shrink-0"
            aria-label={locale === 'en' ? 'Open menu' : 'Открыть меню'}
            style={{ color: 'var(--cp-text-m)' }}
          >
            <Menu className="h-4 w-4" />
          </button>

          <span
            className="text-sm sm:text-base font-extrabold tracking-tight select-none shrink-0"
            style={{
              background: 'linear-gradient(160deg, #5E86C4, var(--cp-accent-h))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Portal
          </span>

          <div className="flex-1" />

          <div className="neu-pill inline-flex items-center gap-1 px-1.5 py-1 shrink-0">
            <button
              type="button"
              onClick={() => void persistLocale('ru')}
              className="rounded-full px-2 py-1 text-[11px] font-semibold transition-colors"
              style={locale === 'ru' ? { background: '#6366F1', color: '#fff' } : { color: 'var(--cp-text-l)' }}
            >
              RU
            </button>
            <button
              type="button"
              onClick={() => void persistLocale('en')}
              className="rounded-full px-2 py-1 text-[11px] font-semibold transition-colors"
              style={locale === 'en' ? { background: '#6366F1', color: '#fff' } : { color: 'var(--cp-text-l)' }}
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

      <ClientMobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeId={activeId}
        locale={locale}
      />

      <div className="flex-1 flex">
        <ClientSidebar activeId={activeId} locale={locale} />
        <main className="flex-1 min-w-0 px-3 py-4 sm:px-4 sm:py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
    </PortalLoadingProvider>
  );
}
