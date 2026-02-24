'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { supabase } from '@/lib/supabaseClient';
import type { Session } from '@supabase/supabase-js';
import { UserRole } from '@/types';
import { ROLE_LABELS, isAdmin, canAccessBillingCalendar } from '@/lib/roles';
import { navItems } from '@/lib/navigation';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';

type SidebarProps = {
  collapsed?: boolean;
  isTma?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

const navActiveAliases: Record<string, string[]> = {
  '/tools': ['/parsers'],
};

type TmaTheme = 'dark' | 'light';
const TMA_THEME_STORAGE_KEY = 'tma_theme';

function normalizeTmaTheme(value: string | null | undefined): TmaTheme {
  return value === 'light' ? 'light' : 'dark';
}

export function Sidebar({ collapsed = false, isTma = false, mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userFullName, setUserFullName] = useState<string | null>(null);
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [avatarTriedSigned, setAvatarTriedSigned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [tmaTheme, setTmaTheme] = useState<TmaTheme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const root = document.documentElement;
    const storedTheme = window.localStorage.getItem(TMA_THEME_STORAGE_KEY);
    return normalizeTmaTheme(storedTheme ?? root.dataset.tmaTheme);
  });

  async function fetchUserRole(userId: string) {
    const { data } = await supabase
      .from('profiles')
      .select('role, full_name, avatar_url')
      .eq('id', userId)
      .single();

    return {
      role: (data?.role as UserRole | null) ?? null,
      full_name: typeof data?.full_name === 'string' ? data.full_name : null,
      avatar_url: typeof data?.avatar_url === 'string' ? data.avatar_url : null,
    };
  }

  useEffect(() => {
    let isMounted = true;

    const applySession = async (session: Session | null) => {
      if (!isMounted) return;

      if (!session) {
        setUserEmail(null);
        setUserRole(null);
        setUserFullName(null);
        setUserAvatarUrl(null);
        return;
      }

      setUserEmail(session.user.email ?? null);
      const profile = await fetchUserRole(session.user.id);
      if (!isMounted) return;
      setUserRole(profile.role);
      setUserFullName(profile.full_name);
      setUserAvatarUrl(normalizePublicAvatarUrl(profile.avatar_url));
    };

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      await applySession(session);
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      void applySession(session);
    });

    return () => {
      isMounted = false;
      subscription?.unsubscribe();
    };
  }, []);

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

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login' as Route);
    router.refresh();
  }

  // Hide sidebar on login page
  if (pathname === '/login') return null;

  const sidebarContent = (
    <>
      <div
        className={`flex h-10 items-center px-3 border-b flex-shrink-0 safe-top ${
          isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'border-gray-100'
        }`}
      >
        <span className={`text-xs font-bold tracking-tight ${isTma ? 'tma-text' : ''}`}>Portal</span>
        {isTma && (
          <button
            type="button"
            onClick={() => onMobileClose?.()}
            className="md:hidden ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--tma-fg)' }}
            aria-label="Закрыть меню"
          >
            ✕
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 px-1.5 py-2 overflow-y-auto">
        {navItems.map((item) => {
          if (item.adminOnly && !isAdmin(userRole)) return null;
          if (item.billingCalendarOnly && !canAccessBillingCalendar(userRole)) return null;

          const aliases = navActiveAliases[item.href] ?? [];
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname === item.href ||
              pathname.startsWith(`${item.href}/`) ||
              aliases.some((alias) => pathname === alias || pathname.startsWith(`${alias}/`));
          return (
            <Link
              key={item.name}
              href={item.href as Route}
              onClick={() => onMobileClose?.()}
              className={`flex items-center rounded-md px-2 py-1 text-[11px] truncate transition-colors duration-200
                ${isActive
                  ? (isTma
                      ? 'tma-chip-active font-medium'
                      : 'bg-gray-100 text-gray-900 font-medium')
                  : (isTma
                      ? 'tma-nav-item'
                      : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900')
                }
              `}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div
        className={`p-1.5 border-t flex-shrink-0 safe-bottom ${
          isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'border-gray-100'
        }`}
      >
        <Link
          href={'/profile' as Route}
          onClick={() => onMobileClose?.()}
          className={`mb-2 flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition ${
            isTma ? 'hover:bg-[color:var(--tma-surface-2)]' : 'hover:bg-gray-50'
          }`}
          aria-label="Открыть профиль"
        >
          {userAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={userAvatarUrl}
              alt=""
              className="h-7 w-7 rounded-full object-cover ring-1 ring-black/5"
              onError={() => {
                if (avatarTriedSigned) {
                  setUserAvatarUrl(null);
                  return;
                }
                setAvatarTriedSigned(true);
                void (async () => {
                  const { data: { session } } = await supabase.auth.getSession();
                  const token = session?.access_token;
                  if (!token) {
                    setUserAvatarUrl(null);
                    return;
                  }
                  const res = await fetch('/api/profile/avatar/signed', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  if (!res.ok) {
                    setUserAvatarUrl(null);
                    return;
                  }
                  const data = (await res.json()) as { readUrl?: unknown };
                  if (typeof data.readUrl === 'string' && data.readUrl.trim()) {
                    setUserAvatarUrl(data.readUrl.trim());
                  } else {
                    setUserAvatarUrl(null);
                  }
                })();
              }}
            />
          ) : (
            <div
              className={`h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold ring-1 ring-black/5 ${
                isTma ? 'tma-chip' : 'bg-gray-100 text-gray-700'
              }`}
              aria-hidden="true"
            >
              {(userFullName || userEmail?.split('@')[0] || 'U').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p
              className={`text-[11px] font-medium truncate leading-tight ${isTma ? 'tma-text' : 'text-gray-900'}`}
              title={userFullName || userEmail || ''}
            >
              {userFullName || userEmail?.split('@')[0] || 'User'}
            </p>
            <p className={`text-[10px] mt-0.5 truncate leading-tight ${isTma ? 'tma-muted' : 'text-gray-500'}`}>
              {userRole ? ROLE_LABELS[userRole] : '...'}
            </p>
          </div>
        </Link>
        {isTma && (
          <div
            className="mb-3 rounded-xl border p-2"
            style={{ borderColor: 'var(--tma-border)', backgroundColor: 'var(--tma-surface-2)' }}
          >
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide tma-muted">
              Тема интерфейса
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => handleTmaThemeChange('dark')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  tmaTheme === 'dark' ? 'tma-chip-active' : 'tma-chip'
                }`}
              >
                Тёмная
              </button>
              <button
                type="button"
                onClick={() => handleTmaThemeChange('light')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  tmaTheme === 'light' ? 'tma-chip-active' : 'tma-chip'
                }`}
              >
                Светлая
              </button>
            </div>
          </div>
        )}
        <button
          onClick={handleSignOut}
          className={`flex w-full items-center rounded-md px-1.5 py-1 text-[11px] transition-colors ${
            isTma
              ? 'tma-danger hover:bg-[color:var(--tma-surface-2)]'
              : 'text-gray-500 hover:bg-gray-50 hover:text-red-600'
          }`}
        >
          Выйти
        </button>
      </div>
    </>
  );

  if (!isTma) {
    if (collapsed) {
      return (
        <div
          className="fixed left-0 top-0 h-screen z-50"
          style={{ width: hovered ? 160 : 12 }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {!hovered && (
            <div className="absolute left-0 top-0 w-3 h-full bg-gradient-to-r from-gray-200/60 to-transparent cursor-pointer" />
          )}
          <div
            className={`absolute left-0 top-0 h-full w-40 bg-white border-r border-gray-200 shadow-2xl flex flex-col text-gray-900
              transition-all duration-200 ease-out
              ${hovered ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 pointer-events-none'}`}
          >
            {sidebarContent}
          </div>
        </div>
      );
    }

    return (
      <div className="fixed left-0 top-0 z-40 flex h-screen w-40 flex-col border-r border-gray-200 bg-white text-gray-900 flex-shrink-0">
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
        } ${isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'bg-white border-gray-200'}`}
      >
        <div className="flex h-full w-full flex-col">{sidebarContent}</div>
      </div>
    </div>
  );

  return mobileDrawer;
}
