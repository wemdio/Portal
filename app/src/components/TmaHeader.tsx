'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { navItems } from '@/lib/navigation';
import { isAdmin } from '@/lib/roles';
import { useUser } from '@/lib/UserProvider';
import { LanguageToggle } from '@/components/LanguageToggle';
import { commonDictionary, dict } from '@/lib/i18n';

export function TmaHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    userRole,
    userEmail,
    userFullName,
    userAvatarUrl,
    locale,
    handleAvatarError,
    handleSignOut,
  } = useUser();

  const userName = userFullName || userEmail?.split('@')[0] || null;

  const onSignOut = () => {
    void (async () => {
      await handleSignOut();
      router.push('/login' as Route);
      router.refresh();
    })();
  };

  const items = useMemo(() => {
    return navItems.filter((item) => !item.adminOnly || isAdmin(userRole));
  }, [userRole]);

  const activeItem = useMemo(() => {
    const exact = items.find((item) => item.href === pathname);
    if (exact) return exact;
    return items.find((item) => item.href !== '/' && pathname.startsWith(`${item.href}/`)) ?? items[0];
  }, [items, pathname]);

  if (pathname === '/login') return null;

  return (
    <div
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{ borderColor: 'var(--tma-border)', backgroundColor: 'var(--tma-bg)' }}
    >
      <div className="flex items-start gap-3 px-4 pb-2 tma-safe-top">
        <div className="min-w-0 flex-1">
          <p className="tma-muted text-[11px] uppercase tracking-wide">
            Portal
          </p>
          <h1 className="tma-text truncate text-lg font-semibold">
            {activeItem ? (locale === 'en' ? activeItem.nameEn : activeItem.name) : dict(commonDictionary.portal, locale)}
          </h1>
        </div>
        <LanguageToggle compact />
        <Link
          href={'/profile' as Route}
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition tma-chip"
          aria-label={dict(commonDictionary.openProfile, locale)}
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
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/10 text-[11px] font-bold"
              aria-hidden="true"
            >
              {(userName ?? 'U').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="max-w-[10ch] truncate">{userName ?? (locale === 'en' ? 'Profile' : 'Профиль')}</span>
        </Link>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-center gap-2 overflow-x-auto">
          {items.map((item) => {
            const isGuide = item.href === '/guide';
            const isActive = item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.id}
                href={item.href as Route}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition ${
                  isGuide
                    ? (isActive ? 'text-orange-400' : 'text-orange-300')
                    : (isActive ? 'tma-chip-active' : 'tma-chip')
                }`}
              >
                {locale === 'en' ? item.nameEn : item.name}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={onSignOut}
            className="whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition tma-chip-danger"
          >
            {dict(commonDictionary.signOut, locale)}
          </button>
        </div>
      </div>
    </div>
  );
}
