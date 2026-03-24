'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { supabase } from '@/lib/supabaseClient';
import { BarChart3, Database, FileText, LogOut } from 'lucide-react';

const clientNav = [
  { name: 'Кампании', href: '/client', icon: BarChart3 },
  { name: 'Базы', href: '/client/bases', icon: Database },
  { name: 'Отчёты', href: '/client/reports', icon: FileText },
] as const;

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const isActive = (href: string) =>
    href === '/client'
      ? pathname === '/client' || pathname.startsWith('/client/campaigns')
      : pathname.startsWith(href);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-40 w-full border-b border-zinc-200/80 bg-white/90 backdrop-blur-md">
        <div className="flex items-center gap-4 px-4 h-12">
          <span className="text-sm font-bold text-zinc-900 tracking-tight mr-4">
            Portal
          </span>

          <nav className="flex-1 flex items-center gap-1">
            {clientNav.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all ${
                    active
                      ? 'bg-zinc-900 text-white shadow-sm'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.name}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={async () => {
              await supabase.auth.signOut();
              router.push('/login' as Route);
              router.refresh();
            }}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-red-500 px-2 py-1 rounded-md hover:bg-zinc-50 transition-colors"
            title="Выйти"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 md:px-8">
        {children}
      </main>
    </div>
  );
}
