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
      <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>{label}</p>
      <p className="mt-1 sm:mt-1.5 text-lg sm:text-xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] sm:text-xs" style={{ color: 'var(--cp-text-m)' }}>{sub}</p>}
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
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загружаем тред…
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
  return (
    <div className="neu-sm px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        {isInbound ? (
          <ArrowDownLeft className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cp-accent)' }} />
        ) : (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
        )}
        <span className="text-[10px] uppercase tracking-wider font-bold shrink-0" style={{ color: isInbound ? 'var(--cp-accent)' : 'var(--cp-text-l)' }}>
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
        placeholder="Текст ответа…"
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
        <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSearch();
          }}
          placeholder="Поиск по тексту, теме, email…"
          className="flex-1 bg-transparent outline-none text-xs sm:text-sm"
          style={{ color: 'var(--cp-text-d)' }}
        />
        <button
          type="button"
          onClick={onSearch}
          disabled={loading}
          className="neu-pill px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
          style={{ color: 'var(--cp-text-m)' }}
        >
          Найти
        </button>
      </div>

      {error && (
        <div className="neu-inset rounded-2xl px-4 py-3 text-xs" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </div>
      )}

      {loaded && !loading && replies.length === 0 && !error && (
        <div className="neu-card py-14 text-center">
          <Inbox className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--cp-text-l)' }} />
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
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
                        <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-bold" style={{ background: 'var(--cp-accent)', color: '#fff' }}>
                          new
                        </span>
                      )}
                      {r.ai_interest_value !== null && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md neu-well" style={{ color: 'var(--cp-text-m)' }}>
                          <Sparkles className="h-2.5 w-2.5" />
                          {r.ai_interest_value}
                        </span>
                      )}
                      <span className="text-[10px] sm:text-[11px] shrink-0" style={{ color: 'var(--cp-text-l)' }}>
                        {formatReplyDate(r.timestamp)}
                      </span>
                    </div>
                    {r.subject && (
                      <p className="mt-1 text-[11px] sm:text-xs truncate" style={{ color: 'var(--cp-text-m)' }}>
                        {r.subject}
                      </p>
                    )}
                    {!expanded && r.content_preview && (
                      <p className="mt-1 text-[11px] sm:text-xs line-clamp-2" style={{ color: 'var(--cp-text-l)' }}>
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
            className="neu-pill px-5 py-2 text-xs font-semibold"
            style={{ color: 'var(--cp-text-m)' }}
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
        <Link href={'/client' as Route} className="inline-flex items-center gap-1 text-xs font-medium mb-4 transition-colors" style={{ color: 'var(--cp-text-m)' }}>
          ← Кампании
        </Link>
        <div className="neu-inset rounded-2xl px-5 py-4 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>{error}</div>
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
        className="inline-flex items-center gap-1 text-xs font-medium mb-5 transition-colors"
        style={{ color: 'var(--cp-text-m)' }}
        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--cp-accent)')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--cp-text-m)')}
      >
        ← Кампании
      </Link>

      <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
        <h1 className="text-lg sm:text-xl font-extrabold break-words flex-1 min-w-0">{campaign.name}</h1>
        <div className="flex items-center gap-2 shrink-0">
          <span className="neu-well px-3 py-1.5 text-[10px] sm:text-xs font-semibold" style={{ color: 'var(--cp-text-m)' }}>
            {CampaignStatusLabels[campaign.status] ?? `Статус ${campaign.status}`}
          </span>
          {campaign.status === CampaignStatus.Active && (
            <button
              type="button"
              onClick={() => handleToggle('pause')}
              disabled={actionPending !== null}
              className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ color: 'var(--cp-text-m)' }}
            >
              {actionPending === 'pause' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
              Пауза
            </button>
          )}
          {campaign.status === CampaignStatus.Paused && (
            <button
              type="button"
              onClick={() => handleToggle('activate')}
              disabled={actionPending !== null}
              className="neu-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {actionPending === 'activate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Запустить
            </button>
          )}
        </div>
      </div>
      <p className="text-[10px] sm:text-xs mb-1 truncate" style={{ color: 'var(--cp-text-l)' }}>ID: {campaign.id}</p>
      {actionError && (
        <p className="text-xs mb-3" style={{ color: 'var(--cp-danger)' }}>{actionError}</p>
      )}
      <div className="mb-4 sm:mb-6" />

      <div className="flex gap-2 mb-4 sm:mb-6">
        {(['overview', 'steps', 'replies'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`neu-pill px-5 py-2 text-xs font-semibold ${tab === t ? 'active' : ''}`}
            style={tab !== t ? { color: 'var(--cp-text-m)' } : undefined}
          >
            {t === 'overview' ? 'Обзор' : t === 'steps' ? 'Цепочка' : 'Ответы'}
            {t === 'replies' && replyCount > 0 && (
              <span className="ml-1.5 text-[10px] opacity-70">({replyCount})</span>
            )}
          </button>
        ))}
      </div>

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
              <h3 className="px-3 sm:px-5 py-3 sm:py-4 text-xs sm:text-sm font-bold" style={{ color: 'var(--cp-text-m)' }}>
                Статистика по шагам
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-left text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Шаг</th>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-right text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Отпр.</th>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-right text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Откр.</th>
                      <th className="px-3 sm:px-5 py-2.5 sm:py-3 text-right text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Отв.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((s, i) => (
                      <tr key={i} className="neu-row" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3" style={{ color: 'var(--cp-text-m)' }}>
                          Step {s.step}{s.variant ? ` (${String.fromCharCode(65 + Number(s.variant))})` : ''}
                        </td>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-text-m)' }}>{s.sent ?? 0}</td>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-text-m)' }}>{s.unique_opened ?? s.opened ?? 0}</td>
                        <td className="px-3 sm:px-5 py-2.5 sm:py-3 text-right" style={{ color: 'var(--cp-text-m)' }}>{s.unique_replies ?? s.replies ?? 0}</td>
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
        <div className="space-y-4">
          {sequences.length === 0 ? (
            <div className="neu-card py-14 text-center">
              <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Цепочка не настроена</p>
            </div>
          ) : (
            sequences.map((step, idx) => {
              const subject = step.subject ?? step.variants?.[0]?.subject ?? '';
              const body = stripHtml(step.body ?? step.variants?.[0]?.body);
              const waitDays = step.wait_days ?? (step.delay_unit === 'days' ? step.delay ?? null : null);
              return (
                <div key={idx} className="neu-sm overflow-hidden">
                  <div className="px-3 sm:px-5 py-3 sm:py-4 flex items-center gap-2.5 sm:gap-3">
                    <div className="neu-well flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center text-[10px] sm:text-xs font-bold shrink-0" style={{ color: 'var(--cp-accent)' }}>
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      {subject && <p className="text-xs sm:text-sm font-semibold truncate">{subject}</p>}
                      {step.variants && step.variants.length > 1 && (
                        <p className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>{step.variants.length} варианта</p>
                      )}
                    </div>
                    {waitDays != null && waitDays > 0 && (
                      <span className="text-[10px] sm:text-[11px] font-medium shrink-0" style={{ color: 'var(--cp-text-l)' }}>
                        {waitDays}д
                      </span>
                    )}
                  </div>
                  {body && (
                    <>
                      <hr className="neu-divider mx-3 sm:mx-5" />
                      <div className="px-3 sm:px-5 py-3 sm:py-4">
                        <pre className="text-[11px] sm:text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto" style={{ color: 'var(--cp-text-m)' }}>
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
