'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, LayoutDashboard, Settings, Users, FolderKanban, ShieldCheck, LogOut, UserCircle, FileText } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { UserRole } from '@/types';
import { ROLE_LABELS, isAdmin } from '@/lib/roles';

const navItems = [
  { name: 'Проекты', href: '/', icon: FolderKanban },
  { name: 'Команда', href: '/team', icon: Users },
  { name: 'Регламент', href: '/reglament', icon: FileText },
  { name: 'Админ', href: '/admin', icon: ShieldCheck, adminOnly: true },
  { name: 'Настройки', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    getUser();
  }, []);

  async function getUser() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      setUserEmail(session.user.email);
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .single();
      
      setUserRole(data?.role as UserRole | null);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  // Hide sidebar on login page
  if (pathname === '/login') return null;

  return (
    <div className="flex h-screen w-64 flex-col border-r bg-gray-900 text-white">
      <div className="flex h-16 items-center px-6">
        <LayoutDashboard className="h-6 w-6 text-blue-400 mr-2" />
        <span className="text-xl font-bold">Portal</span>
      </div>
      <nav className="flex-1 space-y-1 px-2 py-4">
        {navItems.map((item) => {
          if (item.adminOnly && !isAdmin(userRole)) return null;

          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`group flex items-center rounded-md px-2 py-2 text-sm font-medium transition-colors
                ${isActive ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}
              `}
            >
              <item.icon className={`mr-3 h-5 w-5 ${isActive ? 'text-blue-400' : 'text-gray-400 group-hover:text-white'}`} />
              {item.name}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-800">
        <div className="flex items-center mb-4">
          <div className="h-8 w-8 rounded-full bg-blue-600 flex items-center justify-center text-sm font-medium">
            <UserCircle className="h-5 w-5" />
          </div>
          <div className="ml-3 overflow-hidden">
            <p className="text-sm font-medium text-white truncate" title={userEmail || ''}>
              {userEmail?.split('@')[0] || 'User'}
            </p>
            <p className="text-xs text-gray-400">{userRole ? ROLE_LABELS[userRole] : 'Загрузка...'}</p>
          </div>
        </div>
        <button 
          onClick={handleSignOut}
          className="flex w-full items-center rounded-md px-2 py-2 text-sm font-medium text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
        >
          <LogOut className="mr-3 h-5 w-5" />
          Выйти
        </button>
      </div>
    </div>
  );
}
