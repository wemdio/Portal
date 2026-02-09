'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import type { Session } from '@supabase/supabase-js';
import { UserRole } from '@/types';
import { ROLE_LABELS, isAdmin } from '@/lib/roles';

const navItems = [
  { name: 'Проекты', href: '/' },
  { name: 'Аналитика проектов', href: '/analytics/projects' },
  { name: 'Задачи', href: '/tasks' },
  { name: 'Команда', href: '/team' },
  { name: 'Финансы', href: '/finance' },
  { name: 'Инструменты', href: '/tools' },
  { name: 'Оплаты', href: '/payments' },
  { name: 'Регламент', href: '/reglament' },
  { name: 'Парсеры', href: '/parsers', icon: Search },
  { name: 'Админ', href: '/admin', adminOnly: true },
  { name: 'Настройки', href: '/settings' },
];

type SidebarProps = {
  collapsed?: boolean;
};

export function Sidebar({ collapsed = false }: SidebarProps) {
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
    router.push('/login');
    router.refresh();
  }

  // Hide sidebar on login page
  if (pathname === '/login') return null;

  const sidebarContent = (
    <>
      <div className="flex h-12 items-center px-5 border-b border-gray-100 flex-shrink-0">
        <span className="text-base font-bold tracking-tight">Portal</span>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-4 overflow-y-auto">
        {navItems.map((item) => {
          if (item.adminOnly && !isAdmin(userRole)) return null;

          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center rounded-md px-3 py-2 text-sm transition-colors duration-200
                ${isActive
                  ? 'bg-gray-100 text-gray-900 font-medium'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }
              `}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-gray-100 flex-shrink-0">
        <div className="mb-3 px-2">
          <p className="text-sm font-medium text-gray-900 truncate" title={userEmail || ''}>
            {userEmail?.split('@')[0] || 'User'}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{userRole ? ROLE_LABELS[userRole] : '...'}</p>
        </div>
        <button
          onClick={handleSignOut}
          className="flex w-full items-center rounded-md px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-50 hover:text-red-600 transition-colors"
        >
          Выйти
        </button>
      </div>
    </>
  );

  // Collapsed mode: hidden sidebar that appears on hover
  if (collapsed) {
    return (
      <div
        className="fixed left-0 top-0 h-screen z-50"
        style={{ width: hovered ? 240 : 12 }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Thin hover trigger strip */}
        {!hovered && (
          <div className="absolute left-0 top-0 w-3 h-full bg-gradient-to-r from-gray-200/60 to-transparent cursor-pointer" />
        )}
        {/* Sidebar overlay */}
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

  // Normal sidebar
  return (
    <div className="flex h-screen w-60 flex-col border-r border-gray-200 bg-white text-gray-900 flex-shrink-0">
      {sidebarContent}
    </div>
  );
}
