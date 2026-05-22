'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Mail } from 'lucide-react';
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

function SortIcon({ col, active, dir }: { col: string; active: boolean; dir: SortDir }) {
  void col;
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

// Hairline progress bar + "загружено x из y" counter. No gradients — just a
// paper-white fill on a divider track, matching the editorial-flat language.
function LoadingProgress({ loaded, total }: { loaded: number; total: number | null }) {
  const isDone = total !== null && loaded >= total;
  const pct = total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;

  return (
    <div className="flex flex-col items-center gap-4 py-16">
      <p
        className="ds-mono text-xs"
        style={{ color: 'var(--cp-paper-mute)' }}
      >
        {isDone
          ? `Загружено ${loaded} из ${total}`
          : total !== null
            ? `Загружаем кампании · ${loaded} из ${total}`
            : 'Загружаем кампании…'}
      </p>

      <div
        className="w-64 sm:w-80 overflow-hidden rounded-full"
        style={{ height: '2px', background: 'var(--cp-divider)' }}
      >
        {total === null ? (
          <div
            className="h-full"
            style={{
              width: '40%',
              background: 'var(--cp-paper)',
              animation: 'cp-slide 1.4s ease-in-out infinite',
            }}
          />
        ) : (
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, background: 'var(--cp-paper)' }}
          />
        )}
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

export default function ClientCampaignsPage() {
  const [loading, setLoading] = useState(true);
  const [loadedCount, setLoadedCount] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // Track whether we've already shown the "done" flash to avoid re-triggering
  const doneRef = useRef(false);

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
    setLoadedCount(0);
    setTotal(null);
    setError('');
    doneRef.current = false;

    try {
      const data = await clientApiFetch<CampaignsResponse>('/campaigns');
      const rows = data.campaigns ?? [];
      setTotal(data.total ?? rows.length);
      // Animate count from 0 → rows.length in ~400 ms
      const steps = Math.min(rows.length, 20);
      for (let i = 1; i <= steps; i++) {
        await new Promise<void>((r) => setTimeout(r, 400 / steps));
        setLoadedCount(Math.round((rows.length / steps) * i));
      }
      setLoadedCount(rows.length);
      setCampaigns(rows);
      setLastSyncedAt(data.lastSyncedAt ?? null);
      // Brief pause so "Загружено N из N" is visible before revealing content
      await new Promise<void>((r) => setTimeout(r, 500));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = campaigns.reduce<{ sent: number; opened: number; replied: number; contacted: number }>(
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

  const sortedRows = [...campaigns]
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
    });

  const syncedLabel = formatSyncedAt(lastSyncedAt);
  const hasCampaigns = campaigns.length > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <OnboardingBanner />

      <header className="mb-6 sm:mb-8 flex items-end justify-between gap-4">
        <div>
          <p className="ds-eyebrow mb-2">
            01<span aria-hidden> → </span>Мониторинг
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
        {!loading && syncedLabel && (
          <p
            className="ds-mono text-[11px] shrink-0"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            обновлено {syncedLabel}
          </p>
        )}
      </header>

      {error && (
        <div
          className="neu-inset mb-6 rounded-lg px-5 py-3.5 text-sm font-medium flex items-start gap-2.5"
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)', marginTop: '7px' }}
          />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
        </div>
      )}

      {loading ? (
        <LoadingProgress loaded={loadedCount} total={total} />
      ) : !hasCampaigns ? (
        <div
          className="neu-card py-12 sm:py-16 text-center px-6"
        >
          <Mail
            className="mx-auto h-8 w-8 mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <p className="text-base sm:text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
            Кампаний пока нет
          </p>
          <p className="text-xs sm:text-sm max-w-md mx-auto mb-5" style={{ color: 'var(--cp-paper-mute)' }}>
            Запустите первую кампанию: загрузите базу, напишите цепочку и мы покажем
            здесь её метрики (отправки, открытия, ответы) в реальном времени.
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
          {/* Mono summary — single editorial line over the table. Replaces the
              5 rainbow MetricCards (side-stripes + colored icons + hero-metric
              template, all DESIGN.md Don'ts). */}
          <p
            className="ds-mono text-xs mb-5 sm:mb-6"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {totals.sent.toLocaleString('ru-RU')} отправлено
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            {openRate}% открытий
            <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
            {replyRate}% ответов
            <span style={{ color: 'var(--cp-paper-faint)' }}>
              {' · '}
              {totals.replied} {totals.replied === 1 ? 'ответ' : totals.replied < 5 ? 'ответа' : 'ответов'} всего
            </span>
          </p>

          {/* Mobile: card list with status dot + mono metrics summary */}
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

          {/* Desktop: sortable table. Headers in editorial mono; numeric body
              cells in JetBrains Mono for tabular alignment. */}
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
                        { col: 'openRate' as SortCol, label: 'Open %', align: 'right' },
                        { col: 'replied' as SortCol, label: 'Ответы', align: 'right' },
                        { col: 'replyRate' as SortCol, label: 'Reply %', align: 'right' },
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
                        <SortIcon col={col} active={sortCol === col} dir={sortDir} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(({ c, sent, opened, replied, openRateVal, replyRateVal }, idx) => {
                    const or_ = openRateVal.toFixed(1);
                    const rr = replyRateVal.toFixed(1);
                    const rowBorder =
                      idx > 0 ? '1px solid var(--cp-divider)' : 'none';
                    return (
                      <tr
                        key={c.id}
                        className="neu-row"
                      >
                        <td
                          className="px-5 py-3"
                          style={{ borderTop: rowBorder }}
                        >
                          <div className="flex items-center gap-2.5">
                            <span
                              aria-hidden
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
                          style={{
                            borderTop: rowBorder,
                            color: 'var(--cp-paper-mute)',
                          }}
                        >
                          {sent.toLocaleString('ru-RU')}
                        </td>
                        <td
                          className="ds-mono px-5 py-3 text-right"
                          style={{
                            borderTop: rowBorder,
                            color: 'var(--cp-paper-mute)',
                          }}
                        >
                          {opened.toLocaleString('ru-RU')}
                        </td>
                        <td
                          className="ds-mono px-5 py-3 text-right"
                          style={{
                            borderTop: rowBorder,
                            color: 'var(--cp-paper)',
                            fontWeight: 600,
                          }}
                        >
                          {or_}%
                        </td>
                        <td
                          className="ds-mono px-5 py-3 text-right"
                          style={{
                            borderTop: rowBorder,
                            color: 'var(--cp-paper-mute)',
                          }}
                        >
                          {replied}
                        </td>
                        <td
                          className="ds-mono px-5 py-3 text-right"
                          style={{
                            borderTop: rowBorder,
                            color: 'var(--cp-paper)',
                            fontWeight: 600,
                          }}
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
        </>
      )}
    </div>
  );
}
