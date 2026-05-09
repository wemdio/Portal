'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
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

function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="neu-sm p-3 sm:p-5">
      <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
        {label}
      </p>
      <p className="mt-1 sm:mt-2 text-xl sm:text-2xl font-bold">{value}</p>
    </div>
  );
}

type SortCol = 'name' | 'sent' | 'opened' | 'openRate' | 'replied' | 'replyRate';
type SortDir = 'asc' | 'desc';

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

// Indeterminate progress bar + "загружено x из y" counter
function LoadingProgress({ loaded, total }: { loaded: number; total: number | null }) {
  const isDone = total !== null && loaded >= total;
  const pct = total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;

  return (
    <div className="flex flex-col items-center gap-4 py-16">
      <p className="text-sm font-medium" style={{ color: 'var(--cp-text-m)' }}>
        {isDone
          ? `Загружено ${loaded} из ${total} кампаний`
          : total !== null
            ? `Загружаем ваши кампании... загружено ${loaded} из ${total}`
            : 'Загружаем ваши кампании...'}
      </p>

      <div
        className="w-64 sm:w-80 rounded-full overflow-hidden"
        style={{ height: '6px', background: 'rgba(180,173,164,0.2)' }}
      >
        {total === null ? (
          // Indeterminate — CSS sliding animation while we don't know total
          <div
            className="h-full rounded-full"
            style={{
              width: '40%',
              background: 'var(--cp-accent)',
              animation: 'cp-slide 1.4s ease-in-out infinite',
            }}
          />
        ) : (
          // Determinate — fill to pct
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: 'var(--cp-accent)' }}
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
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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

  useEffect(() => { void load(); }, [load]);

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

  return (
    <div className="mx-auto max-w-5xl">
      <OnboardingBanner />
      <div className="mb-6 sm:mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold">Кампании</h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Статистика по вашим email-кампаниям
          </p>
        </div>
        {!loading && syncedLabel && (
          <p className="text-[11px] shrink-0" style={{ color: 'var(--cp-text-l)' }}>
            Обновлено {syncedLabel}
          </p>
        )}
      </div>

      {error && (
        <div className="neu-inset mb-6 rounded-2xl px-5 py-3.5 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <LoadingProgress loaded={loadedCount} total={total} />
      ) : (
        <>
          <div className="mb-6 sm:mb-8 grid grid-cols-2 gap-3 sm:gap-5 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Отправлено" value={totals.sent.toLocaleString('ru-RU')} />
            <MetricCard label="Открытия" value={totals.opened.toLocaleString('ru-RU')} />
            <MetricCard label="Ответы" value={totals.replied} />
            <MetricCard label="Open rate" value={`${openRate}%`} />
            <MetricCard label="Reply rate" value={`${replyRate}%`} />
          </div>

          {campaigns.length === 0 ? (
            <div className="neu-card py-12 sm:py-16 text-center px-6">
              <p className="text-base sm:text-lg font-bold mb-2" style={{ color: 'var(--cp-text)' }}>
                Кампаний пока нет
              </p>
              <p className="text-xs sm:text-sm max-w-md mx-auto mb-5" style={{ color: 'var(--cp-text-m)' }}>
                Запустите первую кампанию: загрузите базу, напишите цепочку — мы покажем
                здесь её метрики (отправки, открытия, ответы) в реальном времени.
              </p>
              <Link
                href={'/client/launch' as Route}
                className="neu-btn inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold"
              >
                Создать кампанию
              </Link>
            </div>
          ) : (
            <>
              {/* Mobile: card list */}
              <div className="space-y-3 sm:hidden">
                {sortedRows.map(({ c, sent, opened, replied, openRateVal, replyRateVal }) => {
                  const or_ = openRateVal.toFixed(1);
                  const rr = replyRateVal.toFixed(1);
                  return (
                    <Link key={c.id} href={`/client/campaigns/${c.id}` as Route} className="neu-sm block p-4">
                      <p className="text-sm font-semibold mb-3 truncate">{c.name}</p>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-[10px] uppercase font-semibold" style={{ color: 'var(--cp-text-l)' }}>Отпр.</p>
                          <p className="text-sm font-bold">{sent}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase font-semibold" style={{ color: 'var(--cp-text-l)' }}>Open</p>
                          <p className="text-sm font-bold">{or_}%</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase font-semibold" style={{ color: 'var(--cp-text-l)' }}>Reply</p>
                          <p className="text-sm font-bold">{rr}%</p>
                        </div>
                      </div>
                      <div className="mt-2 flex justify-between text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
                        <span>{opened} откр. / {replied} отв.</span>
                      </div>
                    </Link>
                  );
                })}
              </div>

              {/* Desktop: table */}
              <div className="neu-card overflow-hidden hidden sm:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
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
                            className={`px-5 py-4 text-${align} text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap`}
                            style={{ color: sortCol === col ? 'var(--cp-text)' : 'var(--cp-text-l)' }}
                          >
                            {label}
                            <SortIcon col={col} active={sortCol === col} dir={sortDir} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map(({ c, sent, opened, replied, openRateVal, replyRateVal }) => {
                        const or_ = openRateVal.toFixed(1);
                        const rr = replyRateVal.toFixed(1);
                        return (
                          <tr key={c.id} className="neu-row">
                            <td className="px-5 py-3.5" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                              <Link
                                href={`/client/campaigns/${c.id}` as Route}
                                className="font-semibold transition-colors hover:underline"
                                style={{ color: 'var(--cp-text)' }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--cp-accent)')}
                                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--cp-text)')}
                              >
                                {c.name}
                              </Link>
                            </td>
                            <td className="px-5 py-3.5 text-right" style={{ borderTop: '1px solid rgba(180,173,164,0.15)', color: 'var(--cp-text-m)' }}>{sent.toLocaleString('ru-RU')}</td>
                            <td className="px-5 py-3.5 text-right" style={{ borderTop: '1px solid rgba(180,173,164,0.15)', color: 'var(--cp-text-m)' }}>{opened.toLocaleString('ru-RU')}</td>
                            <td className="px-5 py-3.5 text-right font-semibold" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>{or_}%</td>
                            <td className="px-5 py-3.5 text-right" style={{ borderTop: '1px solid rgba(180,173,164,0.15)', color: 'var(--cp-text-m)' }}>{replied}</td>
                            <td className="px-5 py-3.5 text-right font-semibold" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>{rr}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
