'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { Pause, Play, Loader2, Search, ChevronDown, ChevronRight, Inbox, Sparkles, Reply, Forward, X, Send, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { CampaignStatus, CampaignStatusLabels, type Campaign, type CampaignAnalytics, type CampaignStepAnalytics, type SequenceStep } from '@/lib/instantly/types';
import type { ClientReply, ClientRepliesPage, ClientReplyThread, ThreadMessage } from '@/lib/clientCampaignReplies/types';

function MetricCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="neu-sm p-3 sm:p-4">
      <p className="ds-eyebrow">{label}</p>
      <p
        className="ds-mono mt-1.5 sm:mt-2 text-lg sm:text-xl font-semibold"
        style={{ color: 'var(--cp-paper)' }}
      >
        {value}
      </p>
      {sub && (
        <p
          className="ds-mono mt-0.5 text-[10px] sm:text-xs"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function stripHtml(value?: string): string {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
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

interface RepliesPanelProps {
  campaignId: string;
  replies: ClientReply[];
  loading: boolean;
  error: string;
  loaded: boolean;
  searchInput: string;
  onSearchInputChange: (v: string) => void;
  onSearch: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  expandedReplyId: string | null;
  onToggleExpand: (id: string) => void;
}

type ActionMode = 'reply' | 'forward' | null;

interface ExpandedThreadProps {
  campaignId: string;
  emailId: string;
  onAfterAction: () => void;
}

function ExpandedThread({ campaignId, emailId, onAfterAction }: ExpandedThreadProps) {
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
    <div className="mt-3 pl-7 space-y-3">
      <hr className="neu-divider" />

      {threadLoading && (
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Загружаем тред…
        </div>
      )}
      {threadError && (
        <div className="flex items-start gap-2 text-[11px]">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)', marginTop: '5px' }} />
          <span style={{ color: 'var(--cp-paper)' }}>{threadError}</span>
        </div>
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
            className={`ds-btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] ${actionMode === 'reply' ? 'active' : ''}`}
          >
            <Reply className="h-3 w-3" aria-hidden /> Ответить
          </button>
          <button
            type="button"
            onClick={() => setActionMode((m) => (m === 'forward' ? null : 'forward'))}
            className={`ds-btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] ${actionMode === 'forward' ? 'active' : ''}`}
          >
            <Forward className="h-3 w-3" aria-hidden /> Переслать
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
            onAfterAction();
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
            onAfterAction();
          }}
        />
      )}
    </div>
  );
}

function ThreadMessageCard({ msg }: { msg: ThreadMessage }) {
  const isInbound = msg.direction === 'inbound';
  const directionColor = isInbound ? 'var(--cp-amber)' : 'var(--cp-paper-faint)';
  return (
    <div className="neu-sm px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        {isInbound ? (
          <ArrowDownLeft className="h-3.5 w-3.5 shrink-0" style={{ color: directionColor }} aria-hidden />
        ) : (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" style={{ color: directionColor }} aria-hidden />
        )}
        <span className="ds-eyebrow shrink-0" style={{ color: directionColor }}>
          {isInbound ? 'ЛИД' : 'МЫ'}
        </span>
        <span className="text-[10px] truncate flex-1 min-w-0" style={{ color: 'var(--cp-paper-mute)' }}>
          {msg.from_name ? `${msg.from_name} · ` : ''}{msg.from_email ?? ''}
        </span>
        <span className="ds-mono text-[10px] shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
          {formatReplyDate(msg.timestamp)}
        </span>
      </div>
      {msg.subject && (
        <p className="text-[11px] font-semibold mb-1 truncate" style={{ color: 'var(--cp-paper)' }}>
          {msg.subject}
        </p>
      )}
      {msg.body_text ? (
        <pre className="text-[11px] whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-y-auto" style={{ color: 'var(--cp-paper-mute)' }}>
          {msg.body_text}
        </pre>
      ) : (
        <p className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>(пусто)</p>
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
      <input
        type="text"
        value={cc}
        onChange={(e) => setCc(e.target.value)}
        placeholder="CC (через запятую): boss@company.ru, team@..."
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
        <div className="flex items-start gap-2 text-[11px]">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)', marginTop: '5px' }} />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
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
          {sending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Send className="h-3 w-3" aria-hidden />}
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
        <div className="flex items-start gap-2 text-[11px]">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)', marginTop: '5px' }} />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
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
          {sending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Forward className="h-3 w-3" aria-hidden />}
          Переслать
        </button>
      </div>
    </div>
  );
}

function RepliesPanel({
  campaignId,
  replies,
  loading,
  error,
  loaded,
  searchInput,
  onSearchInputChange,
  onSearch,
  hasMore,
  onLoadMore,
  expandedReplyId,
  onToggleExpand,
}: RepliesPanelProps) {
  return (
    <div className="space-y-3">
      <div className="neu-sm flex items-center gap-2 px-3 py-2">
        <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-paper-faint)' }} aria-hidden />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSearch();
          }}
          placeholder="Поиск по тексту, теме, email…"
          className="flex-1 bg-transparent outline-none text-xs sm:text-sm"
          style={{ color: 'var(--cp-paper)' }}
        />
        <button
          type="button"
          onClick={onSearch}
          disabled={loading}
          className="ds-btn-secondary px-3 py-1 text-[11px] disabled:opacity-50"
        >
          Найти
        </button>
      </div>

      {error && (
        <div className="neu-inset rounded-lg px-4 py-3 text-xs flex items-start gap-2.5">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)', marginTop: '5px' }} />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
        </div>
      )}

      {loaded && !loading && replies.length === 0 && !error && (
        <div className="neu-card py-14 text-center">
          <Inbox className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--cp-paper-faint)' }} aria-hidden />
          <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            {searchInput ? 'По вашему запросу ответов не найдено' : 'Ответов пока нет'}
          </p>
        </div>
      )}

      {replies.length > 0 && (
        <div className="neu-card overflow-hidden divide-y" style={{ borderColor: 'rgba(180,173,164,0.15)' }}>
          {replies.map((r) => {
            const expanded = expandedReplyId === r.id;
            const headerName = r.from_name ? `${r.from_name} • ${r.from_email ?? ''}` : r.from_email ?? '(без email)';
            return (
              <div key={r.id} className="px-3 sm:px-5 py-3 sm:py-4 neu-row">
                <button
                  type="button"
                  onClick={() => onToggleExpand(r.id)}
                  className="w-full text-left flex items-start gap-3"
                >
                  <div className="mt-0.5 shrink-0">
                    {expanded ? (
                      <ChevronDown className="h-4 w-4" style={{ color: 'var(--cp-text-l)' }} />
                    ) : (
                      <ChevronRight className="h-4 w-4" style={{ color: 'var(--cp-text-l)' }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs sm:text-sm font-semibold truncate flex-1 min-w-0">{headerName}</p>
                      {r.is_unread && (
                        <span className="ds-status-tag" style={{ color: 'var(--cp-amber)' }}>
                          <span aria-hidden className="ds-status-dot" style={{ background: 'var(--cp-amber)' }} />
                          NEW
                        </span>
                      )}
                      {r.ai_interest_value !== null && (
                        <span className="ds-mono inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md" style={{ color: 'var(--cp-paper-mute)', background: 'var(--cp-surface-elev)' }}>
                          <Sparkles className="h-2.5 w-2.5" aria-hidden />
                          {r.ai_interest_value}
                        </span>
                      )}
                      <span className="ds-mono text-[10px] shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
                        {formatReplyDate(r.timestamp)}
                      </span>
                    </div>
                    {r.subject && (
                      <p className="mt-1 text-[11px] sm:text-xs truncate" style={{ color: 'var(--cp-paper-mute)' }}>
                        {r.subject}
                      </p>
                    )}
                    {!expanded && r.content_preview && (
                      <p className="mt-1 text-[11px] sm:text-xs line-clamp-2" style={{ color: 'var(--cp-paper-faint)' }}>
                        {r.content_preview}
                      </p>
                    )}
                  </div>
                </button>
                {expanded && (
                  <ExpandedThread
                    campaignId={campaignId}
                    emailId={r.id}
                    onAfterAction={() => undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasMore && !loading && (
        <div className="text-center">
          <button
            type="button"
            onClick={onLoadMore}
            className="ds-btn-ghost px-5 py-2 text-xs"
          >
            Загрузить ещё
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-6">
          <div className="neu-spinner animate-spin" />
        </div>
      )}
    </div>
  );
}

export default function ClientCampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [steps, setSteps] = useState<CampaignStepAnalytics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'overview' | 'steps' | 'replies'>('overview');
  const [actionPending, setActionPending] = useState<'pause' | 'activate' | null>(null);
  const [actionError, setActionError] = useState('');

  // Replies tab state
  const [replies, setReplies] = useState<ClientReply[]>([]);
  const [repliesNextCursor, setRepliesNextCursor] = useState<string | null>(null);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [repliesError, setRepliesError] = useState('');
  const [repliesSearch, setRepliesSearch] = useState('');
  const [repliesSearchInput, setRepliesSearchInput] = useState('');
  const [repliesLoaded, setRepliesLoaded] = useState(false);
  const [expandedReplyId, setExpandedReplyId] = useState<string | null>(null);

  const loadReplies = useCallback(
    async (mode: 'reset' | 'append', searchOverride?: string) => {
      setRepliesLoading(true);
      setRepliesError('');
      try {
        const params = new URLSearchParams();
        params.set('limit', '25');
        const q = searchOverride ?? repliesSearch;
        if (q) params.set('search', q);
        if (mode === 'append' && repliesNextCursor) params.set('starting_after', repliesNextCursor);
        const data = await clientApiFetch<ClientRepliesPage>(
          `/campaigns/${campaignId}/replies?${params.toString()}`,
        );
        setReplies((prev) => (mode === 'append' ? [...prev, ...data.items] : data.items));
        setRepliesNextCursor(data.next_starting_after ?? null);
        setRepliesLoaded(true);
      } catch (err) {
        setRepliesError(err instanceof Error ? err.message : 'Не удалось загрузить ответы');
      } finally {
        setRepliesLoading(false);
      }
    },
    [campaignId, repliesNextCursor, repliesSearch],
  );

  // Lazy-load replies on first switch to the tab
  useEffect(() => {
    if (tab === 'replies' && !repliesLoaded && !repliesLoading) {
      void loadReplies('reset');
    }
  }, [tab, repliesLoaded, repliesLoading, loadReplies]);

  const handleSearch = useCallback(() => {
    const q = repliesSearchInput.trim();
    setRepliesSearch(q);
    setRepliesNextCursor(null);
    void loadReplies('reset', q);
  }, [repliesSearchInput, loadReplies]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<{
        campaign: Campaign;
        analytics: CampaignAnalytics | null;
        steps: CampaignStepAnalytics[];
      }>(`/campaigns/${campaignId}`);
      setCampaign(data.campaign);
      setAnalytics(data.analytics);
      setSteps(data.steps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = useCallback(async (action: 'pause' | 'activate') => {
    setActionPending(action);
    setActionError('');
    try {
      await clientApiFetch<{ ok: true; status: string }>(`/campaigns/${campaignId}/${action}`, {
        method: 'POST',
      });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Не удалось выполнить действие');
    } finally {
      setActionPending(null);
    }
  }, [campaignId, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="neu-spinner animate-spin" />
      </div>
    );
  }

  if (error && !campaign) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link
          href={'/client' as Route}
          className="inline-flex items-center gap-1 text-xs font-medium mb-4 underline-offset-2 hover:underline"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          ← Кампании
        </Link>
        <div className="neu-inset rounded-lg px-5 py-4 text-sm font-medium flex items-start gap-2.5">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)', marginTop: '7px' }} />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
        </div>
      </div>
    );
  }

  if (!campaign) return null;

  const sentCount = Number(analytics?.emails_sent_count ?? 0);
  const openCount = Number(analytics?.open_count ?? 0);
  const replyCount = Number(analytics?.reply_count ?? 0);
  const contactedCount = Number(analytics?.new_leads_contacted_count ?? 0);
  const bouncedCount = Number(analytics?.bounced_count ?? 0);
  const openRate = sentCount > 0 ? ((openCount / sentCount) * 100).toFixed(1) : '0';
  const replyRate = contactedCount > 0 ? ((replyCount / contactedCount) * 100).toFixed(1) : '0';

  const sequences: SequenceStep[] = (campaign.sequences ?? []).flatMap((s) => s.steps ?? []);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={'/client' as Route}
        className="inline-flex items-center gap-1 text-xs font-medium mb-5 underline-offset-2 hover:underline"
        style={{ color: 'var(--cp-paper-mute)' }}
      >
        ← Кампании
      </Link>

      <header className="mb-1">
        <p className="ds-eyebrow mb-2">
          <span className="ds-mono">{campaign.id.slice(0, 8)}</span>
          <span aria-hidden> · </span>
          {CampaignStatusLabels[campaign.status] ?? `Статус ${campaign.status}`}
        </p>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h1
            className="text-lg sm:text-xl font-bold break-words flex-1 min-w-0 m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {campaign.name}
          </h1>
          <div className="flex items-center gap-2 shrink-0">
            {campaign.status === CampaignStatus.Active && (
              <button
                type="button"
                onClick={() => handleToggle('pause')}
                disabled={actionPending !== null}
                className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {actionPending === 'pause' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Pause className="h-3.5 w-3.5" aria-hidden />
                )}
                Пауза
              </button>
            )}
            {campaign.status === CampaignStatus.Paused && (
              <button
                type="button"
                onClick={() => handleToggle('activate')}
                disabled={actionPending !== null}
                className="ds-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {actionPending === 'activate' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="h-3.5 w-3.5" aria-hidden />
                )}
                Запустить
              </button>
            )}
          </div>
        </div>
      </header>
      {actionError && (
        <div className="text-xs mb-3 flex items-start gap-2">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)', marginTop: '5px' }} />
          <span style={{ color: 'var(--cp-paper)' }}>{actionError}</span>
        </div>
      )}
      <div className="mb-4 sm:mb-6" />

      <nav className="flex gap-1 mb-4 sm:mb-6" aria-label="Разделы кампании">
        {(['overview', 'steps', 'replies'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`ds-nav-item px-4 py-2 text-xs ${tab === t ? 'active' : ''}`}
            aria-current={tab === t ? 'page' : undefined}
          >
            {t === 'overview' ? 'Обзор' : t === 'steps' ? 'Цепочка' : 'Ответы'}
            {t === 'replies' && replyCount > 0 && (
              <span className="ds-mono ml-1.5 text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                ({replyCount})
              </span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-4 mb-4 sm:mb-6">
            <MetricCard label="Отправлено" value={sentCount} />
            <MetricCard label="Открытия" value={openCount} sub={`${openRate}%`} />
            <MetricCard label="Ответы" value={replyCount} sub={`${replyRate}%`} />
            <MetricCard label="Контактов" value={contactedCount} />
            <MetricCard label="Лидов" value={Number(analytics?.leads_count ?? 0)} />
            <MetricCard label="Bounce" value={bouncedCount} />
          </div>

          {steps.length > 0 && (
            <div className="neu-card overflow-hidden">
              <header className="px-3 sm:px-5 py-3 sm:py-4" style={{ background: 'var(--cp-surface-elev)', borderBottom: '1px solid var(--cp-divider)' }}>
                <p className="ds-eyebrow">статистика по шагам</p>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr style={{ background: 'var(--cp-surface-elev)' }}>
                      <th className="ds-eyebrow px-3 sm:px-5 py-2.5 sm:py-3 text-left">Шаг</th>
                      <th className="ds-eyebrow px-3 sm:px-5 py-2.5 sm:py-3 text-right">Отпр.</th>
                      <th className="ds-eyebrow px-3 sm:px-5 py-2.5 sm:py-3 text-right">Откр.</th>
                      <th className="ds-eyebrow px-3 sm:px-5 py-2.5 sm:py-3 text-right">Отв.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((s, i) => (
                      <tr key={i} className="neu-row" style={{ borderTop: '1px solid var(--cp-divider)' }}>
                        <td className="ds-mono px-3 sm:px-5 py-2.5 sm:py-3" style={{ color: 'var(--cp-paper)' }}>
                          {String(s.step).padStart(2, '0')}{s.variant ? ` · ${String.fromCharCode(65 + Number(s.variant))}` : ''}
                        </td>
                        <td className="ds-mono px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-paper-mute)' }}>{s.sent ?? 0}</td>
                        <td className="ds-mono px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-paper-mute)' }}>{s.unique_opened ?? s.opened ?? 0}</td>
                        <td className="ds-mono px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-paper-mute)' }}>{s.unique_replies ?? s.replies ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'replies' && (
        <RepliesPanel
          campaignId={campaignId}
          replies={replies}
          loading={repliesLoading}
          error={repliesError}
          loaded={repliesLoaded}
          searchInput={repliesSearchInput}
          onSearchInputChange={setRepliesSearchInput}
          onSearch={handleSearch}
          hasMore={!!repliesNextCursor}
          onLoadMore={() => void loadReplies('append')}
          expandedReplyId={expandedReplyId}
          onToggleExpand={(id) => setExpandedReplyId((prev) => (prev === id ? null : id))}
        />
      )}

      {tab === 'steps' && (
        <div className="space-y-3">
          {sequences.length === 0 ? (
            <div className="neu-card py-14 text-center">
              <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>Цепочка не настроена</p>
            </div>
          ) : (
            sequences.map((step, idx) => {
              const subject = step.subject ?? step.variants?.[0]?.subject ?? '';
              const body = stripHtml(step.body ?? step.variants?.[0]?.body);
              const waitDays = step.wait_days ?? (step.delay_unit === 'days' ? step.delay ?? null : null);
              const num = String(idx + 1).padStart(2, '0');
              return (
                <div key={idx} className="neu-sm overflow-hidden">
                  <div className="px-3 sm:px-5 py-3 sm:py-4 flex items-center gap-3">
                    <span className="ds-mono text-xs font-semibold shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
                      {num}
                      <span aria-hidden> → </span>
                    </span>
                    <div className="flex-1 min-w-0">
                      {subject && (
                        <p className="text-xs sm:text-sm font-semibold truncate" style={{ color: 'var(--cp-paper)' }}>
                          {subject}
                        </p>
                      )}
                      {step.variants && step.variants.length > 1 && (
                        <p className="ds-mono text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                          {step.variants.length} варианта
                        </p>
                      )}
                    </div>
                    {waitDays != null && waitDays > 0 && (
                      <span className="ds-mono text-[10px] sm:text-[11px] shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
                        {waitDays}д
                      </span>
                    )}
                  </div>
                  {body && (
                    <>
                      <hr className="neu-divider mx-3 sm:mx-5" />
                      <div className="px-3 sm:px-5 py-3 sm:py-4">
                        <pre className="text-[11px] sm:text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto" style={{ color: 'var(--cp-paper-mute)' }}>
                          {body}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
