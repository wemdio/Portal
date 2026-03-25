'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';

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

export default function ClientCampaignsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [analytics, setAnalytics] = useState<CampaignAnalytics[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<{ campaigns: Campaign[]; analytics: CampaignAnalytics[] }>('/campaigns');
      setCampaigns(data.campaigns ?? []);
      setAnalytics(data.analytics ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totals = analytics.reduce<{ sent: number; opened: number; replied: number; contacted: number; leads: number }>(
    (acc, a) => ({
      sent: acc.sent + Number(a.emails_sent_count ?? 0),
      opened: acc.opened + Number(a.open_count ?? 0),
      replied: acc.replied + Number(a.reply_count ?? 0),
      contacted: acc.contacted + Number(a.new_leads_contacted_count ?? 0),
      leads: acc.leads + Number(a.leads_count ?? 0),
    }),
    { sent: 0, opened: 0, replied: 0, contacted: 0, leads: 0 },
  );

  const openRate = totals.sent > 0 ? ((totals.opened / totals.sent) * 100).toFixed(1) : '0';
  const replyRate = totals.contacted > 0 ? ((totals.replied / totals.contacted) * 100).toFixed(1) : '0';

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Кампании</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Статистика по вашим email-кампаниям
        </p>
      </div>

      {error && (
        <div className="neu-inset mb-6 rounded-2xl px-5 py-3.5 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="neu-spinner animate-spin" />
        </div>
      ) : (
        <>
          <div className="mb-6 sm:mb-8 grid grid-cols-2 gap-3 sm:gap-5 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Отправлено" value={totals.sent} />
            <MetricCard label="Открытия" value={totals.opened} />
            <MetricCard label="Ответы" value={totals.replied} />
            <MetricCard label="Open rate" value={`${openRate}%`} />
            <MetricCard label="Reply rate" value={`${replyRate}%`} />
          </div>

          {campaigns.length === 0 ? (
            <div className="neu-card py-16 text-center">
              <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Нет назначенных кампаний</p>
            </div>
          ) : (
            <>
              {/* Mobile: card list */}
              <div className="space-y-3 sm:hidden">
                {campaigns.map((c) => {
                  const a = analytics.find((x) => x.campaign_id === c.id);
                  const sent = Number(a?.emails_sent_count ?? 0);
                  const opened = Number(a?.open_count ?? 0);
                  const replied = Number(a?.reply_count ?? 0);
                  const contacted = Number(a?.new_leads_contacted_count ?? 0);
                  const leads = Number(a?.leads_count ?? 0);
                  const or_ = sent > 0 ? ((opened / sent) * 100).toFixed(1) : '0';
                  const rr = contacted > 0 ? ((replied / contacted) * 100).toFixed(1) : '0';
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
                        <span>{leads} лидов</span>
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
                        <th className="px-5 py-4 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
                          Кампания
                        </th>
                        <th className="px-5 py-4 text-right text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Лидов</th>
                        <th className="px-5 py-4 text-right text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Отправлено</th>
                        <th className="px-5 py-4 text-right text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Открытия</th>
                        <th className="px-5 py-4 text-right text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Open %</th>
                        <th className="px-5 py-4 text-right text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Ответы</th>
                        <th className="px-5 py-4 text-right text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Reply %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaigns.map((c) => {
                        const a = analytics.find((x) => x.campaign_id === c.id);
                        const sent = Number(a?.emails_sent_count ?? 0);
                        const opened = Number(a?.open_count ?? 0);
                        const replied = Number(a?.reply_count ?? 0);
                        const contacted = Number(a?.new_leads_contacted_count ?? 0);
                        const leads = Number(a?.leads_count ?? 0);
                        const or_ = sent > 0 ? ((opened / sent) * 100).toFixed(1) : '0';
                        const rr = contacted > 0 ? ((replied / contacted) * 100).toFixed(1) : '0';
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
                            <td className="px-5 py-3.5 text-right" style={{ borderTop: '1px solid rgba(180,173,164,0.15)', color: 'var(--cp-text-m)' }}>{leads}</td>
                            <td className="px-5 py-3.5 text-right" style={{ borderTop: '1px solid rgba(180,173,164,0.15)', color: 'var(--cp-text-m)' }}>{sent}</td>
                            <td className="px-5 py-3.5 text-right" style={{ borderTop: '1px solid rgba(180,173,164,0.15)', color: 'var(--cp-text-m)' }}>{opened}</td>
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
