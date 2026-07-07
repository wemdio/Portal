'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { resolveActiveNavId, CLIENT_NAV_SUPPORT, type ClientNavMode } from '@/lib/clientNav';
import { clientApiFetch } from '@/lib/clientFetcher';
import { ClientSidebar } from '@/components/client/ClientSidebar';
import { ClientMobileDrawer } from '@/components/client/ClientMobileDrawer';
import { DemoBanner } from '@/components/client/DemoBanner';
import { DemoRegisterGate } from '@/components/client/DemoRegisterGate';
import { PaymentLockedBanner } from '@/components/client/PaymentLockedBanner';
import { ClientPortalProvider } from '@/lib/clientPortalContext';

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
  const [navMode, setNavMode] = useState<ClientNavMode>('manual');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement | null>(null);

  // Бейдж непрочитанных сообщений поддержки и флаг BYO-почт раньше жили внутри
  // ClientNavList, который монтируется ДВАЖДЫ (десктоп-сайдбар + мобильный
  // drawer) → два независимых таймера /support/unread и два запроса
  // /mailboxes/enabled на каждую навигацию. Поднимаем их в layout (один поллер,
  // один источник правды) и раздаём в навигацию через ClientPortalProvider.
  const [supportUnread, setSupportUnread] = useState(0);
  const [mailboxesEnabled, setMailboxesEnabled] = useState(false);

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

      // Параллельно тянем locale и portal-mode — оба нужны для первого
      // рендера. Mode возвращает 'auto'|'manual' по комбинации
      // profiles.auto_pipeline_enabled + configs.enabled.
      const [localeRes, modeRes] = await Promise.all([
        fetch('/api/user/locale', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/client/portal-mode', { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      if (cancelled) return;

      if (localeRes.ok) {
        const body = (await localeRes.json()) as { locale?: Locale };
        const nextLocale = normalizeLocale(body.locale);
        setLocale(nextLocale);
        document.documentElement.lang = nextLocale;
      }

      if (modeRes.ok) {
        const body = (await modeRes.json()) as { mode?: ClientNavMode };
        if (body.mode === 'auto' || body.mode === 'manual') {
          setNavMode(body.mode);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = getPortalPageSectionTitle(pathname, locale);
  }, [locale, pathname]);

  // BYO-почты (пилот): грузим флаг видимости один раз за сессию.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await clientApiFetch<{ enabled?: boolean }>('/mailboxes/enabled');
        if (!cancelled) setMailboxesEnabled(data.enabled === true);
      } catch {
        /* тихо скрываем пункт при любой ошибке */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Непрочитанные сообщения поддержки. Источник правды — серверный COUNT
  // (/support/unread). Авторитетный refetch (а не инкремент) держит счётчик
  // верным между вкладками и при пропущенных/дублированных событиях.
  const pollSupportUnread = useCallback(async () => {
    try {
      const data = await clientApiFetch<{ unread?: number }>('/support/unread');
      setSupportUnread(typeof data.unread === 'number' ? data.unread : 0);
    } catch {
      /* бейдж не критичен — при ошибке просто не подсвечиваем */
    }
  }, []);

  // Поллинг непрочитанных сообщений поддержки (один таймер на весь портал).
  // Supabase Realtime на проде сейчас недоступен (восстанавливается отдельной
  // задачей), поэтому это основной механизм «почти мгновенного» бейджа:
  // короткий интервал + немедленный refetch при возврате на вкладку/в окно
  // (focus + visibilitychange). Когда realtime починят — сюда вернётся подписка
  // на public.notifications, а интервал можно будет увеличить.
  useEffect(() => {
    void pollSupportUnread();
    const timer = setInterval(() => void pollSupportUnread(), 12_000);
    const onFocus = () => void pollSupportUnread();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pollSupportUnread();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pollSupportUnread]);

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

  // Клиент открыл «Поддержку» → сервер пометил тред прочитанным (GET
  // /support/thread). Обнуляем счётчик сразу при смене раздела (React-паттерн
  // «правка state при смене пропа во время рендера»), чтобы бейдж не мигнул
  // старым числом при возврате на другую страницу до следующего поллинга.
  const [prevActiveId, setPrevActiveId] = useState(activeId);
  if (activeId !== prevActiveId) {
    setPrevActiveId(activeId);
    if (activeId === CLIENT_NAV_SUPPORT.id && supportUnread !== 0) {
      setSupportUnread(0);
    }
  }

  const portalContextValue = useMemo(
    () => ({ portalMode: navMode, supportUnread, mailboxesEnabled }),
    [navMode, supportUnread, mailboxesEnabled],
  );

  const currentLocaleDesc = LOCALE_DESCRIPTORS[locale];

  return (
    <PortalLoadingProvider>
    <ClientPortalProvider value={portalContextValue}>
    <GlobalTextTranslator locale={locale} />
    <LanguageLoadingOverlay />
    <div className={`client-portal ${inter.variable} ${jetbrainsMono.variable} flex flex-col min-h-screen`}>
      <DemoBanner />
      <DemoRegisterGate />
      <PaymentLockedBanner />
      <header
        className="sticky top-0 z-40"
        style={{ background: 'var(--cp-ink)', borderBottom: '1px solid var(--cp-divider)' }}
      >
        {/* Minimal bar — no card chrome. Logo left, controls (lang + sign out)
            anchored right via the flex-1 spacer; bg matches the page with a thin
            bottom hairline so scrolled content doesn't bleed under it. */}
        <div className="flex items-center gap-2 sm:gap-3 px-3 py-2 sm:px-6 sm:py-2.5 mx-auto max-w-[1600px]">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="md:hidden neu-pill p-1.5 shrink-0"
            aria-label={locale === 'en' ? 'Open menu' : 'Открыть меню'}
            style={{ color: 'var(--cp-text-m)' }}
          >
            <Menu className="h-4 w-4" />
          </button>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/outreachos-logo.png"
            alt="outreachOS"
            width={760}
            height={139}
            className="h-5 sm:h-6 w-auto shrink-0 select-none"
          />

          <div className="flex-1" />

          {/* Multi-locale dropdown. Uses the same neu-pill styling as the
              old RU/EN toggle for visual continuity. The dropdown panel is
              flagged `data-i18n-skip` so the GlobalTextTranslator never
              touches the native-language labels (e.g. "Deutsch" must stay
              "Deutsch", not get retranslated).

              Trigger shows just the locale code — the previous «{flag} {code}»
              combo rendered as «ru RU» on systems where the Russian flag
              emoji falls back to «ru» text, reading as a duplicate. The flag
              still appears inside the dropdown panel where each row gets
              full context. */}
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
        mode={navMode}
      />

      {/* Layout shell: wrap sidebar + main in the same 1600px viewport-centered
          column the header uses (line 134), so:
            (a) sidebar's left edge sits at the header's left edge — they look
                like one column, not two layout systems competing,
            (b) main content centers inside `viewport-center-minus-sidebar`
                rather than `viewport-minus-sidebar`, removing the ~140px
                perceptual rightward drift the user flagged in the 2026-05-26
                dashboard screenshot. */}
      <div className="flex-1 flex w-full max-w-[1600px] mx-auto">
        <ClientSidebar activeId={activeId} locale={locale} mode={navMode} />
        <main className="flex-1 min-w-0 px-3 py-4 sm:px-4 sm:py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
    </ClientPortalProvider>
    </PortalLoadingProvider>
  );
}
