'use client';

/**
 * Admin-side support inbox at /support.
 *
 * Visible to roles in ('admin', 'technician'). Two-pane layout: thread list
 * on the left, message stream + reply input on the right. Realtime updates
 * via Supabase Channels (same pattern as AdminTracesPanel.tsx).
 *
 * Notifications: opening a thread (or POSTing a reply) marks the calling
 * manager's `support_message` notifications for that thread as read. The
 * global bell counter reflects the change after refreshNotifications().
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Send, Loader2, AlertCircle, MessageSquare } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch, authFetchJson } from '@/lib/authFetch';
import { useUser } from '@/lib/UserProvider';
import {
  SUPPORT_MESSAGE_MAX_LEN,
  validateMessageBody,
  type SupportMessageRow,
  type SupportThreadRow,
} from '@/lib/clientSupport/types';

interface ThreadListItem extends SupportThreadRow {
  client_full_name: string | null;
  client_email: string | null;
  client_avatar_url: string | null;
  unread_count: number;
}

interface ThreadsResponse {
  threads: ThreadListItem[];
  total_unread: number;
}

interface ThreadDetailResponse {
  thread: SupportThreadRow;
  messages: SupportMessageRow[];
  client: {
    id: string;
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clientLabel(input: ThreadListItem | ThreadDetailResponse['client']): string {
  if (!input) return 'клиент';
  const fullName = (
    'client_full_name' in input ? input.client_full_name : input.full_name
  ) ?? '';
  if (fullName.trim()) return fullName.trim();
  const email = ('client_email' in input ? input.client_email : input.email) ?? '';
  if (email.trim()) return email.trim();
  return 'клиент';
}

export default function AdminSupportPage() {
  const { refreshNotifications, locale } = useUser();
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement | null>(null);

  const fetchThreads = useCallback(async () => {
    try {
      const data = await authFetchJson<ThreadsResponse>('/api/admin/support/threads');
      setThreads(data.threads);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Не удалось загрузить треды');
    } finally {
      setLoadingList(false);
    }
  }, []);

  const fetchDetail = useCallback(async (threadId: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const data = await authFetchJson<ThreadDetailResponse>(
        `/api/admin/support/threads/${threadId}/messages`,
      );
      setDetail(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Не удалось загрузить тред');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void fetchThreads();
  }, [fetchThreads]);

  // Auto-select the first (most recent) thread once the list loads.
  useEffect(() => {
    if (selectedId !== null) return;
    if (threads.length === 0) return;
    setSelectedId(threads[0].id);
  }, [threads, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    void fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  // Side effect of opening a thread: clear unread badge for that row + refresh
  // the global bell counter. The GET on the messages endpoint already does the
  // server-side mark-read, so we mirror locally to feel instant.
  useEffect(() => {
    if (!selectedId) return;
    setThreads((prev) =>
      prev.map((t) => (t.id === selectedId ? { ...t, unread_count: 0 } : t)),
    );
    refreshNotifications();
  }, [selectedId, refreshNotifications]);

  // Realtime: receive new messages across ALL threads. We update the list
  // (move thread to top, refresh preview) and append to the open thread if
  // it's the one being focused.
  useEffect(() => {
    const channel = supabase
      .channel('admin_support_messages_global')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'client_support_messages',
        },
        (payload) => {
          const msg = payload.new as SupportMessageRow;
          // Update detail pane if open thread matches.
          setDetail((prev) => {
            if (!prev || prev.thread.id !== msg.thread_id) return prev;
            if (prev.messages.some((m) => m.id === msg.id)) return prev;
            return { ...prev, messages: [...prev.messages, msg] };
          });
          // Update list-side aggregates. We don't know the manager's unread
          // count delta from this payload alone (the notifications row insert
          // happens on the server) — refresh the list to pull authoritative
          // counts.
          void fetchThreads();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchThreads]);

  // Auto-scroll detail to latest on message append.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [detail?.messages.length]);

  const validation = useMemo(() => validateMessageBody(draft), [draft]);
  const canSend = !sending && validation.ok && !!detail;

  const handleSend = useCallback(async () => {
    if (!validation.ok || sending || !detail) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await authFetch(
        `/api/admin/support/threads/${detail.thread.id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ body: validation.body }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? 'Не удалось отправить сообщение');
      }
      const json = (await res.json()) as { message: SupportMessageRow };
      setDetail((prev) => {
        if (!prev) return prev;
        if (prev.messages.some((m) => m.id === json.message.id)) return prev;
        return { ...prev, messages: [...prev.messages, json.message] };
      });
      setDraft('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Не удалось отправить сообщение');
    } finally {
      setSending(false);
    }
  }, [validation, sending, detail]);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <header className="mb-4 sm:mb-6">
        <div className="flex items-center gap-2 mb-1.5">
          <MessageSquare className="h-5 w-5 text-gray-700" />
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            {locale === 'en' ? 'Client support' : 'Чаты клиентов'}
          </h1>
        </div>
        <p className="text-xs sm:text-sm text-gray-500">
          {locale === 'en'
            ? 'Direct messages from clients. Realtime — replies are seen instantly on both sides.'
            : 'Сообщения от клиентов из портала. Реалтайм — ответ виден сразу с обеих сторон.'}
        </p>
      </header>

      {listError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 mb-3 text-xs text-red-700 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{listError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3 sm:gap-4">
        {/* Thread list */}
        <aside className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {locale === 'en' ? 'Conversations' : 'Диалоги'} · {threads.length}
          </div>
          <div className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
            {loadingList ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
              </div>
            ) : threads.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-gray-500">
                {locale === 'en' ? 'No client conversations yet' : 'Пока нет ни одного диалога'}
              </div>
            ) : (
              threads.map((t) => {
                const active = t.id === selectedId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className={`w-full text-left px-3 py-3 hover:bg-gray-50 transition-colors ${
                      active ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-[11px] font-bold text-gray-700 shrink-0">
                        {clientLabel(t).slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p
                            className={`text-sm truncate ${
                              t.unread_count > 0 ? 'font-bold text-gray-900' : 'font-medium text-gray-800'
                            }`}
                          >
                            {clientLabel(t)}
                          </p>
                          {t.unread_count > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold">
                              {t.unread_count}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-gray-400 shrink-0">
                            {formatTime(t.last_message_at)}
                          </span>
                        </div>
                        <p
                          className={`mt-0.5 text-xs truncate ${
                            t.unread_count > 0 ? 'text-gray-700' : 'text-gray-500'
                          }`}
                        >
                          {t.last_message_role === 'manager' && (
                            <span className="text-gray-400">→ </span>
                          )}
                          {t.last_message_preview ??
                            (locale === 'en' ? '(empty)' : '(пусто)')}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Detail */}
        <section className="rounded-2xl border border-gray-200 bg-white flex flex-col" style={{ minHeight: '70vh' }}>
          {!selectedId ? (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500 py-12">
              {locale === 'en'
                ? 'Pick a conversation on the left'
                : 'Выберите диалог слева'}
            </div>
          ) : loadingDetail && !detail ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
            </div>
          ) : detailError ? (
            <div className="flex-1 flex items-center justify-center py-12 text-xs text-red-600">
              {detailError}
            </div>
          ) : detail ? (
            <>
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-[12px] font-bold text-gray-700 shrink-0">
                  {clientLabel(detail.client).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {clientLabel(detail.client)}
                  </p>
                  <p className="text-[11px] text-gray-500 truncate">
                    {detail.client?.email ?? ''}
                  </p>
                </div>
                {detail.client?.id && (
                  <Link
                    href={`/profile?userId=${detail.client.id}` as Route}
                    className="text-[11px] font-medium text-blue-600 hover:text-blue-800"
                  >
                    {locale === 'en' ? 'Profile' : 'Профиль'}
                  </Link>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
                {detail.messages.length === 0 ? (
                  <div className="text-center text-xs text-gray-400 py-12">
                    {locale === 'en' ? 'No messages yet' : 'Сообщений пока нет'}
                  </div>
                ) : (
                  detail.messages.map((m) => <MessageBubble key={m.id} message={m} />)
                )}
                <div ref={listEndRef} />
              </div>

              <div className="border-t border-gray-100 p-3">
                {sendError && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-red-600">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{sendError}</span>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder={
                      locale === 'en'
                        ? 'Reply to client… (Ctrl/⌘ + Enter)'
                        : 'Ответ клиенту… (Ctrl/⌘ + Enter)'
                    }
                    rows={2}
                    maxLength={SUPPORT_MESSAGE_MAX_LEN}
                    className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:ring-1 focus:ring-blue-200 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => void handleSend()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    <span className="hidden sm:inline">
                      {locale === 'en' ? 'Send' : 'Отправить'}
                    </span>
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: SupportMessageRow }) {
  const fromManager = message.sender_role === 'manager';
  return (
    <div className={`flex ${fromManager ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
          fromManager
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-900'
        }`}
      >
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.body}
        </div>
        <div
          className={`text-[10px] font-semibold mt-1 ${
            fromManager ? 'text-blue-100' : 'text-gray-500'
          }`}
        >
          {fromManager ? 'Вы (менеджер)' : 'Клиент'} · {formatTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}
