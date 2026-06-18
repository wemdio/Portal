'use client';

/**
 * Client-side support chat page (/client/support).
 *
 * Replaces the legacy mailto:hello@polza.com fallback that lived in the
 * empty-state buttons of /client/projects and /client/launch. Each client
 * has exactly one persistent thread, lazily created on first GET.
 *
 * Realtime: subscribes to INSERT events on `client_support_messages`
 * filtered by the thread's id, so a manager's reply lands in the UI
 * without polling. Optimistic local append on submit gets reconciled when
 * the realtime payload arrives (we de-duplicate by message id).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Loader2, MessageSquare } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { clientApiFetch } from '@/lib/clientFetcher';
import {
  SUPPORT_MESSAGE_MAX_LEN,
  validateMessageBody,
  type SupportMessageRow,
  type SupportThreadRow,
} from '@/lib/clientSupport/types';

interface ThreadResponse {
  thread: SupportThreadRow;
  messages: SupportMessageRow[];
}

interface SendResponse {
  message: SupportMessageRow;
  thread_id: string;
}

function formatTime(iso: string): string {
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

export default function ClientSupportPage() {
  const [thread, setThread] = useState<SupportThreadRow | null>(null);
  const [messages, setMessages] = useState<SupportMessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshThread = useCallback(async () => {
    try {
      const data = await clientApiFetch<ThreadResponse>('/support/thread');
      setThread(data.thread);
      setMessages(data.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить чат');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshThread();
  }, [refreshThread]);

  // Realtime: append new messages as managers reply. We dedupe by id because
  // our optimistic local append for the client's own outbound messages will
  // race with the realtime echo of the same row.
  useEffect(() => {
    const threadId = thread?.id;
    if (!threadId) return undefined;

    const channel = supabase
      .channel(`client_support_messages:${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'client_support_messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const next = payload.new as SupportMessageRow;
          setMessages((prev) => {
            if (prev.some((m) => m.id === next.id)) return prev;
            return [...prev, next];
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [thread?.id]);

  // Фоновый опрос открытого треда. Realtime на проде сейчас недоступен
  // (восстанавливается отдельной задачей), поэтому пока тред открыт и вкладка
  // видима — подтягиваем новые сообщения каждые ~10с. Тихий (не трогает
  // error/loading), а GET заодно помечает уведомления прочитанными → бейдж
  // гаснет. Когда realtime починят, подписка выше сделает это мгновенно, а опрос
  // останется необязательным backstop'ом.
  const pollThread = useCallback(async () => {
    try {
      const data = await clientApiFetch<ThreadResponse>('/support/thread');
      setThread(data.thread);
      setMessages((prev) => {
        const next = data.messages;
        const unchanged =
          prev.length === next.length &&
          prev[prev.length - 1]?.id === next[next.length - 1]?.id;
        return unchanged ? prev : next;
      });
    } catch {
      /* фоновый опрос — ошибку не показываем */
    }
  }, []);

  useEffect(() => {
    if (!thread?.id) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') void pollThread();
    };
    const timer = setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [thread?.id, pollThread]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const validation = useMemo(() => validateMessageBody(draft), [draft]);
  const canSend = !sending && validation.ok;

  const handleSend = useCallback(async () => {
    if (!validation.ok || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await clientApiFetch<SendResponse>('/support/messages', {
        method: 'POST',
        body: JSON.stringify({ body: validation.body }),
      });
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev;
        return [...prev, res.message];
      });
      setDraft('');
      textareaRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить сообщение');
    } finally {
      setSending(false);
    }
  }, [validation, sending]);

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-4 sm:mb-6">
        <h1
          className="text-xl sm:text-2xl font-bold mb-1.5 m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Поддержка
        </h1>
        <p className="text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Напишите менеджеру — мы видим сообщение в портале и отвечаем в рабочее время.
        </p>
      </header>

      <div className="neu-card flex flex-col" style={{ minHeight: '60vh' }}>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2
                className="h-5 w-5 animate-spin"
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-label="Загрузка"
              />
            </div>
          ) : messages.length === 0 ? (
            <div className="text-center py-12 px-4">
              <MessageSquare
                className="mx-auto h-8 w-8 mb-3"
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              />
              <p
                className="text-sm sm:text-base font-semibold mb-2"
                style={{ color: 'var(--cp-paper)' }}
              >
                Пока сообщений нет
              </p>
              <p
                className="text-xs sm:text-sm max-w-md mx-auto"
                style={{ color: 'var(--cp-paper-mute)' }}
              >
                Опишите вопрос, проблему или пожелание. Менеджер получит уведомление
                и ответит вам прямо здесь — переписка сохраняется.
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))
          )}
          <div ref={listEndRef} />
        </div>

        <div
          className="border-t p-3 sm:p-4"
          style={{ borderColor: 'var(--cp-divider)' }}
        >
          {error && (
            <div className="flex items-start gap-2 mb-2 text-xs">
              <span
                aria-hidden
                className="ds-status-dot shrink-0"
                style={{ background: 'var(--cp-red)', marginTop: '5px' }}
              />
              <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
            </div>
          )}
          <div className="flex items-end gap-2 sm:gap-3">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Напишите сообщение… (Ctrl/⌘ + Enter — отправить)"
              maxLength={SUPPORT_MESSAGE_MAX_LEN}
              rows={2}
              className="ds-input flex-1 resize-none"
              aria-label="Сообщение менеджеру"
            />
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void handleSend()}
              className="ds-btn-primary inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Отправить"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              <span className="hidden sm:inline">Отправить</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: SupportMessageRow }) {
  const fromClient = message.sender_role === 'client';
  return (
    <div className={`flex ${fromClient ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[85%] sm:max-w-[75%] rounded-lg px-3.5 py-2"
        style={
          fromClient
            ? { background: 'var(--cp-paper)', color: 'var(--cp-ink)' }
            : {
                background: 'var(--cp-surface-rest)',
                border: '1px solid var(--cp-divider)',
                color: 'var(--cp-paper)',
              }
        }
      >
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.body}
        </div>
        <div
          className="ds-mono text-[10px] mt-1.5"
          style={
            fromClient
              ? { color: 'rgba(10, 10, 10, 0.55)' }
              : { color: 'var(--cp-paper-faint)' }
          }
        >
          {fromClient ? 'Вы' : 'Менеджер'} · {formatTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}
