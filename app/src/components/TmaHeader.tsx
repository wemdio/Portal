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
    <div
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{ borderColor: 'var(--tma-border)', backgroundColor: 'var(--tma-bg)' }}
    >
      <div className="flex items-start gap-3 px-4 pt-3 pb-2 safe-top">
        <button
          type="button"
          onClick={onMenuClick}
          className="mt-0.5 inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border transition-colors"
          style={{
            borderColor: 'var(--tma-border)',
            backgroundColor: 'var(--tma-surface-2)',
            color: 'var(--tma-fg)',
          }}
          aria-label="Открыть меню"
        >
          <span className="text-lg leading-none">☰</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="tma-muted text-[11px] uppercase tracking-wide">
            Portal
          </p>
          <h1 className="tma-text truncate text-lg font-semibold">
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
                  isActive ? 'tma-chip-active' : 'tma-chip'
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
