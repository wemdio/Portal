'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
  { name: 'Админ', href: '/admin', adminOnly: true },
  { name: 'Настройки', href: '/settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

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

  return (
    <div className="flex h-screen w-64 flex-col border-r border-gray-200 bg-white text-gray-900">
      <div className="flex h-16 items-center px-6 border-b border-gray-100">
        <span className="text-lg font-bold tracking-tight">Portal</span>
      </div>
      
      <nav className="flex-1 space-y-0.5 px-3 py-6">
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

      <div className="p-4 border-t border-gray-100">
        <div className="mb-4 px-2">
          <p className="text-sm font-medium text-gray-900 truncate" title={userEmail || ''}>
            {userEmail?.split('@')[0] || 'User'}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{userRole ? ROLE_LABELS[userRole] : '...'}</p>
        </div>
        <button 
          onClick={handleSignOut}
          className="flex w-full items-center rounded-md px-2 py-2 text-sm text-gray-500 hover:bg-gray-50 hover:text-red-600 transition-colors"
        >
          Выйти
        </button>
      </div>
    </div>
  );
}
