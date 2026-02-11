'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { navItems } from '@/lib/navigation';
import { getCurrentUserRole, isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

type TmaHeaderProps = {
  onMenuClick?: () => void;
};

export function TmaHeader({ onMenuClick }: TmaHeaderProps) {
  const pathname = usePathname();
  const [role, setRole] = useState<UserRole | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const nextRole = await getCurrentUserRole();
      if (mounted) setRole(nextRole);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const items = useMemo(() => {
    return navItems.filter((item) => !item.adminOnly || isAdmin(role));
  }, [role]);

  const activeItem = useMemo(() => {
    const exact = items.find((item) => item.href === pathname);
    if (exact) return exact;
    return items.find((item) => item.href !== '/' && pathname.startsWith(`${item.href}/`)) ?? items[0];
  }, [items, pathname]);

  if (pathname === '/login') return null;

  return (
    <div className="sticky top-0 z-40 border-b border-black/10 bg-[var(--tg-bg-color)]/95 backdrop-blur">
      <div className="flex items-start gap-3 px-4 pt-3 pb-2 safe-top">
        <button
          type="button"
          onClick={onMenuClick}
          className="mt-0.5 inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--tg-secondary-bg-color,var(--tg-bg-color))] text-[color:var(--tg-text-color)]"
          aria-label="Открыть меню"
        >
          <span className="text-lg leading-none">☰</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wide text-[color:var(--tg-hint-color,var(--tg-text-color))] opacity-80">
            Portal
          </p>
          <h1 className="truncate text-lg font-semibold text-[color:var(--tg-text-color)]">
            {activeItem?.name ?? 'Portal'}
          </h1>
        </div>
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          {items.map((item) => {
            const isActive = item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.name}
                href={item.href as Route}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition ${
                  isActive
                    ? 'bg-[var(--tg-button-color,var(--tg-text-color))] text-[color:var(--tg-button-text-color,var(--tg-bg-color))]'
                    : 'bg-[var(--tg-secondary-bg-color,#f3f4f6)] text-[color:var(--tg-text-color)]'
                }`}
              >
                {item.name}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
