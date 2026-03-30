'use client';

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

const STUCK_NAV_CLEAR_MS = 12000;

type PortalLoadingContextValue = {
  beginBlocking: () => void;
  endBlocking: () => void;
};

const PortalLoadingContext = createContext<PortalLoadingContextValue | null>(null);

/** Показать глобальную плашку «Загрузка страницы…» на время долгих запросов на текущей странице. */
export function usePortalBlockingLoad(active: boolean) {
  const ctx = useContext(PortalLoadingContext);
  useEffect(() => {
    if (!ctx || !active) return;
    ctx.beginBlocking();
    return () => {
      ctx.endBlocking();
    };
  }, [active, ctx]);
}

function sameRoute(a: URL, b: URL): boolean {
  return a.pathname === b.pathname && a.search === b.search;
}

function NavigationRouteDetector({
  onNavigatingChange,
}: {
  onNavigatingChange: (v: boolean) => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const routeKey = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

  useEffect(() => {
    onNavigatingChange(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [routeKey, onNavigatingChange]);

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) onNavigatingChange(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [onNavigatingChange]);

  useEffect(() => {
    const clearStuckNav = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      timeoutRef.current = setTimeout(() => {
        onNavigatingChange(false);
        timeoutRef.current = null;
      }, STUCK_NAV_CLEAR_MS);
    };

    const onClickCapture = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      if (href.startsWith('javascript:')) return;

      let nextUrl: URL;
      try {
        nextUrl = new URL(href, window.location.origin);
      } catch {
        return;
      }

      if (nextUrl.origin !== window.location.origin) return;

      const currentUrl = new URL(window.location.href);
      if (sameRoute(nextUrl, currentUrl)) return;

      onNavigatingChange(true);
      clearStuckNav();
    };

    // Не слушаем popstate: при «Назад»/«Вперёд» Next.js и bfcache часто не совпадают по
    // таймингу с usePathname(), из‑за чего navigating оставался true бесконечно.
    // Индикатор нужен для кликов по внутренним ссылкам (медленный RSC).

    document.addEventListener('click', onClickCapture, true);
    return () => {
      document.removeEventListener('click', onClickCapture, true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [onNavigatingChange]);

  return null;
}

function PortalLoadingPill({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="pointer-events-none fixed top-14 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full border border-zinc-200/90 bg-white/95 px-4 py-2.5 text-sm font-medium text-zinc-800 shadow-lg shadow-zinc-900/10 backdrop-blur-sm sm:top-16"
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" aria-hidden />
      <span>Загрузка страницы…</span>
    </div>
  );
}

export function PortalLoadingProvider({ children }: { children: React.ReactNode }) {
  const [blockingCount, setBlockingCount] = useState(0);
  const [navigating, setNavigating] = useState(false);

  const beginBlocking = useCallback(() => {
    setBlockingCount((c) => c + 1);
  }, []);

  const endBlocking = useCallback(() => {
    setBlockingCount((c) => Math.max(0, c - 1));
  }, []);

  const ctx = useMemo(
    () => ({ beginBlocking, endBlocking }),
    [beginBlocking, endBlocking],
  );

  const onNavigatingChange = useCallback((v: boolean) => {
    setNavigating(v);
  }, []);

  const show = navigating || blockingCount > 0;

  return (
    <PortalLoadingContext.Provider value={ctx}>
      <Suspense fallback={null}>
        <NavigationRouteDetector onNavigatingChange={onNavigatingChange} />
      </Suspense>
      <PortalLoadingPill visible={show} />
      {children}
    </PortalLoadingContext.Provider>
  );
}
