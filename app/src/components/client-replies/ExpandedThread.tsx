'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Forward,
  Loader2,
  RefreshCw,
  Reply,
  Send,
  X,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { isAuthExpiredError } from '@/lib/authFetch';
import type { ClientReplyThread, ThreadMessage, Recipient } from '@/lib/clientCampaignReplies/types';

/**
 * The expandable lead-reply thread block. Shows the full message history
 * with «ЛИД»/«МЫ» direction tags, plus «Ответить» / «Переслать» action
 * buttons that open inline forms. Used in three places:
 *
 *   - `/client/campaigns/[id]?tab=replies` (campaign Replies tab) —
 *     rendered inside each expanded reply row, indented under a chevron.
 *   - `/client/replies` — global replies list, rendered as a standalone
 *     block under each lead detail card.
 *   - `/client/leads` — leads list, same standalone use as /replies.
 *
 * History: this component was previously duplicated — once here as
 * `ReplyThreadActions` (neu-* styles, no auth-expired recovery), and
 * once inline in `campaigns/[id]/page.tsx` (ds-* styles, with auth
 * recovery added later). The two copies drifted: a session-expiry fix
 * applied to one didn't fix the other. Now there's a single source of
 * truth here, using the modern ds-* design system and full auth-expired
 * recovery.
 */

type ActionMode = 'reply' | 'forward' | null;

function formatReplyDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «Имя <email>» (или просто email), через запятую — для строк «Кому»/«Копия». */
function formatRecipients(list: Recipient[]): string {
  return list.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ');
}

/**
 * Inline recovery link shown when the replies UI catches an
 * AuthExpiredError. Opens login in a NEW tab so the form contents in
 * the current tab survive — user logs in over there, comes back,
 * retries. Used in three places below (thread load, reply send,
 * forward send), so factored out here.
 */
function AuthExpiredLink() {
  return (
    <a
      href="/login"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[10px] font-semibold underline-offset-2 hover:underline"
      style={{ color: 'var(--cp-paper)' }}
    >
      Открыть страницу входа в новой вкладке →
    </a>
  );
}

function ThreadMessageCard({ msg }: { msg: ThreadMessage }) {
  const isInbound = msg.direction === 'inbound';
  const directionColor = isInbound ? 'var(--cp-amber)' : 'var(--cp-paper-faint)';
  return (
    <div className="neu-sm px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        {isInbound ? (
          <ArrowDownLeft
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: directionColor }}
            aria-hidden
          />
        ) : (
          <ArrowUpRight
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: directionColor }}
            aria-hidden
          />
        )}
        <span className="ds-eyebrow shrink-0" style={{ color: directionColor }}>
          {isInbound ? 'ЛИД' : 'МЫ'}
        </span>
        <span
          className="text-[10px] truncate flex-1 min-w-0"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          {msg.from_name ? `${msg.from_name} · ` : ''}
          {msg.from_email ?? ''}
        </span>
        <span
          className="ds-mono text-[10px] shrink-0"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {formatReplyDate(msg.timestamp)}
        </span>
      </div>
      {(msg.to_recipients.length > 0 || msg.cc_recipients.length > 0) && (
        <div
          className="text-[10px] leading-snug mb-1.5 space-y-0.5"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {msg.to_recipients.length > 0 && (
            <p className="truncate">
              <span style={{ color: 'var(--cp-paper-mute)' }}>Кому: </span>
              {formatRecipients(msg.to_recipients)}
            </p>
          )}
          {msg.cc_recipients.length > 0 && (
            <p className="truncate">
              <span style={{ color: 'var(--cp-paper-mute)' }}>Копия: </span>
              {formatRecipients(msg.cc_recipients)}
            </p>
          )}
        </div>
      )}
      {msg.subject && (
        <p
          className="text-[11px] font-semibold mb-1 truncate"
          style={{ color: 'var(--cp-paper)' }}
        >
          {msg.subject}
        </p>
      )}
      {msg.body_text ? (
        <pre
          className="text-[11px] whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-y-auto"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          {msg.body_text}
        </pre>
      ) : (
        <p className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
          (пусто)
        </p>
      )}
    </div>
  );
}

interface ReplyFormProps {
  campaignId: string;
  emailId: string;
  replyTo?: Recipient | null;
  replyAllCc?: Recipient[];
  onCancel: () => void;
  onSent: () => void;
}

function ReplyForm({ campaignId, emailId, replyTo, replyAllCc, onCancel, onSent }: ReplyFormProps) {
  const [bodyText, setBodyText] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [authExpired, setAuthExpired] = useState(false);

  const handleSend = async () => {
    setSending(true);
    setError('');
    setAuthExpired(false);
    try {
      await clientApiFetch(`/campaigns/${campaignId}/replies/${emailId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          body_text: bodyText,
          cc: cc || undefined,
          bcc: bcc || undefined,
        }),
      });
      onSent();
    } catch (err) {
      if (isAuthExpiredError(err)) setAuthExpired(true);
      setError(err instanceof Error ? err.message : 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="neu-sm p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="ds-eyebrow">Ответить лиду</p>
        <button
          type="button"
          onClick={onCancel}
          className="ds-btn-ghost p-1"
          aria-label="Закрыть"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {replyTo ? (
        <div className="text-[10px] leading-snug space-y-0.5" style={{ color: 'var(--cp-paper-faint)' }}>
          <p className="truncate">
            <span style={{ color: 'var(--cp-paper-mute)' }}>Ответ уйдёт: </span>
            {replyTo.name ? `${replyTo.name} <${replyTo.email}>` : replyTo.email}
          </p>
          {replyAllCc && replyAllCc.length > 0 ? (
            <p className="truncate">
              <span style={{ color: 'var(--cp-paper-mute)' }}>Останутся в копии («ответить всем»): </span>
              {formatRecipients(replyAllCc)}
            </p>
          ) : (
            <p>В копии больше никого — в переписке только лид.</p>
          )}
        </div>
      ) : (
        <p className="text-[10px] leading-snug" style={{ color: 'var(--cp-paper-faint)' }}>
          Участники переписки останутся в копии автоматически («ответить всем») — никого не потеряем.
        </p>
      )}
      <input
        type="text"
        value={cc}
        onChange={(e) => setCc(e.target.value)}
        placeholder="Добавить ещё в копию (через запятую)"
        className="ds-input w-full text-[11px] sm:text-xs"
      />
      {showBcc ? (
        <input
          type="text"
          value={bcc}
          onChange={(e) => setBcc(e.target.value)}
          placeholder="BCC (скрытая копия)"
          className="ds-input w-full text-[11px] sm:text-xs"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowBcc(true)}
          className="text-[10px] font-semibold underline-offset-2 hover:underline"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          + добавить скрытую копию
        </button>
      )}
      <textarea
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        rows={6}
        placeholder="Текст ответа…"
        className="ds-input w-full text-[11px] sm:text-xs resize-y"
      />
      {error && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span
              aria-hidden
              className="ds-status-dot shrink-0"
              style={{ background: 'var(--cp-red)' }}
            />
            <span style={{ color: 'var(--cp-paper)' }}>
              {authExpired
                ? 'Сессия истекла. Откройте страницу входа в новой вкладке — текст ответа и CC сохранятся здесь.'
                : error}
            </span>
          </div>
          {authExpired && (
            <div className="pl-4">
              <AuthExpiredLink />
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={sending}
          className="ds-btn-ghost px-3 py-1.5 text-[11px] disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || bodyText.trim().length === 0}
          className="ds-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <Send className="h-3 w-3" aria-hidden />
          )}
          Отправить
        </button>
      </div>
    </div>
  );
}

interface ForwardFormProps {
  campaignId: string;
  emailId: string;
  onCancel: () => void;
  onSent: () => void;
}

function ForwardForm({ campaignId, emailId, onCancel, onSent }: ForwardFormProps) {
  const [toEmail, setToEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [authExpired, setAuthExpired] = useState(false);

  const handleSend = async () => {
    setSending(true);
    setError('');
    setAuthExpired(false);
    try {
      await clientApiFetch(`/campaigns/${campaignId}/replies/${emailId}/forward`, {
        method: 'POST',
        body: JSON.stringify({ to_email: toEmail }),
      });
      onSent();
    } catch (err) {
      if (isAuthExpiredError(err)) setAuthExpired(true);
      setError(err instanceof Error ? err.message : 'Не удалось переслать');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="neu-sm p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="ds-eyebrow">Переслать письмо</p>
        <button
          type="button"
          onClick={onCancel}
          className="ds-btn-ghost p-1"
          aria-label="Закрыть"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <input
        type="email"
        value={toEmail}
        onChange={(e) => setToEmail(e.target.value)}
        placeholder="Кому: colleague@company.ru"
        className="ds-input w-full text-[11px] sm:text-xs"
      />
      <p className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
        Пересылаем оригинальный текст письма от лида целиком.
      </p>
      {error && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span
              aria-hidden
              className="ds-status-dot shrink-0"
              style={{ background: 'var(--cp-red)' }}
            />
            <span style={{ color: 'var(--cp-paper)' }}>
              {authExpired
                ? 'Сессия истекла. Откройте страницу входа в новой вкладке — адрес получателя сохранится здесь.'
                : error}
            </span>
          </div>
          {authExpired && (
            <div className="pl-4">
              <AuthExpiredLink />
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={sending}
          className="ds-btn-ghost px-3 py-1.5 text-[11px] disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || toEmail.trim().length === 0}
          className="ds-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <Forward className="h-3 w-3" aria-hidden />
          )}
          Переслать
        </button>
      </div>
    </div>
  );
}

export interface ExpandedThreadProps {
  campaignId: string;
  emailId: string;
  /**
   * Optional callback fired AFTER a reply or forward is successfully sent.
   * `/client/replies` and `/client/leads` don't currently use it; the
   * campaign-Replies tab uses it to refresh the surrounding list.
   */
  onAfterAction?: () => void;
  /**
   * Optional callback fired ONLY after a reply (not a forward) is successfully
   * sent. `/client/replies` uses it to optimistically flip the conversation to
   * «Отвечено» in the list without waiting for a full reload.
   */
  onReplied?: () => void;
  /**
   * Optional fallback messages rendered ONLY if the live /thread fetch fails
   * (Instantly slow/down). Keeps the detail view from going empty — it still
   * shows the lead's latest reply, built from already-loaded list data.
   * /client/replies passes this since it dropped its pinned reply block.
   */
  fallbackMessages?: ThreadMessage[];
  /**
   * Override the wrapper className. Default: `mt-5 space-y-3` — standalone
   * block (used on `/client/replies` and `/client/leads`). The campaign-
   * Replies tab passes `mt-3 pl-7 space-y-3` because the component nests
   * under a row with a chevron prefix.
   */
  className?: string;
}

export function ExpandedThread({
  campaignId,
  emailId,
  onAfterAction,
  onReplied,
  fallbackMessages,
  className,
}: ExpandedThreadProps) {
  const [thread, setThread] = useState<ThreadMessage[] | null>(null);
  const [replyTo, setReplyTo] = useState<Recipient | null>(null);
  const [replyAllCc, setReplyAllCc] = useState<Recipient[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [threadAuthExpired, setThreadAuthExpired] = useState(false);
  const [actionMode, setActionMode] = useState<ActionMode>(null);

  const loadThread = useCallback(async () => {
    setThreadLoading(true);
    setThreadError('');
    setThreadAuthExpired(false);
    try {
      const data = await clientApiFetch<ClientReplyThread>(
        `/campaigns/${campaignId}/replies/${emailId}/thread`,
      );
      setThread(data.messages);
      setReplyTo(data.reply_to ?? null);
      setReplyAllCc(data.reply_all_cc ?? []);
    } catch (err) {
      if (isAuthExpiredError(err)) setThreadAuthExpired(true);
      setThreadError(err instanceof Error ? err.message : 'Не удалось загрузить тред');
    } finally {
      setThreadLoading(false);
    }
  }, [campaignId, emailId]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  return (
    <div className={className ?? 'mt-5 space-y-3'}>
      <hr className="neu-divider" />

      {threadLoading && (
        <div
          className="flex items-center gap-2 text-[11px]"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Загружаем тред…
        </div>
      )}
      {threadError && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span
              aria-hidden
              className="ds-status-dot shrink-0"
              style={{ background: 'var(--cp-red)' }}
            />
            <span className="flex-1" style={{ color: 'var(--cp-paper)' }}>
              {threadAuthExpired
                ? 'Сессия истекла. Войдите заново — раскрытый тред подгрузится после возврата.'
                : threadError}
            </span>
            <button
              type="button"
              onClick={() => void loadThread()}
              className="ds-btn-ghost inline-flex items-center gap-1 px-2 py-0.5 text-[10px]"
            >
              <RefreshCw className="h-2.5 w-2.5" aria-hidden />
              Повторить
            </button>
          </div>
          {threadAuthExpired && (
            <div className="pl-4">
              <AuthExpiredLink />
            </div>
          )}
        </div>
      )}

      {thread && thread.length > 0 ? (
        <div className="space-y-2">
          {thread.map((msg) => (
            <ThreadMessageCard key={msg.id} msg={msg} />
          ))}
        </div>
      ) : threadError && fallbackMessages && fallbackMessages.length > 0 ? (
        // Тред не загрузился — показываем хотя бы последний ответ лида из уже
        // загруженных данных списка, чтобы карточка не осталась без содержимого.
        <div className="space-y-2">
          {fallbackMessages.map((msg) => (
            <ThreadMessageCard key={msg.id} msg={msg} />
          ))}
        </div>
      ) : null}

      {!threadLoading && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => setActionMode((m) => (m === 'reply' ? null : 'reply'))}
            className={`ds-btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] ${
              actionMode === 'reply' ? 'active' : ''
            }`}
          >
            <Reply className="h-3 w-3" aria-hidden /> Ответить
          </button>
          <button
            type="button"
            onClick={() => setActionMode((m) => (m === 'forward' ? null : 'forward'))}
            className={`ds-btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] ${
              actionMode === 'forward' ? 'active' : ''
            }`}
          >
            <Forward className="h-3 w-3" aria-hidden /> Переслать
          </button>
        </div>
      )}

      {actionMode === 'reply' && (
        <ReplyForm
          campaignId={campaignId}
          emailId={emailId}
          replyTo={replyTo}
          replyAllCc={replyAllCc}
          onCancel={() => setActionMode(null)}
          onSent={() => {
            setActionMode(null);
            void loadThread();
            onAfterAction?.();
            onReplied?.();
          }}
        />
      )}
      {actionMode === 'forward' && (
        <ForwardForm
          campaignId={campaignId}
          emailId={emailId}
          onCancel={() => setActionMode(null)}
          onSent={() => {
            setActionMode(null);
            onAfterAction?.();
          }}
        />
      )}
    </div>
  );
}
