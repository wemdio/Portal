'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { supabase } from '@/lib/supabaseClient';
import type { Session } from '@supabase/supabase-js';
import { UserRole } from '@/types';
import { ROLE_LABELS, isAdmin } from '@/lib/roles';
import { navItems } from '@/lib/navigation';

type SidebarProps = {
  collapsed?: boolean;
  isTma?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

const navActiveAliases: Record<string, string[]> = {
  '/tools': ['/parsers'],
};

export function Sidebar({ collapsed = false, isTma = false, mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  async function fetchUserRole(userId: string) {
    const { data } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    return data?.role as UserRole | null;
  }

  useEffect(() => {
    let isMounted = true;

    const applySession = async (session: Session | null) => {
      if (!isMounted) return;

      if (!session) {
        setUserEmail(null);
        setUserRole(null);
        return;
      }

      setUserEmail(session.user.email ?? null);
      const role = await fetchUserRole(session.user.id);
      if (!isMounted) return;
      setUserRole(role);
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
        className={`flex h-12 items-center px-5 border-b flex-shrink-0 safe-top ${
          isTma ? 'border-black/10' : 'border-gray-100'
        }`}
        style={isTma ? { backgroundColor: 'var(--tg-bg-color)', color: 'var(--tg-text-color)' } : undefined}
      >
        <span className="text-base font-bold tracking-tight text-[color:var(--tg-text-color)]">Portal</span>
        {isTma && (
          <button
            type="button"
            onClick={() => onMobileClose?.()}
            className="md:hidden ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--tg-text-color)] hover:bg-black/5"
            aria-label="Закрыть меню"
          >
            ✕
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-4 overflow-y-auto">
        {navItems.map((item) => {
          if (item.adminOnly && !isAdmin(userRole)) return null;

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
              className={`flex items-center rounded-md px-3 py-2 text-sm transition-colors duration-200
                ${isActive
                  ? (isTma
                      ? 'bg-[var(--tg-secondary-bg-color,#f3f4f6)] text-[color:var(--tg-text-color)] font-medium'
                      : 'bg-gray-100 text-gray-900 font-medium')
                  : (isTma
                      ? 'text-[color:var(--tg-text-color)]/80 hover:bg-black/5 hover:text-[color:var(--tg-text-color)]'
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
        className={`p-3 border-t flex-shrink-0 safe-bottom ${isTma ? 'border-black/10' : 'border-gray-100'}`}
        style={isTma ? { backgroundColor: 'var(--tg-bg-color)', color: 'var(--tg-text-color)' } : undefined}
      >
        <div className="mb-3 px-2">
          <p className="text-sm font-medium truncate text-[color:var(--tg-text-color)]" title={userEmail || ''}>
            {userEmail?.split('@')[0] || 'User'}
          </p>
          <p className="text-xs mt-0.5 text-[color:var(--tg-hint-color,#6b7280)]">
            {userRole ? ROLE_LABELS[userRole] : '...'}
          </p>
        </div>
        <button
          onClick={handleSignOut}
          className={`flex w-full items-center rounded-md px-2 py-1.5 text-sm transition-colors ${
            isTma
              ? 'text-[color:var(--tg-destructive-text-color,#dc2626)] hover:bg-black/5'
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
          style={{ width: hovered ? 240 : 12 }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {!hovered && (
            <div className="absolute left-0 top-0 w-3 h-full bg-gradient-to-r from-gray-200/60 to-transparent cursor-pointer" />
          )}
          <div
            className={`absolute left-0 top-0 h-full w-60 bg-white border-r border-gray-200 shadow-2xl flex flex-col text-gray-900
              transition-all duration-200 ease-out
              ${hovered ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 pointer-events-none'}`}
          >
            {sidebarContent}
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-screen w-60 flex-col border-r border-gray-200 bg-white text-gray-900 flex-shrink-0">
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
        } ${isTma ? 'border-black/10 bg-[var(--tg-bg-color)] text-[color:var(--tg-text-color)]' : 'bg-white border-gray-200'}`}
      >
        <div className="flex h-full w-full flex-col">{sidebarContent}</div>
      </div>
    </div>
  );

  return mobileDrawer;
}
