'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { getRoleLabel, isAdmin, isTechnician, canAccessBillingCalendar } from '@/lib/roles';
import { navItems, NAV_PATH_ALIASES } from '@/lib/navigation';
import { useUser } from '@/lib/UserProvider';
import { commonDictionary, dict } from '@/lib/i18n';

type SidebarProps = {
  collapsed?: boolean;
  isTma?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  mobileOnlyDrawer?: boolean;
};

type TmaTheme = 'dark' | 'light';
const TMA_THEME_STORAGE_KEY = 'tma_theme';

function normalizeTmaTheme(value: string | null | undefined): TmaTheme {
  return value === 'light' ? 'light' : 'dark';
}

export function Sidebar({ collapsed = false, isTma = false, mobileOpen = false, onMobileClose, mobileOnlyDrawer = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const {
    userRole,
    userEmail,
    userFullName,
    userAvatarUrl,
    navTabVisibility,
    visibleTools,
    badges,
    unreadNotifications,
    locale,
    handleAvatarError,
    handleSignOut,
  } = useUser();
  const [hovered, setHovered] = useState(false);
  const [tmaTheme, setTmaTheme] = useState<TmaTheme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const root = document.documentElement;
    const storedTheme = window.localStorage.getItem(TMA_THEME_STORAGE_KEY);
    return normalizeTmaTheme(storedTheme ?? root.dataset.tmaTheme);
  });

  useEffect(() => {
    if (!isTma || typeof window === 'undefined') return;
    const root = document.documentElement;
    root.dataset.tmaTheme = tmaTheme;
    window.localStorage.setItem(TMA_THEME_STORAGE_KEY, tmaTheme);
  }, [isTma, tmaTheme]);

  function handleTmaThemeChange(nextTheme: TmaTheme) {
    if (!isTma) return;
    setTmaTheme(nextTheme);
  }

  async function onSignOut() {
    await handleSignOut();
    router.push('/login' as Route);
    router.refresh();
  }

  // Hide sidebar on login page
  if (pathname === '/login') return null;

  const sidebarContent = (
    <>
      <div
        className={`flex h-10 items-center px-3 border-b flex-shrink-0 safe-top ${
          isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'border-zinc-100'
        }`}
      >
        <span className={`text-xs font-bold tracking-tight ${isTma ? 'tma-text' : ''}`}>{dict(commonDictionary.portal, locale)}</span>
        {isTma && (
          <button
            type="button"
            onClick={() => onMobileClose?.()}
            className="md:hidden ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--tma-fg)' }}
            aria-label={dict(commonDictionary.closeMenu, locale)}
          >
            ✕
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 px-1.5 py-2 overflow-y-auto">
        {navItems.map((item) => {
          if (item.adminOnly && !isAdmin(userRole)) return null;
          if (item.technicianOrAdmin && !isTechnician(userRole)) return null;
          if (item.billingCalendarOnly && !canAccessBillingCalendar(userRole)) return null;
          if (item.navTabId && navTabVisibility[item.navTabId] === false) return null;
          if (item.requiresTool && visibleTools !== null && !visibleTools.includes(item.requiresTool)) return null;

          const isGuide = item.href === '/guide';
          const aliases = NAV_PATH_ALIASES[item.href] ?? [];
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname === item.href ||
              pathname.startsWith(`${item.href}/`) ||
              aliases.some((alias) => pathname === alias || pathname.startsWith(`${alias}/`));
          const badgeCount = item.badgeId ? (badges[item.badgeId] ?? 0) : 0;
          return (
            <Link
              key={item.id}
              href={item.href as Route}
              prefetch={false}
              onClick={() => onMobileClose?.()}
              className={`flex items-center rounded-lg px-2.5 py-1.5 text-[11px] truncate transition-all duration-200
                ${isGuide
                  ? (isActive ? 'text-orange-600 font-medium' : 'text-orange-500 hover:text-orange-600')
                  : (isActive
                    ? (isTma ? 'tma-chip-active font-medium' : 'bg-gray-100 text-gray-900 font-medium')
                    : (isTma ? 'tma-nav-item' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'))
                }
              `}
            >
              {locale === 'en' ? item.nameEn : item.name}
              {badgeCount > 0 && (
                <span className="ml-auto inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[9px] font-bold text-white bg-red-500 rounded-full">
                  {badgeCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div
        className={`p-1.5 border-t flex-shrink-0 safe-bottom ${
          isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'border-zinc-100'
        }`}
      >
        <Link
          href={'/profile' as Route}
          prefetch={false}
          onClick={() => onMobileClose?.()}
          className={`mb-2 flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition ${
            isTma ? 'hover:bg-[color:var(--tma-surface-2)]' : 'hover:bg-zinc-50'
          }`}
          aria-label={dict(commonDictionary.openProfile, locale)}
        >
          {userAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={userAvatarUrl}
              alt=""
              className="h-7 w-7 rounded-full object-cover ring-1 ring-black/5"
              onError={handleAvatarError}
            />
          ) : (
            <div
              className={`h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold ring-1 ring-black/5 ${
                isTma ? 'tma-chip' : 'bg-zinc-100 text-zinc-700'
              }`}
              aria-hidden="true"
            >
              {(userFullName || userEmail?.split('@')[0] || 'U').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p
              className={`text-[11px] font-medium truncate leading-tight ${isTma ? 'tma-text' : 'text-zinc-900'}`}
              title={userFullName || userEmail || ''}
            >
              {userFullName || userEmail?.split('@')[0] || dict(commonDictionary.userFallback, locale)}
            </p>
            <p className={`text-[10px] mt-0.5 truncate leading-tight ${isTma ? 'tma-muted' : 'text-zinc-500'}`}>
              {userRole ? getRoleLabel(userRole, locale) : dict(commonDictionary.unknownRole, locale)}
            </p>
          </div>
        </Link>
        <Link
          href={'/notifications' as Route}
          prefetch={false}
          onClick={() => onMobileClose?.()}
          className={`mb-2 flex w-full items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] transition-colors ${
            isTma ? 'tma-nav-item' : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900'
          }`}
          aria-label={dict(commonDictionary.notifications, locale)}
        >
          <span className="relative">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5.333a4 4 0 1 0-8 0c0 4.667-2 6-2 6h12s-2-1.333-2-6Z" />
              <path d="M9.153 13.333a1.333 1.333 0 0 1-2.306 0" />
            </svg>
            {unreadNotifications > 0 && (
              <span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 text-[8px] font-bold rounded-full bg-red-500 text-white">
                {unreadNotifications > 99 ? '99+' : unreadNotifications}
              </span>
            )}
          </span>
          {dict(commonDictionary.notifications, locale)}
        </Link>
        {isTma && (
          <div
            className="mb-3 rounded-xl border p-2"
            style={{ borderColor: 'var(--tma-border)', backgroundColor: 'var(--tma-surface-2)' }}
          >
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide tma-muted">
              {locale === 'en' ? 'Interface theme' : 'Тема интерфейса'}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => handleTmaThemeChange('dark')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  tmaTheme === 'dark' ? 'tma-chip-active' : 'tma-chip'
                }`}
              >
                {locale === 'en' ? 'Dark' : 'Тёмная'}
              </button>
              <button
                type="button"
                onClick={() => handleTmaThemeChange('light')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  tmaTheme === 'light' ? 'tma-chip-active' : 'tma-chip'
                }`}
              >
                {locale === 'en' ? 'Light' : 'Светлая'}
              </button>
            </div>
          </div>
        )}
        <button
          onClick={onSignOut}
          className={`flex w-full items-center rounded-md px-1.5 py-1 text-[11px] transition-colors ${
            isTma
              ? 'tma-danger hover:bg-[color:var(--tma-surface-2)]'
              : 'text-zinc-500 hover:bg-zinc-50 hover:text-red-600'
          }`}
        >
          {dict(commonDictionary.signOut, locale)}
        </button>
      </div>
    </>
  );

  if (!isTma) {
    if (mobileOnlyDrawer) {
      return (
        <div className={`fixed inset-0 z-50 ${mobileOpen ? '' : 'pointer-events-none'}`}>
          <div
            className={`absolute inset-0 bg-black/40 transition-opacity ${mobileOpen ? 'opacity-100' : 'opacity-0'}`}
            onClick={() => onMobileClose?.()}
            aria-hidden="true"
          />
          <div
            className={`absolute left-0 top-0 h-full w-full max-w-[min(100vw-3rem,20rem)] border-r border-zinc-200/80 bg-white shadow-2xl transition-transform duration-200 ${
              mobileOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 shrink-0">
                <span className="text-base font-bold text-zinc-900">{dict(commonDictionary.portal, locale)}</span>
                <button
                  type="button"
                  onClick={() => onMobileClose?.()}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100"
                  aria-label={dict(commonDictionary.closeMenu, locale)}
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto flex flex-col">{sidebarContent}</div>
            </div>
          </div>
        </div>
      );
    }
    if (collapsed) {
      return (
        <div
          className="fixed left-0 top-0 h-screen z-50"
          style={{ width: hovered ? 160 : 12 }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {!hovered && (
            <div className="absolute left-0 top-0 w-3 h-full bg-gradient-to-r from-zinc-200/60 to-transparent cursor-pointer" />
          )}
          <div
            className={`absolute left-0 top-0 h-full w-40 bg-white border-r border-zinc-200/80 shadow-2xl flex flex-col text-zinc-900
              transition-all duration-200 ease-out
              ${hovered ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 pointer-events-none'}`}
          >
            {sidebarContent}
          </div>
        </div>
      );
    }

    return (
      <div className="fixed left-0 top-0 z-40 flex h-screen w-40 flex-col border-r border-zinc-200/80 bg-white text-zinc-900 flex-shrink-0">
        {sidebarContent}
      </div>
    );
  }

  const mobileDrawer = (
    <div className={`fixed inset-0 z-50 ${mobileOpen ? '' : 'pointer-events-none'}`}>
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity ${mobileOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={() => onMobileClose?.()}
      />
      <div
        className={`absolute left-0 top-0 h-full w-full border-r shadow-2xl transition-transform ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } ${isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'bg-white border-zinc-200/80'}`}
      >
        <div className="flex h-full w-full flex-col">{sidebarContent}</div>
      </div>
    </div>
  );

  return mobileDrawer;
}
