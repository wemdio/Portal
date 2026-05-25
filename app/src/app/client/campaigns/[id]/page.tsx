'use client';

/**
 * Single campaign detail view.
 *
 * Reached from /client (campaigns list) or /client/dashboard. Tabs:
 *   Обзор — editorial ledger (была 6-tile MetricCard grid = hero-metric
 *           template multiplied, absolute-ban; теперь one editorial sentence
 *           plus hairline-divided ledger) + per-step table
 *   Цепочка — sequence preview with editorial numbering
 *   Ответы — paginated replies list with search, expandable threads
 *
 * Closes all 6 findings from /impeccable critique 2026-05-24:
 *   P0 — 6-tile MetricCard grid → editorial sentence + ledger
 *   P1 — status dot inline в header (was raw text in eyebrow only)
 *   P1 — «Bounce» → «Отказы доставки» (was English on Russian page)
 *   P1 — Pause/Resume 2-tap confirm with 5s auto-clear (was instant)
 *   P2 — «Повторить» retry buttons in all 4 error blocks
 *   P2 — `var(--cp-text-l)` undefined token → `var(--cp-paper-mute)`
 *   P2 — `rgba(180,173,164,0.15)` warm-stone literal → `var(--cp-divider)`
 *   P3 — tab state lives in URL via `?tab=` (shareable, browser back works)
 */

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Pause, Play, Loader2, Search, ChevronDown, ChevronRight, Inbox, Sparkles,
  RefreshCw,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { ExpandedThread } from '@/components/client-replies/ExpandedThread';
import {
  CampaignStatus, CampaignStatusLabels,
  type Campaign, type CampaignAnalytics, type CampaignStepAnalytics, type SequenceStep,
} from '@/lib/instantly/types';
import type {
  ClientReply, ClientRepliesPage,
} from '@/lib/clientCampaignReplies/types';

// Map campaign status number → semantic dot color (Status-as-Data rule).
function statusDotColor(status: number): string {
  switch (status) {
    case CampaignStatus.Active:
      return 'var(--cp-green)';
    case CampaignStatus.Paused:
      return 'var(--cp-amber)';
    case CampaignStatus.Completed:
      return 'var(--cp-paper-faint)';
    default:
      return 'var(--cp-paper-faint)';
  }
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
  return d.toLocaleString('ru-RU', {
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
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  expandedReplyId: string | null;
  onToggleExpand: (id: string) => void;
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
  onRetry,
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
        <div className="neu-card px-4 py-3 text-xs flex items-center gap-3" role="alert">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)' }} />
          <span className="flex-1" style={{ color: 'var(--cp-paper)' }}>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-1 text-[11px]"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
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
        <div
          className="neu-card overflow-hidden divide-y"
          style={{ borderColor: 'var(--cp-divider)' }}
        >
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
                      <ChevronDown className="h-4 w-4" style={{ color: 'var(--cp-paper-mute)' }} />
                    ) : (
                      <ChevronRight className="h-4 w-4" style={{ color: 'var(--cp-paper-mute)' }} />
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
                    // Indent the expanded thread under the row's chevron
                    // prefix — without this override the default `mt-5`
                    // wrapping (used on standalone /replies and /leads
                    // pages) sits flush-left and looks unnested.
                    className="mt-3 pl-7 space-y-3"
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

/**
 * Editorial ledger row — replaces the per-stat MetricCard tile pattern.
 * Label on the left, optional percent in the middle column, mono number
 * tabular-nums far right. Hairline border on subsequent rows.
 */
function FunnelRow({
  label,
  value,
  percent,
  isFirst,
  emphasized,
}: {
  label: string;
  value: number;
  percent?: string;
  isFirst?: boolean;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline gap-3 py-3 ${isFirst ? '' : 'border-t'}`}
      style={isFirst ? undefined : { borderTopColor: 'var(--cp-divider)' }}
    >
      <p
        className={`text-sm flex-1 ${emphasized ? 'font-semibold' : ''}`}
        style={{ color: emphasized ? 'var(--cp-paper)' : 'var(--cp-paper-mute)' }}
      >
        {label}
      </p>
      {percent && (
        <span
          className="ds-mono tabular-nums text-xs shrink-0"
          style={{ color: 'var(--cp-paper-mute)', minWidth: '4rem', textAlign: 'right' }}
        >
          {percent}
        </span>
      )}
      <span
        className={`ds-mono tabular-nums shrink-0 ${emphasized ? 'text-base font-semibold' : 'text-sm'}`}
        style={{ color: 'var(--cp-paper)', minWidth: '5rem', textAlign: 'right' }}
      >
        {value.toLocaleString('ru-RU')}
      </span>
    </div>
  );
}

function CampaignDetailPageContent() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-driven tab — shareable via ?tab=replies, browser back walks tabs.
  const rawTab = searchParams.get('tab');
  const tab: 'overview' | 'steps' | 'replies' =
    rawTab === 'steps' || rawTab === 'replies' ? rawTab : 'overview';

  const setTab = useCallback(
    (next: 'overview' | 'steps' | 'replies') => {
      const params = new URLSearchParams(searchParams);
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      const qs = params.toString();
      router.replace(`/client/campaigns/${campaignId}${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams, campaignId],
  );

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [steps, setSteps] = useState<CampaignStepAnalytics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Pause/Resume confirm — two-tap inline. First click arms the action,
  // second click within 5s fires it; otherwise auto-cancel. Prevents
  // accidental mid-send pauses on this irreversible API.
  const [pendingToggle, setPendingToggle] = useState<'pause' | 'activate' | null>(null);
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

  // Auto-clear pending confirm after 5s (or when state changes).
  useEffect(() => {
    if (!pendingToggle) return;
    const t = setTimeout(() => setPendingToggle(null), 5000);
    return () => clearTimeout(t);
  }, [pendingToggle]);

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

  const handleRepliesRetry = useCallback(() => {
    void loadReplies('reset');
  }, [loadReplies]);

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

  const armToggle = useCallback((type: 'pause' | 'activate') => {
    setActionError('');
    setPendingToggle(type);
  }, []);

  const confirmToggle = useCallback(() => {
    if (!pendingToggle) return;
    const action = pendingToggle;
    setPendingToggle(null);
    void handleToggle(action);
  }, [pendingToggle, handleToggle]);

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
        <div className="neu-card px-5 py-4 text-sm font-medium flex items-center gap-3" role="alert">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)' }} />
          <span className="flex-1" style={{ color: 'var(--cp-paper)' }}>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
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
  const leadsCount = Number(analytics?.leads_count ?? 0);
  const openRate = sentCount > 0 ? ((openCount / sentCount) * 100).toFixed(1) : '0';
  const replyRate = contactedCount > 0 ? ((replyCount / contactedCount) * 100).toFixed(1) : '0';

  const sequences: SequenceStep[] = (campaign.sequences ?? []).flatMap((s) => s.steps ?? []);

  const statusLabel = CampaignStatusLabels[campaign.status] ?? `Статус ${campaign.status}`;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={'/client' as Route}
        className="inline-flex items-center gap-1 text-xs font-medium mb-5 underline-offset-2 hover:underline"
        style={{ color: 'var(--cp-paper-mute)' }}
      >
        ← Кампании
      </Link>

      <header className="mb-5 sm:mb-6">
        <p className="ds-eyebrow mb-2">
          <span className="ds-mono">{campaign.id.slice(0, 8)}</span>
        </p>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1
              className="text-lg sm:text-xl font-bold break-words m-0"
              style={{ color: 'var(--cp-paper)' }}
            >
              {campaign.name}
            </h1>
            {/* Status dot + label inline — was raw text in eyebrow only,
                forcing the user to read instead of scan. */}
            <p className="mt-1 inline-flex items-center gap-1.5 text-sm" style={{ color: statusDotColor(campaign.status) }}>
              <span
                aria-hidden
                className="ds-status-dot"
                style={{ background: statusDotColor(campaign.status) }}
              />
              {statusLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {campaign.status === CampaignStatus.Active && (
              pendingToggle === 'pause' ? (
                // Confirm state — 5s auto-clear, two-tap to fire
                <>
                  <button
                    type="button"
                    onClick={confirmToggle}
                    disabled={actionPending !== null}
                    className="ds-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {actionPending === 'pause' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Pause className="h-3.5 w-3.5" aria-hidden />
                    )}
                    Подтвердить пауза
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingToggle(null)}
                    disabled={actionPending !== null}
                    className="ds-btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    Отмена
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => armToggle('pause')}
                  disabled={actionPending !== null}
                  className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  <Pause className="h-3.5 w-3.5" aria-hidden />
                  Пауза
                </button>
              )
            )}
            {campaign.status === CampaignStatus.Paused && (
              pendingToggle === 'activate' ? (
                <>
                  <button
                    type="button"
                    onClick={confirmToggle}
                    disabled={actionPending !== null}
                    className="ds-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {actionPending === 'activate' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Play className="h-3.5 w-3.5" aria-hidden />
                    )}
                    Подтвердить запуск
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingToggle(null)}
                    disabled={actionPending !== null}
                    className="ds-btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    Отмена
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => armToggle('activate')}
                  disabled={actionPending !== null}
                  className="ds-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  Запустить
                </button>
              )
            )}
          </div>
        </div>
      </header>

      {actionError && (
        <div className="text-xs mb-4 flex items-center gap-2">
          <span aria-hidden className="ds-status-dot shrink-0" style={{ background: 'var(--cp-red)' }} />
          <span className="flex-1" style={{ color: 'var(--cp-paper)' }}>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError('')}
            className="ds-btn-ghost px-2 py-0.5 text-[11px]"
          >
            Закрыть
          </button>
        </div>
      )}

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
          {/* Editorial summary — one honest sentence answers "what is this
              campaign doing?" with mono numbers inline. Replaces the 6-tile
              MetricCard grid (hero-metric template multiplied = absolute ban). */}
          <p
            className="text-sm mb-5 sm:mb-6"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Кампания отправила{' '}
            <span className="ds-mono tabular-nums font-semibold" style={{ color: 'var(--cp-paper)' }}>
              {sentCount.toLocaleString('ru-RU')}
            </span>
            {' '}писем, открыли{' '}
            <span className="ds-mono tabular-nums font-semibold" style={{ color: 'var(--cp-paper)' }}>
              {openRate}%
            </span>
            , ответили{' '}
            <span className="ds-mono tabular-nums font-semibold" style={{ color: 'var(--cp-paper)' }}>
              {replyRate}%
            </span>
            .
          </p>

          {/* Ledger of all metrics — hairline-divided rows, no per-row cards.
              First row (most actionable) emphasized; others quiet. */}
          <section className="neu-card px-4 sm:px-5 mb-4 sm:mb-6" aria-labelledby="funnel-label">
            <header className="py-3 mb-1 border-b" style={{ borderColor: 'var(--cp-divider)' }}>
              <p id="funnel-label" className="ds-eyebrow">воронка</p>
            </header>
            <FunnelRow
              label="Письма отправлены"
              value={sentCount}
              isFirst
              emphasized
            />
            <FunnelRow
              label="Уникальные открытия"
              value={openCount}
              percent={sentCount > 0 ? `${openRate}%` : undefined}
            />
            <FunnelRow
              label="Уникальные ответы"
              value={replyCount}
              percent={contactedCount > 0 ? `${replyRate}%` : undefined}
            />
            <FunnelRow
              label="Контакты в работе"
              value={contactedCount}
            />
            <FunnelRow
              label="Помечено лидами"
              value={leadsCount}
            />
            <FunnelRow
              label="Отказы доставки"
              value={bouncedCount}
            />
          </section>

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
          onRetry={handleRepliesRetry}
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
              <p className="text-sm mb-4" style={{ color: 'var(--cp-paper-mute)' }}>Цепочка не настроена</p>
              <Link
                href={'/client/launch' as Route}
                className="ds-btn-secondary inline-flex items-center gap-1.5 px-4 py-2 text-xs"
              >
                Настроить через запуск
              </Link>
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

/**
 * Suspense wrapper — useSearchParams() opts the route into client rendering
 * and Next.js 16 wants an explicit boundary at the route level (matches
 * the pattern in /client/replies, /client and /client/launch).
 */
export default function ClientCampaignDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-32">
          <div className="neu-spinner animate-spin" />
        </div>
      }
    >
      <CampaignDetailPageContent />
    </Suspense>
  );
}
