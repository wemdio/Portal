'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { navItems } from '@/lib/navigation';
import { getCurrentUserRole, isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';

export function TmaHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [role, setRole] = useState<UserRole | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [avatarTriedSigned, setAvatarTriedSigned] = useState(false);

  const handleSignOut = () => {
    void (async () => {
      await supabase.auth.signOut();
      router.push('/login' as Route);
      router.refresh();
    })();
  };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const nextRole = await getCurrentUserRole();
      if (mounted) setRole(nextRole);

      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      if (!mounted) return;
      if (!user) {
        setUserName(null);
        setUserAvatarUrl(null);
        return;
      }

      const fallbackName = (user.email ?? '').split('@')[0] || 'User';
      const { data } = await supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('id', user.id)
        .single();

      if (!mounted) return;
      setUserName((typeof data?.full_name === 'string' && data.full_name.trim()) ? data.full_name : fallbackName);
      setUserAvatarUrl(normalizePublicAvatarUrl(typeof data?.avatar_url === 'string' ? data.avatar_url : null));
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
      <div className="flex items-start gap-3 px-4 pb-2 tma-safe-top">
        <div className="min-w-0 flex-1">
          <p className="tma-muted text-[11px] uppercase tracking-wide">
            Portal
          </p>
          <h1 className="tma-text truncate text-lg font-semibold">
            {activeItem?.name ?? 'Portal'}
          </h1>
        </div>
        <Link
          href={'/profile' as Route}
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition tma-chip"
          aria-label="Открыть профиль"
        >
          {userAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={userAvatarUrl}
              alt=""
              className="h-6 w-6 rounded-full object-cover ring-1 ring-black/5"
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
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/10 text-[11px] font-bold"
              aria-hidden="true"
            >
              {(userName ?? 'U').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="max-w-[10ch] truncate">{userName ?? 'Профиль'}</span>
        </Link>
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
          <button
            type="button"
            onClick={handleSignOut}
            className="whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition tma-chip-danger"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  );
}
