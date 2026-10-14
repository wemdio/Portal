'use client';

/**
 * Client-side support chat (/client/support; page.tsx renders it).
 *
 * Replaces the legacy mailto:hello@polza.com fallback that lived in the
 * empty-state buttons of /client/projects and /client/launch. Each client
 * has exactly one persistent thread, lazily created on first GET.
 *
 * Realtime: subscribes to INSERT events on `client_support_messages`
 * filtered by the thread's id, so a manager's reply lands in the UI
 * without polling. Optimistic local append on submit gets reconciled when
 * the realtime payload arrives (we de-duplicate by message id).
 *
 * ENG-клиент (profiles.market='eng') попадает сюда из меню ENG-кабинета
 * («Support»): кабинет self-serve, и его отказы ведут в этот чат. Рынок —
 * тот же признак, по которому layout сводит навигацию к ENG-кабинету
 * (resolveNavMarket: ENG-хост, иначе profiles.market из portal-mode через
 * ClientPortalProvider). Хост приходит пропом `engHost` от серверной
 * page.tsx: layout узнаёт его только в браузере, и без пропа серверный HTML
 * на ENG-хосте был бы русским до гидрации. Для ENG все строки английские
 * (TEXT.eng), ошибки API — английский текст ответа, если он английский
 * (engSafeText), иначе своя фраза страницы: общий роут отдаёт часть отказов
 * по-русски. RU-рендер — TEXT.ru, строки байт в байт прежние.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Loader2, MessageSquare } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { clientApiFetch } from '@/lib/clientFetcher';
import { isAuthExpiredError } from '@/lib/authFetch';
import { useClientPortalContext } from '@/lib/clientPortalContext';
import { engSafeText, localizeEngError } from '@/components/client-eng/engText';
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

/**
 * Строки страницы по кабинету. В ENG-текстах нет «менеджера» (кабинет
 * self-serve, отвечает команда) и нет обещания часов ответа: про рабочие
 * часы команды кабинет клиенту другого часового пояса ничего не говорит.
 * «Our team sees it in the portal» — правда при любом исходе отправки
 * уведомлений (notifyManagersOfClientMessage и Telegram-алерт — best-effort):
 * staff-инбокс (/support, api/admin/support/threads) показывает каждый тред.
 */
const TEXT = {
  ru: {
    title: 'Поддержка',
    lead: 'Напишите менеджеру — мы видим сообщение в портале и отвечаем в рабочее время.',
    loading: 'Загрузка',
    emptyTitle: 'Пока сообщений нет',
    // Прежний JSX-текст в две строки; JSX склеивал их через один пробел.
    emptyBody:
      'Опишите вопрос, проблему или пожелание. Менеджер получит уведомление и ответит вам прямо здесь — переписка сохраняется.',
    placeholder: 'Напишите сообщение… (Ctrl/⌘ + Enter — отправить)',
    inputLabel: 'Сообщение менеджеру',
    send: 'Отправить',
    loadFailed: 'Не удалось загрузить чат',
    sendFailed: 'Не удалось отправить сообщение',
    you: 'Вы',
    staff: 'Менеджер',
    timeLocale: 'ru-RU',
  },
  eng: {
    title: 'Support',
    lead: 'Write to our team here. We see every message in the portal and reply in this chat.',
    loading: 'Loading',
    emptyTitle: 'No messages yet',
    emptyBody:
      'Describe your question, problem or request. Our team sees it in the portal and replies right here — the conversation is saved.',
    placeholder: 'Write a message… (Ctrl/⌘ + Enter to send)',
    inputLabel: 'Message to Support',
    send: 'Send',
    loadFailed: 'Could not load the chat. Refresh the page.',
    sendFailed: 'Your message was not sent. Try again.',
    you: 'You',
    staff: 'Support',
    timeLocale: 'en-US',
  },
} as const;

type SupportText = (typeof TEXT)[keyof typeof TEXT];

/**
 * Текст ошибки для ENG-клиента: истёкшая сессия — английская фраза кабинета
 * (localizeEngError), английский ответ роута (503, демо) — как есть, русский
 * или нечитаемый — своя фраза страницы.
 */
function engChatErrorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  if (isAuthExpiredError(err)) return (localizeEngError(err) as Error).message;
  return engSafeText(err.message) ?? fallback;
}

/**
 * Ошибка сразу на оба кабинета: рынок вне ENG-хоста проясняется ответом
 * portal-mode и может прийти ПОЗЖЕ ошибки первой загрузки — тогда экран
 * перерисуется на английский без повторного запроса. RU-строка берётся
 * первой и та же, что раньше (localizeEngError у истёкшей сессии переписывает
 * message ошибки).
 */
type ChatError = { ru: string; eng: string };

function chatError(err: unknown, kind: 'loadFailed' | 'sendFailed'): ChatError {
  const ru = err instanceof Error ? err.message : TEXT.ru[kind];
  return { ru, eng: engChatErrorText(err, TEXT.eng[kind]) };
}

function formatTime(iso: string, timeLocale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(timeLocale, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString(timeLocale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SupportChat({ engHost }: { engHost: boolean }) {
  const { market } = useClientPortalContext();
  // Хост решает и на сервере, и в браузере одинаково (без расхождения
  // гидрации); вне ENG-хоста — рынок профиля, как у навигации.
  const isEng = engHost || market === 'eng';
  const t: SupportText = isEng ? TEXT.eng : TEXT.ru;
  const [thread, setThread] = useState<SupportThreadRow | null>(null);
  const [messages, setMessages] = useState<SupportMessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ChatError | null>(null);
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
      setError(chatError(err, 'loadFailed'));
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
      setError(chatError(err, 'sendFailed'));
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
          {t.title}
        </h1>
        <p className="text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          {t.lead}
        </p>
      </header>

      <div className="neu-card flex flex-col" style={{ minHeight: '60vh' }}>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2
                className="h-5 w-5 animate-spin"
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-label={t.loading}
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
                {t.emptyTitle}
              </p>
              <p
                className="text-xs sm:text-sm max-w-md mx-auto"
                style={{ color: 'var(--cp-paper-mute)' }}
              >
                {t.emptyBody}
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble key={m.id} message={m} text={t} />
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
              <span style={{ color: 'var(--cp-paper)' }}>{isEng ? error.eng : error.ru}</span>
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
              placeholder={t.placeholder}
              maxLength={SUPPORT_MESSAGE_MAX_LEN}
              rows={2}
              className="ds-input flex-1 resize-none"
              aria-label={t.inputLabel}
            />
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void handleSend()}
              className="ds-btn-primary inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t.send}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              <span className="hidden sm:inline">{t.send}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, text }: { message: SupportMessageRow; text: SupportText }) {
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
          {fromClient ? text.you : text.staff} · {formatTime(message.created_at, text.timeLocale)}
        </div>
      </div>
    </div>
  );
}
