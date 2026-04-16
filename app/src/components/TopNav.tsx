'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { navItems, NAV_PATH_ALIASES } from '@/lib/navigation';
import { useUser } from '@/lib/UserProvider';
import { getRoleLabel, isAdmin, canAccessBillingCalendar } from '@/lib/roles';
import { commonDictionary, dict } from '@/lib/i18n';

export function TopNav() {
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

  if (pathname === '/login') return null;

  const visibleItems = navItems.filter((item) => {
    if (item.adminOnly && !isAdmin(userRole)) return false;
    if (item.billingCalendarOnly && !canAccessBillingCalendar(userRole)) return false;
    if (item.navTabId && navTabVisibility[item.navTabId] === false) return false;
    if (item.requiresTool && visibleTools !== null && !visibleTools.includes(item.requiresTool)) return false;
    if (item.href === '/profile') return false;
    return true;
  });

  return (
    <header className="sticky top-0 z-40 w-full shrink-0 border-b border-zinc-200/80 bg-white/90 backdrop-blur-md">
      <div className="flex items-center gap-4 px-4 h-11">
        <Link prefetch={false} href={'/' as Route} className="text-sm font-bold text-zinc-900 tracking-tight flex-shrink-0 mr-2">
          {dict(commonDictionary.portal, locale)}
        </Link>

        <nav className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-none pb-1">
          {visibleItems.map((item) => {
            const aliases = NAV_PATH_ALIASES[item.href] ?? [];
            const isGuide = item.href === '/guide';
            const isActive = item.href === '/'
              ? pathname === '/'
              : pathname === item.href ||
                pathname.startsWith(`${item.href}/`) ||
                aliases.some((a) => pathname === a || pathname.startsWith(`${a}/`));
            const badgeCount = item.badgeId ? (badges[item.badgeId] ?? 0) : 0;
            return (
              <Link
                key={item.id}
                href={item.href as Route}
                prefetch={false}
                className={`flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium transition-all duration-150 ${
                  isGuide
                    ? (isActive ? 'text-orange-600' : 'text-orange-500 hover:text-orange-600')
                    : (isActive ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800')
                }`}
              >
                {locale === 'en' ? item.nameEn : item.name}
                {badgeCount > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 text-[9px] font-bold rounded-full ${
                    isActive ? 'bg-white/20 text-white' : 'bg-red-500 text-white'
                  }`}>
                    {badgeCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href={'/notifications' as Route}
            prefetch={false}
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"
            title={dict(commonDictionary.notifications, locale)}
            aria-label={dict(commonDictionary.notifications, locale)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5.333a4 4 0 1 0-8 0c0 4.667-2 6-2 6h12s-2-1.333-2-6Z" />
              <path d="M9.153 13.333a1.333 1.333 0 0 1-2.306 0" />
            </svg>
            {unreadNotifications > 0 && (
              <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 text-[9px] font-bold rounded-full bg-red-500 text-white ring-2 ring-white">
                {unreadNotifications > 99 ? '99+' : unreadNotifications}
              </span>
            )}
          </Link>
          <Link
            href={'/profile' as Route}
            prefetch={false}
            className="flex items-center gap-2 rounded-full px-2 py-1 hover:bg-zinc-100 transition-colors"
          >
            {userAvatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={userAvatarUrl}
                alt=""
                className="h-6 w-6 rounded-full object-cover ring-1 ring-black/5"
                onError={handleAvatarError}
              />
            ) : (
              <div className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold bg-zinc-100 text-zinc-700 ring-1 ring-black/5">
                {(userFullName || userEmail?.split('@')[0] || 'U').slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="hidden lg:block min-w-0">
              <p className="text-[11px] font-medium text-zinc-800 truncate leading-tight max-w-[100px]">
                {userFullName || userEmail?.split('@')[0] || dict(commonDictionary.userFallback, locale)}
              </p>
              <p className="text-[10px] text-zinc-400 truncate leading-tight">
                {userRole ? getRoleLabel(userRole, locale) : ''}
              </p>
            </div>
          </Link>
          <button
            type="button"
            onClick={async () => {
              await handleSignOut();
              router.push('/login' as Route);
              router.refresh();
            }}
            className="text-[11px] text-zinc-400 hover:text-red-500 px-2 py-1 rounded-md hover:bg-zinc-50 transition-colors"
            title={dict(commonDictionary.signOut, locale)}
            aria-label={dict(commonDictionary.signOut, locale)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 14H3.333A1.333 1.333 0 012 12.667V3.333A1.333 1.333 0 013.333 2H6M10.667 11.333L14 8l-3.333-3.333M14 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </div>
    </header>
  );
}
