'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { DigestBody } from '@/components/changelog/DigestBody';

/**
 * Карточка уведомления.
 *
 * В списке у уведомления две строки текста с обрезкой, и прочитать его целиком
 * было негде: клик по строке ничего не делал, а длинное уведомление — например
 * сводка обновлений портала — обрывалось на середине фразы.
 *
 * Сводка обновлений открывается своим телом, с разделами и свёрнутым
 * техническим блоком: в самом уведомлении лежит только первая строка, полный
 * текст тянется по её идентификатору.
 */

export interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  created_at: string;
  is_read: boolean;
  changelog_digest_id?: number | null;
}

export function NotificationModal({
  notification,
  onClose,
  onRead,
}: {
  notification: NotificationItem;
  onClose: () => void;
  /** Отметить прочитанным — список обновляет строку у себя. */
  onRead: (id: string) => void | Promise<void>;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(notification.changelog_digest_id));
  const [busy, setBusy] = useState(false);

  const digestId = notification.changelog_digest_id ?? null;
  const load = useCallback(async () => {
    if (!digestId) return;
    try {
      const res = await authFetch(`/api/changelog/${digestId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { summary?: string; period?: string | null };
      setSummary(data.summary ?? null);
      setPeriod(data.period ?? null);
    } catch {
      /* не доехало — покажем короткий текст уведомления */
    } finally {
      setLoading(false);
    }
  }, [digestId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const confirm = async () => {
    setBusy(true);
    try {
      await onRead(notification.id);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={notification.title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{notification.title}</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {/* У сводки обновлений важна не минута создания записи, а окно,
                  за которое она собрана: сутки от девяти утра до девяти утра. */}
              {period ?? new Date(notification.created_at).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаю…
            </div>
          ) : summary ? (
            <DigestBody summary={summary} />
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700">
              {notification.body || 'Без подробностей.'}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3">
          {notification.is_read ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100"
            >
              Закрыть
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Всё понятно
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
