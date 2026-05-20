'use client';

import { useEffect, useState, useCallback } from 'react';
import { useUser } from '@/lib/UserProvider';
import { commonDictionary, dict, toIntlLocale, type Locale } from '@/lib/i18n';
import { supabase } from '@/lib/supabaseClient';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: string;
}

const TYPE_CONFIG: Record<string, { icon: string; color: string; bg: string }> = {
  deadline: { icon: '⏰', color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200' },
  deadline_lead: { icon: '🔔', color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200' },
  deadline_ceo: { icon: '🚨', color: 'text-red-600', bg: 'bg-red-50 border-red-200' },
  lead_new: { icon: '🎯', color: 'text-green-600', bg: 'bg-green-50 border-green-200' },
  lead_escalation: { icon: '📢', color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200' },
  lead_ceo: { icon: '🚨', color: 'text-red-600', bg: 'bg-red-50 border-red-200' },
  info: { icon: 'ℹ️', color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
};

// Default branch returns Russian so the runtime DOM translator can pick it up
// for non-EN locales (de/fr/es/it). English is the explicit alternative.
// `toIntlLocale` maps every supported Locale to a proper BCP-47 tag for the
// fallback Date formatting below.
function formatRelativeTime(dateStr: string, locale: Locale): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return locale === 'en' ? 'just now' : 'только что';
  if (diffMin < 60) return locale === 'en' ? `${diffMin}m ago` : `${diffMin} мин назад`;
  if (diffHours < 24) return locale === 'en' ? `${diffHours}h ago` : `${diffHours} ч назад`;
  if (diffDays < 7) return locale === 'en' ? `${diffDays}d ago` : `${diffDays} дн назад`;
  return new Date(dateStr).toLocaleDateString(toIntlLocale(locale), {
    day: 'numeric',
    month: 'short',
  });
}

function typeLabel(type: string, locale: Locale): string {
  switch (type) {
    case 'deadline': return locale === 'en' ? 'Deadline approaching' : 'Дедлайн приближается';
    case 'deadline_lead': return locale === 'en' ? 'Deadline reached' : 'Дедлайн наступил';
    case 'deadline_ceo': return locale === 'en' ? 'Deadline overdue' : 'Дедлайн просрочен';
    case 'lead_new': return locale === 'en' ? 'New lead' : 'Новый лид';
    case 'lead_escalation': return locale === 'en' ? 'Lead unhandled' : 'Лид не обработан';
    case 'lead_ceo': return locale === 'en' ? 'Lead overdue' : 'Лид просрочен';
    default: return locale === 'en' ? 'Info' : 'Информация';
  }
}

export default function NotificationsPage() {
  const { locale, refreshNotifications } = useUser();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      const res = await fetch('/api/notifications', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setNotifications(data.notifications ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const markAllRead = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      refreshNotifications();
    } catch { /* ignore */ }
  };

  const markOneRead = async (id: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
      refreshNotifications();
    } catch { /* ignore */ }
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div className="max-w-3xl mx-auto space-y-6 text-left">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">
          {dict(commonDictionary.notifications, locale)}
          {unreadCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-xs font-bold rounded-full bg-red-500 text-white align-middle">
              {unreadCount}
            </span>
          )}
        </h1>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
          >
            {locale === 'ru' ? 'Прочитать все' : 'Mark all read'}
          </button>
        )}
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center justify-center px-6 py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 mb-4">
              <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="#9ca3af" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5.333a4 4 0 1 0-8 0c0 4.667-2 6-2 6h12s-2-1.333-2-6Z" />
                <path d="M9.153 13.333a1.333 1.333 0 0 1-2.306 0" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-700">
              {dict(commonDictionary.noNotifications, locale)}
            </p>
            <p className="mt-1 text-xs text-gray-400 max-w-xs">
              {dict(commonDictionary.noNotificationsHint, locale)}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {notifications.map((n) => {
              const cfg = TYPE_CONFIG[n.type] ?? TYPE_CONFIG.info;
              return (
                <li
                  key={n.id}
                  className={`flex items-start gap-3 px-5 py-4 transition-colors ${
                    n.is_read ? 'bg-white' : 'bg-blue-50/40'
                  }`}
                >
                  <div className={`flex-shrink-0 mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border text-base ${cfg.bg}`}>
                    {cfg.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-semibold uppercase tracking-wide ${cfg.color}`}>
                        {typeLabel(n.type, locale)}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {formatRelativeTime(n.created_at, locale)}
                      </span>
                      {!n.is_read && (
                        <span className="h-2 w-2 rounded-full bg-blue-500 flex-shrink-0" />
                      )}
                    </div>
                    <p className="text-sm font-medium text-gray-900 mt-0.5">{n.title}</p>
                    {n.body && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                  </div>
                  {!n.is_read && (
                    <button
                      type="button"
                      onClick={() => markOneRead(n.id)}
                      className="flex-shrink-0 mt-1 text-[10px] text-gray-400 hover:text-blue-600 transition-colors"
                      title={locale === 'ru' ? 'Прочитано' : 'Mark read'}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13.333 4L6 11.333 2.667 8" />
                      </svg>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
