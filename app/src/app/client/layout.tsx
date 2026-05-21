'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Menu } from 'lucide-react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { supabase } from '@/lib/supabaseClient';
import { PortalLoadingProvider } from '@/components/PortalLoadingProvider';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';
import {
  LOCALES,
  LOCALE_DESCRIPTORS,
  commonDictionary,
  dict,
  normalizeLocale,
  type Locale,
} from '@/lib/i18n';
import { ChevronDown } from 'lucide-react';
import { GlobalTextTranslator, LanguageLoadingOverlay } from '@/components/GlobalTextTranslator';
import { resolveActiveNavId } from '@/lib/clientNav';
import { ClientSidebar } from '@/components/client/ClientSidebar';
import { ClientMobileDrawer } from '@/components/client/ClientMobileDrawer';
import { DemoBanner } from '@/components/client/DemoBanner';
import { PaymentLockedBanner } from '@/components/client/PaymentLockedBanner';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-mono',
});

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>('ru');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!langOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!langRef.current) return;
      if (langRef.current.contains(e.target as Node)) return;
      setLangOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLangOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [langOpen]);

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

  const currentLocaleDesc = LOCALE_DESCRIPTORS[locale];

  return (
    <PortalLoadingProvider>
    <GlobalTextTranslator locale={locale} />
    <LanguageLoadingOverlay
      title={dict(commonDictionary.translatingPage, locale)}
      hint={dict(commonDictionary.translatingHint, locale)}
    />
    <div className={`client-portal ${inter.variable} ${jetbrainsMono.variable} flex flex-col min-h-screen`}>
      <DemoBanner />
      <PaymentLockedBanner />
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
            style={{ color: 'var(--cp-text)' }}
          >
            Portal
          </span>

          <div className="flex-1" />

          {/* Multi-locale dropdown. Uses the same neu-pill styling as the
              old RU/EN toggle for visual continuity. The dropdown panel is
              flagged `data-i18n-skip` so the GlobalTextTranslator never
              touches the native-language labels (e.g. "Deutsch" must stay
              "Deutsch", not get retranslated). */}
          <div ref={langRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setLangOpen((v) => !v)}
              className="neu-pill inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold transition-colors"
              style={{ color: 'var(--cp-text-l)' }}
              aria-haspopup="listbox"
              aria-expanded={langOpen}
              aria-label={dict(commonDictionary.language, locale)}
            >
              <span aria-hidden>{currentLocaleDesc.flag}</span>
              <span>{currentLocaleDesc.code}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {langOpen && (
              <div
                data-i18n-skip
                role="listbox"
                aria-label={dict(commonDictionary.language, locale)}
                className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-md"
                style={{
                  background: 'var(--cp-surface-elev)',
                  border: '1px solid var(--cp-divider-strong)',
                }}
              >
                {LOCALES.map((code) => {
                  const desc = LOCALE_DESCRIPTORS[code];
                  const isActive = code === locale;
                  return (
                    <button
                      key={code}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => {
                        setLangOpen(false);
                        if (code !== locale) void persistLocale(code);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
                      style={
                        isActive
                          ? { background: 'var(--cp-paper)', color: 'var(--cp-ink)' }
                          : { color: 'var(--cp-paper-mute)' }
                      }
                    >
                      <span aria-hidden className="text-base leading-none">{desc.flag}</span>
                      <span className="font-semibold">{desc.code}</span>
                      <span
                        className="ml-auto text-[11px]"
                        style={{ opacity: isActive ? 0.85 : 0.6 }}
                      >
                        {desc.nativeName}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
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
