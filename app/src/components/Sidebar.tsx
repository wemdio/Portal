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
import { ALL_NAV_TAB_IDS } from '@/lib/toolsRegistry';

type SidebarProps = {
  collapsed?: boolean;
  isTma?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** На мобильных (ниже md) рендерить только выезжающую панель, не фиксированный сайдбар */
  mobileOnlyDrawer?: boolean;
};

const navActiveAliases: Record<string, string[]> = {
  '/tools': ['/parsers'],
};

type TmaTheme = 'dark' | 'light';
const TMA_THEME_STORAGE_KEY = 'tma_theme';

function normalizeTmaTheme(value: string | null | undefined): TmaTheme {
  return value === 'light' ? 'light' : 'dark';
}

export function Sidebar({ collapsed = false, isTma = false, mobileOpen = false, onMobileClose, mobileOnlyDrawer = false }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userFullName, setUserFullName] = useState<string | null>(null);
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [avatarTriedSigned, setAvatarTriedSigned] = useState(false);
  const [navTabVisibility, setNavTabVisibility] = useState<Record<string, boolean>>({});
  const [hovered, setHovered] = useState(false);
  const [visibleTools, setVisibleTools] = useState<string[] | null>(null);
  const [badges, setBadges] = useState<Record<string, number>>({});
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
        setNavTabVisibility({});
        return;
      }

      setUserEmail(session.user.email ?? null);
      const [profile, navRows] = await Promise.all([
        fetchUserRole(session.user.id),
        supabase
          .from('user_tool_visibility')
          .select('tool_id, enabled')
          .eq('user_id', session.user.id)
          .in('tool_id', ALL_NAV_TAB_IDS as unknown as string[])
          .then(({ data }) => data),
      ]);
      if (!isMounted) return;
      setUserRole(profile.role);
      setUserFullName(profile.full_name);
      setUserAvatarUrl(normalizePublicAvatarUrl(profile.avatar_url));

      const vis: Record<string, boolean> = {};
      for (const id of ALL_NAV_TAB_IDS) {
        const row = navRows?.find((r) => r.tool_id === id);
        vis[id] = row?.enabled ?? false;
      }
      setNavTabVisibility(vis);
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
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || cancelled) return;
      const headers = { Authorization: `Bearer ${token}` };

      const [toolsRes, submittedRes, reworkRes] = await Promise.all([
        fetch('/api/user/tools', { headers }).then((r) => r.json()).catch(() => ({ toolIds: [] })),
        fetch('/api/database-review/requests?status=submitted', { headers }).then((r) => r.json()).catch(() => ({ requests: [] })),
        fetch('/api/database-review/requests', { headers }).then((r) => r.json()).catch(() => ({ requests: [] })),
      ]);
      if (cancelled) return;
      const tools = (toolsRes.toolIds ?? []) as string[];
      setVisibleTools(tools);
      const reworkStatuses = new Set(['needs_rework', 'client_requested_changes']);
      const reworkCount = ((reworkRes.requests ?? []) as Array<{ status: string }>).filter(
        (r) => reworkStatuses.has(r.status),
      ).length;
      setBadges({
        'review-count': tools.includes('database-review') ? (submittedRes.requests ?? []).length : 0,
        'rework-count': reworkCount,
      });
    })();
    return () => { cancelled = true; };
  }, [userRole]);

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
          isTma ? 'tma-surface border-[color:var(--tma-border)]' : 'border-zinc-100'
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
          if (item.navTabId && navTabVisibility[item.navTabId] === false) return null;
          if (item.requiresTool && visibleTools !== null && !visibleTools.includes(item.requiresTool)) return null;

          const aliases = navActiveAliases[item.href] ?? [];
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname === item.href ||
              pathname.startsWith(`${item.href}/`) ||
              aliases.some((alias) => pathname === alias || pathname.startsWith(`${alias}/`));
          const badgeCount = item.badgeId ? (badges[item.badgeId] ?? 0) : 0;
          return (
            <Link
              key={item.name}
              href={item.href as Route}
              onClick={() => onMobileClose?.()}
              className={`flex items-center rounded-lg px-2.5 py-1.5 text-[11px] truncate transition-all duration-200
                ${isActive
                  ? (isTma ? 'tma-chip-active font-medium' : 'bg-gray-100 text-gray-900 font-medium')
                  : (isTma ? 'tma-nav-item' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900')
                }
              `}
            >
              {item.name}
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
          onClick={() => onMobileClose?.()}
          className={`mb-2 flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition ${
            isTma ? 'hover:bg-[color:var(--tma-surface-2)]' : 'hover:bg-zinc-50'
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
              {userFullName || userEmail?.split('@')[0] || 'User'}
            </p>
            <p className={`text-[10px] mt-0.5 truncate leading-tight ${isTma ? 'tma-muted' : 'text-zinc-500'}`}>
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
              : 'text-zinc-500 hover:bg-zinc-50 hover:text-red-600'
          }`}
        >
          Выйти
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
                <span className="text-base font-bold text-zinc-900">Portal</span>
                <button
                  type="button"
                  onClick={() => onMobileClose?.()}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100"
                  aria-label="Закрыть меню"
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
