'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Forward,
  Loader2,
  Reply,
  Send,
  X,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { ClientReplyThread, ThreadMessage } from '@/lib/clientCampaignReplies/types';

type ActionMode = 'reply' | 'forward' | null;

interface ReplyThreadActionsProps {
  campaignId: string;
  emailId: string;
  onAfterAction?: () => void;
}

function formatReplyDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ThreadMessageCard({ msg }: { msg: ThreadMessage }) {
  const isInbound = msg.direction === 'inbound';
  return (
    <div className="neu-sm px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        {isInbound ? (
          <ArrowDownLeft className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cp-accent)' }} />
        ) : (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
        )}
        <span
          className="text-[10px] uppercase tracking-wider font-bold shrink-0"
          style={{ color: isInbound ? 'var(--cp-accent)' : 'var(--cp-text-l)' }}
        >
          {isInbound ? 'Лид' : 'Мы'}
        </span>
        <span className="text-[10px] truncate flex-1 min-w-0" style={{ color: 'var(--cp-text-m)' }}>
          {msg.from_name ? `${msg.from_name} • ` : ''}{msg.from_email ?? ''}
        </span>
        <span className="text-[10px] shrink-0" style={{ color: 'var(--cp-text-l)' }}>
          {formatReplyDate(msg.timestamp)}
        </span>
      </div>
      {msg.subject && (
        <p className="text-[11px] font-semibold mb-1 truncate" style={{ color: 'var(--cp-text-d)' }}>
          {msg.subject}
        </p>
      )}
      {msg.body_text ? (
        <pre className="text-[11px] whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-y-auto" style={{ color: 'var(--cp-text-m)' }}>
          {msg.body_text}
        </pre>
      ) : (
        <p className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>(пусто)</p>
      )}
    </div>
  );
}

interface ReplyFormProps {
  campaignId: string;
  emailId: string;
  onCancel: () => void;
  onSent: () => void;
}

function ReplyForm({ campaignId, emailId, onCancel, onSent }: ReplyFormProps) {
  const [bodyText, setBodyText] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const handleSend = async () => {
    setSending(true);
    setError('');
    try {
      await clientApiFetch(`/campaigns/${campaignId}/replies/${emailId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body_text: bodyText, cc: cc || undefined, bcc: bcc || undefined }),
      });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="neu-sm p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold" style={{ color: 'var(--cp-text-d)' }}>Ответить лиду</p>
        <button type="button" onClick={onCancel} className="neu-pill p-1" style={{ color: 'var(--cp-text-l)' }}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <input
        type="text"
        value={cc}
        onChange={(e) => setCc(e.target.value)}
        placeholder="CC (через запятую): boss@company.ru, team@..."
        className="neu-input w-full px-3 py-2 text-[11px] sm:text-xs bg-transparent outline-none"
        style={{ color: 'var(--cp-text-d)' }}
      />
      {showBcc ? (
        <input
          type="text"
          value={bcc}
          onChange={(e) => setBcc(e.target.value)}
          placeholder="BCC (скрытая копия)"
          className="neu-input w-full px-3 py-2 text-[11px] sm:text-xs bg-transparent outline-none"
          style={{ color: 'var(--cp-text-d)' }}
        />
      ) : (
        <button type="button" onClick={() => setShowBcc(true)} className="text-[10px] font-semibold" style={{ color: 'var(--cp-text-l)' }}>
          + добавить скрытую копию
        </button>
      )}
      <textarea
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        rows={6}
        placeholder="Текст ответа..."
        className="neu-input w-full px-3 py-2 text-[11px] sm:text-xs bg-transparent outline-none resize-y"
        style={{ color: 'var(--cp-text-d)' }}
      />
      {error && <p className="text-[11px]" style={{ color: 'var(--cp-danger)' }}>{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={sending}
          className="neu-pill px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
          style={{ color: 'var(--cp-text-m)' }}
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || bodyText.trim().length === 0}
          className="neu-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
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

  const handleSend = async () => {
    setSending(true);
    setError('');
    try {
      await clientApiFetch(`/campaigns/${campaignId}/replies/${emailId}/forward`, {
        method: 'POST',
        body: JSON.stringify({ to_email: toEmail }),
      });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переслать');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="neu-sm p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold" style={{ color: 'var(--cp-text-d)' }}>Переслать письмо</p>
        <button type="button" onClick={onCancel} className="neu-pill p-1" style={{ color: 'var(--cp-text-l)' }}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <input
        type="email"
        value={toEmail}
        onChange={(e) => setToEmail(e.target.value)}
        placeholder="Кому: colleague@company.ru"
        className="neu-input w-full px-3 py-2 text-[11px] sm:text-xs bg-transparent outline-none"
        style={{ color: 'var(--cp-text-d)' }}
      />
      <p className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
        Пересылаем оригинальный текст письма от лида целиком.
      </p>
      {error && <p className="text-[11px]" style={{ color: 'var(--cp-danger)' }}>{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={sending}
          className="neu-pill px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
          style={{ color: 'var(--cp-text-m)' }}
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || toEmail.trim().length === 0}
          className="neu-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Forward className="h-3 w-3" />}
          Переслать
        </button>
      </div>
    </div>
  );
}

export function ReplyThreadActions({ campaignId, emailId, onAfterAction }: ReplyThreadActionsProps) {
  const [thread, setThread] = useState<ThreadMessage[] | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [actionMode, setActionMode] = useState<ActionMode>(null);

  const loadThread = useCallback(async () => {
    setThreadLoading(true);
    setThreadError('');
    try {
      const data = await clientApiFetch<ClientReplyThread>(
        `/campaigns/${campaignId}/replies/${emailId}/thread`,
      );
      setThread(data.messages);
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : 'Не удалось загрузить тред');
    } finally {
      setThreadLoading(false);
    }
  }, [campaignId, emailId]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  return (
    <div className="mt-5 space-y-3">
      <hr className="neu-divider" />

      {threadLoading && (
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загружаем тред...
        </div>
      )}
      {threadError && (
        <p className="text-[11px]" style={{ color: 'var(--cp-danger)' }}>{threadError}</p>
      )}

      {thread && thread.length > 0 && (
        <div className="space-y-2">
          {thread.map((msg) => (
            <ThreadMessageCard key={msg.id} msg={msg} />
          ))}
        </div>
      )}

      {!threadLoading && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => setActionMode((m) => (m === 'reply' ? null : 'reply'))}
            className={`neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold ${actionMode === 'reply' ? 'active' : ''}`}
            style={actionMode !== 'reply' ? { color: 'var(--cp-text-m)' } : undefined}
          >
            <Reply className="h-3 w-3" /> Ответить
          </button>
          <button
            type="button"
            onClick={() => setActionMode((m) => (m === 'forward' ? null : 'forward'))}
            className={`neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold ${actionMode === 'forward' ? 'active' : ''}`}
            style={actionMode !== 'forward' ? { color: 'var(--cp-text-m)' } : undefined}
          >
            <Forward className="h-3 w-3" /> Переслать
          </button>
        </div>
      )}

      {actionMode === 'reply' && (
        <ReplyForm
          campaignId={campaignId}
          emailId={emailId}
          onCancel={() => setActionMode(null)}
          onSent={() => {
            setActionMode(null);
            void loadThread();
            onAfterAction?.();
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
