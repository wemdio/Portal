'use client';

/**
 * Client campaigns list — the landing route /client.
 *
 * Editorial dark table of all the client's campaigns with sort, filter, and
 * search. Closes all 6 findings from /impeccable critique 2026-05-24
 * (baseline 24/40 OK):
 *   harden  — retry button inside the error banner (was dead-end)
 *   clarify — column labels fully Russian («% открытий», «% ответов»)
 *   shape   — inline pill row (Все / Активные / Пауза / Завершённые) + URL
 *             search, wired to ?status= and ?q= just like /client/replies
 *   clarify — dot legend inline below the summary line + title= tooltips
 *   shape   — persistent «+ Создать» CTA in the header (was only in empty)
 *   quieter — dropped the 900ms loading theatre (400ms count-up + 500ms
 *             "savor" pause); now: indeterminate spinner only when load
 *             takes >300ms, no fabricated waits
 *
 * Plus 11–14 plural exception fix in the summary line.
 */

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, Plus, Search, X, RefreshCw } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { OnboardingBanner } from '@/components/client/OnboardingBanner';

// Flat row returned by /api/client/campaigns (data comes from DB, analytics inline)
interface CampaignRow {
  id: string;
  name: string;
  status: number | null;
  emails_sent_count: number | null;
  open_count: number | null;
  reply_count: number | null;
  new_leads_contacted_count: number | null;
  analytics_synced_at: string | null;
}

interface CampaignsResponse {
  total: number;
  campaigns: CampaignRow[];
  lastSyncedAt: string | null;
}

type SortCol = 'name' | 'sent' | 'opened' | 'openRate' | 'replied' | 'replyRate';
type SortDir = 'asc' | 'desc';

type StatusFilter = 'all' | 'active' | 'paused' | 'done';

const STATUS_FILTERS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'active', label: 'Активные' },
  { key: 'paused', label: 'Пауза' },
  { key: 'done', label: 'Завершённые' },
];

const STATUS_LABEL: Record<number, string> = {
  1: 'активная',
  2: 'на паузе',
  3: 'завершена',
};

// Status int → 6px dot colour. Semantic: green = active, amber = paused,
// paper-faint = done / preparation. Matches dashboard's statusInfo.
function statusDot(status: number | null): string {
  switch (status) {
    case 1:
      return 'var(--cp-green)';
    case 2:
      return 'var(--cp-amber)';
    case 3:
    default:
      return 'var(--cp-paper-faint)';
  }
}

function statusTitle(status: number | null): string {
  if (status === null) return 'статус неизвестен';
  return STATUS_LABEL[status] ?? 'подготовка';
}

/** Russian noun pluralization with 11-14 exception (1 / 2-4 / 5+). */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span className="inline-flex flex-col ml-1 -mb-px" aria-hidden>
      <svg width="8" height="5" viewBox="0 0 8 5" style={{ opacity: active && dir === 'asc' ? 1 : 0.25 }}>
        <path d="M4 0L8 5H0L4 0Z" fill="currentColor" />
      </svg>
      <svg width="8" height="5" viewBox="0 0 8 5" style={{ opacity: active && dir === 'desc' ? 1 : 0.25 }}>
        <path d="M4 5L0 0H8L4 5Z" fill="currentColor" />
      </svg>
    </span>
  );
}

// Quiet indeterminate loader. No artificial count-up, no «savor the moment»
// pause — those added 900ms of fabricated wait per page open. Shown only
// after a 300ms grace period (see CampaignsPageContent), so a fast API
// doesn't flash a spinner at all.
function LoadingProgress() {
  return (
    <div className="flex flex-col items-center gap-4 py-16">
      <p className="ds-mono text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
        Загружаем кампании…
      </p>
      <div
        className="w-64 sm:w-80 overflow-hidden rounded-full"
        style={{ height: '2px', background: 'var(--cp-divider)' }}
      >
        <div
          className="h-full"
          style={{
            width: '40%',
            background: 'var(--cp-paper)',
            animation: 'cp-slide 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <style>{`
        @keyframes cp-slide {
          0%   { transform: translateX(-150%); }
          50%  { transform: translateX(200%); }
          100% { transform: translateX(-150%); }
        }
      `}</style>
    </div>
  );
}

function formatSyncedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function CampaignsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-driven filter + query — mirrors /client/replies pattern so a
  // filtered/searched view is shareable and browser back walks filters.
  const rawStatus = searchParams.get('status');
  const status: StatusFilter =
    rawStatus === 'active' || rawStatus === 'paused' || rawStatus === 'done'
      ? rawStatus
      : 'all';
  const query = searchParams.get('q') ?? '';

  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState('');
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [searchInput, setSearchInput] = useState(query);

  const handleSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'name' ? 'asc' : 'desc');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<CampaignsResponse>('/campaigns');
      setCampaigns(data.campaigns ?? []);
      setLastSyncedAt(data.lastSyncedAt ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 300ms grace period before showing the spinner — fast APIs (cached
  // navigations, warm Next cache) skip the loading state entirely.
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const t = setTimeout(() => setShowLoading(true), 300);
    return () => clearTimeout(t);
  }, [loading]);

  // Debounce search input → URL.
  useEffect(() => {
    if (searchInput === query) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      const trimmed = searchInput.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
      const qs = params.toString();
      router.replace(`/client${qs ? `?${qs}` : ''}`);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, query, searchParams, router]);

  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'all') params.delete('status');
      else params.set('status', next);
      const qs = params.toString();
      router.replace(`/client${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const clearSearch = useCallback(() => {
    setSearchInput('');
    const params = new URLSearchParams(searchParams);
    params.delete('q');
    const qs = params.toString();
    router.replace(`/client${qs ? `?${qs}` : ''}`);
  }, [router, searchParams]);

  const clearAll = useCallback(() => {
    setSearchInput('');
    router.replace('/client');
  }, [router]);

  // Apply filter + search to the raw list. Sort happens later on the rows
  // with derived metrics.
  const filteredCampaigns = useMemo(() => {
    let rows = campaigns;
    if (status !== 'all') {
      const wantedStatus =
        status === 'active' ? 1 : status === 'paused' ? 2 : 3;
      rows = rows.filter((c) => c.status === wantedStatus);
    }
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((c) => c.name.toLowerCase().includes(q));
    }
    return rows;
  }, [campaigns, status, query]);

  const hasFilter = status !== 'all' || query.length > 0;

  // Totals reflect the FILTERED set so the summary line tells the truth
  // about what's visible. Pre-filter total surfaced separately if hasFilter.
  const totals = filteredCampaigns.reduce<{
    sent: number;
    opened: number;
    replied: number;
    contacted: number;
  }>(
    (acc, c) => ({
      sent: acc.sent + Number(c.emails_sent_count ?? 0),
      opened: acc.opened + Number(c.open_count ?? 0),
      replied: acc.replied + Number(c.reply_count ?? 0),
      contacted: acc.contacted + Number(c.new_leads_contacted_count ?? 0),
    }),
    { sent: 0, opened: 0, replied: 0, contacted: 0 },
  );

  const openRate = totals.sent > 0 ? ((totals.opened / totals.sent) * 100).toFixed(1) : '0';
  const replyRate = totals.contacted > 0 ? ((totals.replied / totals.contacted) * 100).toFixed(1) : '0';

  const sortedRows = useMemo(
    () =>
      filteredCampaigns
        .map((c) => {
          const sent = Number(c.emails_sent_count ?? 0);
          const opened = Number(c.open_count ?? 0);
          const replied = Number(c.reply_count ?? 0);
          const contacted = Number(c.new_leads_contacted_count ?? 0);
          const openRateVal = sent > 0 ? (opened / sent) * 100 : 0;
          const replyRateVal = contacted > 0 ? (replied / contacted) * 100 : 0;
          return { c, sent, opened, replied, openRateVal, replyRateVal };
        })
        .sort((x, y) => {
          let cmp = 0;
          if (sortCol === 'name') cmp = x.c.name.localeCompare(y.c.name, 'ru');
          else if (sortCol === 'sent') cmp = x.sent - y.sent;
          else if (sortCol === 'opened') cmp = x.opened - y.opened;
          else if (sortCol === 'openRate') cmp = x.openRateVal - y.openRateVal;
          else if (sortCol === 'replied') cmp = x.replied - y.replied;
          else if (sortCol === 'replyRate') cmp = x.replyRateVal - y.replyRateVal;
          return sortDir === 'asc' ? cmp : -cmp;
        }),
    [filteredCampaigns, sortCol, sortDir],
  );

  const syncedLabel = formatSyncedAt(lastSyncedAt);
  const hasAnyCampaigns = campaigns.length > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <OnboardingBanner />

      <header className="mb-6 sm:mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          {/* Page eyebrow — sync with the sidebar's group numbering. Мониторинг
              is the second group in CLIENT_NAV_GROUPS (after Старт), so the
              sidebar renders «02 → Мониторинг». Page header must match —
              otherwise the user sees the same section labelled differently in
              two places. Flagged on the 2026-05-26 /client screenshot. */}
          <p className="ds-eyebrow mb-2">
            02<span aria-hidden> → </span>Мониторинг
          </p>
          <h1
            className="text-xl sm:text-2xl font-bold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Кампании
          </h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Статистика по вашим email-кампаниям
          </p>
        </div>
        {/* Right-aligned actions — only when the list has campaigns. On an
            empty state the inline CTA at the bottom of the empty block is
            the single primary action; surfacing «+ Создать» twice was a
            duplicate-CTA finding on the 2026-05-26 screenshot. During load
            (campaigns array still empty) we also hide it to avoid flash. */}
        {hasAnyCampaigns && (
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <Link
              href={'/client/launch' as Route}
              className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Создать
            </Link>
            {!loading && syncedLabel && (
              <p
                className="ds-mono text-[11px]"
                style={{ color: 'var(--cp-paper-faint)' }}
              >
                обновлено {syncedLabel}
              </p>
            )}
          </div>
        )}
      </header>

      {error && (
        <div
          className="neu-card mb-6 px-5 py-3.5 text-sm font-medium flex items-center gap-3"
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)' }}
          />
          <span className="flex-1" style={{ color: 'var(--cp-paper)' }}>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs shrink-0"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
        </div>
      )}

      {loading && showLoading ? (
        <LoadingProgress />
      ) : loading ? (
        // Fast path: API resolves under 300ms — show nothing, no flash.
        <div className="py-16" />
      ) : !hasAnyCampaigns ? (
        /* Distilled empty state — was a ~350px neu-card with icon + h2 + body
           + CTA for very little information value. Now: editorial centered
           sentence + primary CTA, no bg-card, no decorative icon. Trims ~60%
           of vertical footprint and stays in the editorial paper-on-ink
           voice. Flagged on the 2026-05-26 /client screenshot. */
        <div className="text-center py-10 sm:py-14 max-w-md mx-auto">
          <p
            className="text-sm sm:text-base mb-5 leading-relaxed"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            <span style={{ color: 'var(--cp-paper)' }} className="font-semibold">
              Кампаний пока нет.
            </span>
            {' '}Запустите первую — мы покажем здесь её метрики (отправки,
            открытия, ответы) в реальном времени.
          </p>
          <Link
            href={'/client/launch' as Route}
            className="ds-btn-primary inline-flex items-center gap-2 px-5"
          >
            Создать кампанию
          </Link>
        </div>
      ) : (
        <>
          {/* Filter strip — status pills + search input. Wired to URL params
              so a filtered/searched view is shareable. */}
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div
              className="flex gap-1.5 shrink-0"
              role="tablist"
              aria-label="Фильтр кампаний"
            >
              {STATUS_FILTERS.map(({ key, label }) => {
                const active = status === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    role="tab"
                    aria-selected={active}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors"
                    style={
                      active
                        ? {
                            color: 'var(--cp-paper)',
                            background: 'var(--cp-surface-elev)',
                            border: '1px solid var(--cp-divider-strong)',
                          }
                        : {
                            color: 'var(--cp-paper-mute)',
                            background: 'transparent',
                            border: '1px solid var(--cp-divider)',
                          }
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="sm:flex-1 relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none"
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Поиск по названию кампании"
                className="ds-input w-full pl-9 pr-9 py-1.5 text-xs"
                style={{ color: 'var(--cp-paper)' }}
                aria-label="Поиск по кампаниям"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-label="Очистить поиск"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Editorial summary + dot legend. Summary line totals the FILTERED
              set so it tells the truth about what's visible. */}
          <p
            className="ds-mono text-xs mb-1"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {totals.sent.toLocaleString('ru-RU')} отправлено
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            {openRate}% открытий
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            {replyRate}% ответов
            <span style={{ color: 'var(--cp-paper-faint)' }}>
              {' · '}
              {totals.replied.toLocaleString('ru-RU')}{' '}
              {plural(totals.replied, 'ответ', 'ответа', 'ответов')}
              {hasFilter
                ? ` в выборке (${filteredCampaigns.length} из ${campaigns.length} ${plural(campaigns.length, 'кампания', 'кампании', 'кампаний')})`
                : ' всего'}
            </span>
          </p>

          {/* Dot legend — gives the status colors a name without forcing the
              user to learn them by hovering rows. */}
          <p
            className="ds-mono text-[11px] mb-5 sm:mb-6 flex flex-wrap items-center gap-x-3 gap-y-1"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="ds-status-dot" style={{ background: 'var(--cp-green)' }} />
              активные
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="ds-status-dot" style={{ background: 'var(--cp-amber)' }} />
              пауза
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="ds-status-dot" style={{ background: 'var(--cp-paper-faint)' }} />
              завершённые
            </span>
          </p>

          {/* Filtered empty state — explain context, offer a clear-all CTA. */}
          {sortedRows.length === 0 && hasFilter && (
            <div className="neu-card py-10 text-center px-6">
              <Mail
                className="mx-auto h-6 w-6 mb-3"
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              />
              <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-paper)' }}>
                {status === 'active'
                  ? 'Нет активных кампаний'
                  : status === 'paused'
                    ? 'Нет кампаний на паузе'
                    : status === 'done'
                      ? 'Нет завершённых кампаний'
                      : `Ничего не найдено по запросу «${query}»`}
              </p>
              <p className="text-xs mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
                Попробуйте изменить фильтр или сбросить поиск.
              </p>
              <button
                type="button"
                onClick={clearAll}
                className="ds-btn-secondary inline-flex items-center gap-1.5 px-4 py-2 text-xs"
              >
                <X className="h-3 w-3" aria-hidden />
                Сбросить фильтр
              </button>
            </div>
          )}

          {/* Mobile: card list with status dot + mono metrics summary */}
          {sortedRows.length > 0 && (
            <div className="space-y-2 sm:hidden">
              {sortedRows.map(({ c, sent, openRateVal, replyRateVal }) => {
                const or_ = openRateVal.toFixed(1);
                const rr = replyRateVal.toFixed(1);
                return (
                  <Link
                    key={c.id}
                    href={`/client/campaigns/${c.id}` as Route}
                    className="ds-card-pressable block p-4 rounded-lg"
                    style={{
                      background: 'var(--cp-surface-rest)',
                      border: '1px solid var(--cp-divider)',
                    }}
                  >
                    <div className="flex items-center gap-2.5 mb-1.5">
                      <span
                        aria-hidden
                        title={statusTitle(c.status)}
                        className="ds-status-dot"
                        style={{ background: statusDot(c.status) }}
                      />
                      <p
                        className="text-sm font-semibold truncate flex-1"
                        style={{ color: 'var(--cp-paper)' }}
                      >
                        {c.name}
                      </p>
                    </div>
                    <p
                      className="ds-mono text-[11px] pl-4"
                      style={{ color: 'var(--cp-paper-mute)' }}
                    >
                      {sent.toLocaleString('ru-RU')} отправлено
                      <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
                      {or_}% откр
                      <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
                      {rr}% отв
                    </p>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Desktop: sortable table. Headers in editorial mono; numeric body
              cells in JetBrains Mono for tabular alignment. */}
          {sortedRows.length > 0 && (
            <div
              className="hidden sm:block rounded-lg overflow-hidden"
              style={{
                background: 'var(--cp-surface-rest)',
                border: '1px solid var(--cp-divider)',
              }}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--cp-surface-elev)' }}>
                      {(
                        [
                          { col: 'name' as SortCol, label: 'Кампания', align: 'left' },
                          { col: 'sent' as SortCol, label: 'Отправлено', align: 'right' },
                          { col: 'opened' as SortCol, label: 'Открытия', align: 'right' },
                          { col: 'openRate' as SortCol, label: '% открытий', align: 'right' },
                          { col: 'replied' as SortCol, label: 'Ответы', align: 'right' },
                          { col: 'replyRate' as SortCol, label: '% ответов', align: 'right' },
                        ] as const
                      ).map(({ col, label, align }) => (
                        <th
                          key={col}
                          onClick={() => handleSort(col)}
                          className={`ds-eyebrow px-5 py-3 text-${align} cursor-pointer select-none whitespace-nowrap`}
                          style={{
                            color:
                              sortCol === col
                                ? 'var(--cp-paper)'
                                : 'var(--cp-paper-faint)',
                            fontWeight: sortCol === col ? 600 : 500,
                          }}
                        >
                          {label}
                          <SortIcon active={sortCol === col} dir={sortDir} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map(({ c, sent, opened, replied, openRateVal, replyRateVal }, idx) => {
                      const or_ = openRateVal.toFixed(1);
                      const rr = replyRateVal.toFixed(1);
                      const rowBorder = idx > 0 ? '1px solid var(--cp-divider)' : 'none';
                      return (
                        <tr key={c.id} className="neu-row">
                          <td className="px-5 py-3" style={{ borderTop: rowBorder }}>
                            <div className="flex items-center gap-2.5">
                              <span
                                aria-hidden
                                title={statusTitle(c.status)}
                                className="ds-status-dot shrink-0"
                                style={{ background: statusDot(c.status) }}
                              />
                              <Link
                                href={`/client/campaigns/${c.id}` as Route}
                                className="font-semibold transition-colors hover:underline"
                                style={{ color: 'var(--cp-paper)' }}
                              >
                                {c.name}
                              </Link>
                            </div>
                          </td>
                          <td
                            className="ds-mono px-5 py-3 text-right"
                            style={{ borderTop: rowBorder, color: 'var(--cp-paper-mute)' }}
                          >
                            {sent.toLocaleString('ru-RU')}
                          </td>
                          <td
                            className="ds-mono px-5 py-3 text-right"
                            style={{ borderTop: rowBorder, color: 'var(--cp-paper-mute)' }}
                          >
                            {opened.toLocaleString('ru-RU')}
                          </td>
                          <td
                            className="ds-mono px-5 py-3 text-right"
                            style={{ borderTop: rowBorder, color: 'var(--cp-paper)', fontWeight: 600 }}
                          >
                            {or_}%
                          </td>
                          <td
                            className="ds-mono px-5 py-3 text-right"
                            style={{ borderTop: rowBorder, color: 'var(--cp-paper-mute)' }}
                          >
                            {replied}
                          </td>
                          <td
                            className="ds-mono px-5 py-3 text-right"
                            style={{ borderTop: rowBorder, color: 'var(--cp-paper)', fontWeight: 600 }}
                          >
                            {rr}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Suspense wrapper required because useSearchParams() opts the route into
 * client rendering; Next.js 16 wants an explicit boundary at the route
 * level (matches /client/replies setup).
 */
export default function ClientCampaignsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl">
          <div className="py-16" />
        </div>
      }
    >
      <CampaignsPageContent />
    </Suspense>
  );
}
