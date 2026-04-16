'use client';

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { Session } from '@supabase/supabase-js';
import { UserRole } from '@/types';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { ALL_NAV_TAB_IDS } from '@/lib/toolsRegistry';
import { DEFAULT_LOCALE, type Locale, normalizeLocale } from '@/lib/i18n';

interface UserContextValue {
  userId: string | null;
  userRole: UserRole | null;
  userEmail: string | null;
  userFullName: string | null;
  userAvatarUrl: string | null;
  navTabVisibility: Record<string, boolean>;
  visibleTools: string[] | null;
  badges: Record<string, number>;
  unreadNotifications: number;
  locale: Locale;
  localeSaving: boolean;
  handleAvatarError: () => void;
  handleSignOut: () => Promise<void>;
  setLocale: (nextLocale: Locale) => Promise<void>;
  refreshNotifications: () => void;
}

const UserContext = createContext<UserContextValue | null>(null);

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
}

export function UserProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userFullName, setUserFullName] = useState<string | null>(null);
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [avatarTriedSigned, setAvatarTriedSigned] = useState(false);
  const [navTabVisibility, setNavTabVisibility] = useState<Record<string, boolean>>({});
  const [visibleTools, setVisibleTools] = useState<string[] | null>(null);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [locale, setLocaleState] = useState<Locale>(normalizeLocale(initialLocale));
  const [localeSaving, setLocaleSaving] = useState(false);
  const localeHydratedRef = useRef(false);
  const localeUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const applySession = async (session: Session | null) => {
      if (!isMounted) return;
      if (!session) {
        setUserId(null);
        setUserEmail(null);
        setUserRole(null);
        setUserFullName(null);
        setUserAvatarUrl(null);
        setNavTabVisibility({});
        setVisibleTools(null);
        setBadges({});
        setLocaleState(normalizeLocale(initialLocale));
        localeHydratedRef.current = false;
        localeUserIdRef.current = null;
        return;
      }

      try {
        setUserId(session.user.id);
        setUserEmail(session.user.email ?? null);

        const [profile, navRows] = await Promise.all([
          supabase
            .from('profiles')
            .select('role, full_name, avatar_url, locale')
            .eq('id', session.user.id)
            .single()
            .then(({ data }) => ({
              role: (data?.role as UserRole | null) ?? null,
              full_name: typeof data?.full_name === 'string' ? data.full_name : null,
              avatar_url: typeof data?.avatar_url === 'string' ? data.avatar_url : null,
              locale: normalizeLocale(data?.locale),
            })),
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
        const isSameUser = localeUserIdRef.current === session.user.id;
        if (!localeHydratedRef.current || !isSameUser) {
          setLocaleState(profile.locale);
          localeHydratedRef.current = true;
          localeUserIdRef.current = session.user.id;
        }

        const vis: Record<string, boolean> = {};
        for (const id of ALL_NAV_TAB_IDS) {
          const row = navRows?.find((r) => r.tool_id === id);
          vis[id] = row?.enabled ?? false;
        }
        setNavTabVisibility(vis);
      } catch (err) {
        // If Supabase tables/RLS are misconfigured, we must not crash the whole app.
        // Degrade gracefully: keep the user logged in, but hide gated tabs/values.
        console.error('[UserProvider] Failed to load user session data:', err);
        if (!isMounted) return;
        setUserRole(null);
        setUserFullName(null);
        setUserAvatarUrl(null);
        setNavTabVisibility({});
        setVisibleTools(null);
        setBadges({});
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      void applySession(session);
    });

    return () => {
      isMounted = false;
      subscription?.unsubscribe();
    };
  }, [initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (!userEmail) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token || cancelled) return;
        const headers = { Authorization: `Bearer ${token}` };

        const [toolsRes, submittedRes, reworkRes, notifRes] = await Promise.all([
          fetch('/api/user/tools', { headers }).then((r) => r.json()).catch(() => ({ toolIds: [] })),
          fetch('/api/database-review/requests?status=submitted', { headers }).then((r) => r.json()).catch(() => ({ requests: [] })),
          fetch('/api/database-review/requests', { headers }).then((r) => r.json()).catch(() => ({ requests: [] })),
          fetch('/api/notifications', { headers }).then((r) => r.json()).catch(() => ({ unread_count: 0 })),
        ]);
        if (cancelled) return;
        const tools = (toolsRes.toolIds ?? []) as string[];
        setVisibleTools(tools);
        setUnreadNotifications(notifRes.unread_count ?? 0);
        const reworkStatuses = new Set(['needs_rework', 'client_requested_changes']);
        const reworkCount = ((reworkRes.requests ?? []) as Array<{ status: string }>).filter(
          (r) => reworkStatuses.has(r.status),
        ).length;
        setBadges({
          'review-count': tools.includes('database-review') ? (submittedRes.requests ?? []).length : 0,
          'rework-count': reworkCount,
        });
      } catch (err) {
        console.error('[UserProvider] Failed to load user tools/badges:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [userEmail]);

  const handleAvatarError = useCallback(() => {
    if (avatarTriedSigned) {
      setUserAvatarUrl(null);
      return;
    }
    setAvatarTriedSigned(true);
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setUserAvatarUrl(null); return; }
      const res = await fetch('/api/profile/avatar/signed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { setUserAvatarUrl(null); return; }
      const data = (await res.json()) as { readUrl?: unknown };
      if (typeof data.readUrl === 'string' && data.readUrl.trim()) {
        setUserAvatarUrl(data.readUrl.trim());
      } else {
        setUserAvatarUrl(null);
      }
    })();
  }, [avatarTriedSigned]);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const refreshNotifications = useCallback(() => {
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const res = await fetch('/api/notifications', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        setUnreadNotifications(data.unread_count ?? 0);
      } catch { /* ignore */ }
    })();
  }, []);

  const setLocale = useCallback(async (nextLocale: Locale) => {
    const normalized = normalizeLocale(nextLocale);
    setLocaleState(normalized);
    localeHydratedRef.current = true;
    localeUserIdRef.current = userId;
    setLocaleSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      await fetch('/api/user/locale', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ locale: normalized }),
      });
    } catch (error) {
      console.error('[UserProvider] Failed to persist locale:', error);
    } finally {
      setLocaleSaving(false);
    }
  }, [userId]);

  const value = useMemo<UserContextValue>(() => ({
    userId,
    userRole,
    userEmail,
    userFullName,
    userAvatarUrl,
    navTabVisibility,
    visibleTools,
    badges,
    unreadNotifications,
    locale,
    localeSaving,
    handleAvatarError,
    handleSignOut,
    setLocale,
    refreshNotifications,
  }), [userId, userRole, userEmail, userFullName, userAvatarUrl, navTabVisibility, visibleTools, badges, unreadNotifications, locale, localeSaving, handleAvatarError, handleSignOut, setLocale, refreshNotifications]);

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
