'use client';

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import type { Session } from '@supabase/supabase-js';
import { UserRole } from '@/types';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { ALL_NAV_TAB_IDS } from '@/lib/toolsRegistry';
import { DEFAULT_LOCALE, type Locale, normalizeLocale } from '@/lib/i18n';

interface UserContextValue {
  userId: string | null;
  userRole: UserRole | null;
  isHr: boolean;
  canAccessTeamPrivate: boolean;
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
  const [isHr, setIsHr] = useState(false);
  const [canAccessTeamPrivate, setCanAccessTeamPrivate] = useState(false);
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
  const sessionRequestSequenceRef = useRef(0);
  const sessionUserIdRef = useRef<string | null>(null);
  const teamCapabilityRequestSequenceRef = useRef(0);

  useEffect(() => {
    let isMounted = true;

    const refreshTeamPrivateAccess = async (
      expectedUserId: string,
      expectedSessionRequestId: number,
    ) => {
      if (
        !isMounted
        || sessionUserIdRef.current !== expectedUserId
        || sessionRequestSequenceRef.current !== expectedSessionRequestId
      ) return;

      const capabilityRequestId = ++teamCapabilityRequestSequenceRef.current;

      const isCurrentCapabilityRequest = () => (
        isMounted
        && capabilityRequestId === teamCapabilityRequestSequenceRef.current
        && sessionUserIdRef.current === expectedUserId
        && sessionRequestSequenceRef.current === expectedSessionRequestId
      );

      try {
        const { data, error } = await supabase.rpc('can_access_team');
        if (error) throw error;
        if (isCurrentCapabilityRequest()) setCanAccessTeamPrivate(data === true);
      } catch (error) {
        if (!isCurrentCapabilityRequest()) return;
        console.error('[UserProvider] Failed to load private Team capability:', error);
        setCanAccessTeamPrivate(false);
      }
    };

    const applySession = async (session: Session | null) => {
      const requestId = ++sessionRequestSequenceRef.current;
      if (!isMounted) return;
      if (!session) {
        ++teamCapabilityRequestSequenceRef.current;
        sessionUserIdRef.current = null;
        setUserId(null);
        setUserEmail(null);
        setUserRole(null);
        setIsHr(false);
        setCanAccessTeamPrivate(false);
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

      const sessionUserId = session.user.id;
      const isCurrentSession = () => (
        isMounted
        && requestId === sessionRequestSequenceRef.current
        && sessionUserIdRef.current === sessionUserId
      );
      const userChanged = sessionUserIdRef.current !== sessionUserId;
      sessionUserIdRef.current = sessionUserId;
      setUserId(sessionUserId);
      setUserEmail(session.user.email ?? null);
      if (userChanged) {
        ++teamCapabilityRequestSequenceRef.current;
        setIsHr(false);
        setCanAccessTeamPrivate(false);
      }

      try {
        const [profile, navRows] = await Promise.all([
          supabase
            .from('profiles')
            .select('role, full_name, avatar_url, locale')
            .eq('id', sessionUserId)
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
            .eq('user_id', sessionUserId)
            .in('tool_id', ALL_NAV_TAB_IDS as unknown as string[])
            .then(({ data }) => data),
        ]);

        if (!isCurrentSession()) return;
        setUserRole(profile.role);
        setUserFullName(profile.full_name);
        setUserAvatarUrl(normalizePublicAvatarUrl(profile.avatar_url));
        const isSameUser = localeUserIdRef.current === sessionUserId;
        if (!localeHydratedRef.current || !isSameUser) {
          setLocaleState(profile.locale);
          localeHydratedRef.current = true;
          localeUserIdRef.current = sessionUserId;
        }

        const vis: Record<string, boolean> = {};
        for (const id of ALL_NAV_TAB_IDS) {
          const row = navRows?.find((r) => r.tool_id === id);
          vis[id] = row?.enabled ?? false;
        }
        setNavTabVisibility(vis);

        void (async () => {
          try {
            const { data, error } = await supabase
              .from('profiles')
              .select('is_hr')
              .eq('id', sessionUserId)
              .single();
            if (error) throw error;
            if (isCurrentSession()) setIsHr(data?.is_hr === true);
          } catch (error) {
            console.error('[UserProvider] Failed to load HR capability:', error);
            if (isCurrentSession()) setIsHr(false);
          }
        })();

        void refreshTeamPrivateAccess(sessionUserId, requestId);
      } catch (err) {
        // If Supabase tables/RLS are misconfigured, we must not crash the whole app.
        // Degrade gracefully: keep the user logged in, but hide gated tabs/values.
        console.error('[UserProvider] Failed to load user session data:', err);
        if (!isCurrentSession()) return;
        setUserRole(null);
        setIsHr(false);
        setCanAccessTeamPrivate(false);
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

    const refreshCurrentTeamPrivateAccess = () => {
      const currentUserId = sessionUserIdRef.current;
      if (!currentUserId) {
        ++teamCapabilityRequestSequenceRef.current;
        setCanAccessTeamPrivate(false);
        return;
      }
      void refreshTeamPrivateAccess(currentUserId, sessionRequestSequenceRef.current);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshCurrentTeamPrivateAccess();
    };

    window.addEventListener('focus', refreshCurrentTeamPrivateAccess);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      window.removeEventListener('focus', refreshCurrentTeamPrivateAccess);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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
        const [toolsRes, submittedRes, reworkRes, notifRes] = await Promise.all([
          authFetch('/api/user/tools').then((r) => r.json()).catch(() => ({ toolIds: [] })),
          authFetch('/api/database-review/requests?status=submitted').then((r) => r.json()).catch(() => ({ requests: [] })),
          authFetch('/api/database-review/requests').then((r) => r.json()).catch(() => ({ requests: [] })),
          authFetch('/api/notifications').then((r) => r.json()).catch(() => ({ unread_count: 0 })),
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
      const res = await authFetch('/api/profile/avatar/signed', {
        method: 'POST',
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
        const res = await authFetch('/api/notifications');
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
      await authFetch('/api/user/locale', {
        method: 'PUT',
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
    isHr,
    canAccessTeamPrivate,
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
  }), [userId, userRole, isHr, canAccessTeamPrivate, userEmail, userFullName, userAvatarUrl, navTabVisibility, visibleTools, badges, unreadNotifications, locale, localeSaving, handleAvatarError, handleSignOut, setLocale, refreshNotifications]);

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
