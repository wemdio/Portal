'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Loader2, Send, Eye, MessageSquare, TrendingUp } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';

function MetricCard({ label, value, icon: Icon, color }: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
          <p className="mt-1 text-2xl font-bold text-zinc-900">{value}</p>
        </div>
        <div className={`rounded-lg p-2.5 ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
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

  const totals = analytics.reduce(
    (acc, a) => ({
      sent: acc.sent + (a.emails_sent_count ?? 0),
      opened: acc.opened + (a.open_count ?? 0),
      replied: acc.replied + (a.reply_count ?? 0),
      contacted: acc.contacted + (a.new_leads_contacted_count ?? 0),
      leads: acc.leads + (a.leads_count ?? 0),
    }),
    { sent: 0, opened: 0, replied: 0, contacted: 0, leads: 0 },
  );

  const openRate = totals.sent > 0 ? ((totals.opened / totals.sent) * 100).toFixed(1) : '0';
  const replyRate = totals.contacted > 0 ? ((totals.replied / totals.contacted) * 100).toFixed(1) : '0';

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Кампании</h1>
        <p className="mt-1 text-sm text-zinc-500">Статистика по вашим email-кампаниям</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Отправлено" value={totals.sent} icon={Send} color="bg-blue-50 text-blue-600" />
            <MetricCard label="Открытия" value={totals.opened} icon={Eye} color="bg-emerald-50 text-emerald-600" />
            <MetricCard label="Ответы" value={totals.replied} icon={MessageSquare} color="bg-violet-50 text-violet-600" />
            <MetricCard label="Open rate" value={`${openRate}%`} icon={TrendingUp} color="bg-amber-50 text-amber-600" />
            <MetricCard label="Reply rate" value={`${replyRate}%`} icon={TrendingUp} color="bg-cyan-50 text-cyan-600" />
          </div>

          {campaigns.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
              <p className="text-sm text-zinc-500">Нет назначенных кампаний</p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Кампания</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Лидов</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Отправлено</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Открытия</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Open %</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Ответы</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Reply %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {campaigns.map((c) => {
                      const a = analytics.find((x) => x.campaign_id === c.id);
                      const sent = a?.emails_sent_count ?? 0;
                      const opened = a?.open_count ?? 0;
                      const replied = a?.reply_count ?? 0;
                      const contacted = a?.new_leads_contacted_count ?? 0;
                      const leads = a?.leads_count ?? 0;
                      const or = sent > 0 ? ((opened / sent) * 100).toFixed(1) : '0';
                      const rr = contacted > 0 ? ((replied / contacted) * 100).toFixed(1) : '0';
                      return (
                        <tr key={c.id} className="hover:bg-zinc-50">
                          <td className="px-4 py-3">
                            <Link
                              href={`/client/campaigns/${c.id}` as Route}
                              className="font-medium text-zinc-800 hover:text-blue-600 transition-colors truncate block max-w-[300px]"
                            >
                              {c.name}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-right">{leads}</td>
                          <td className="px-4 py-3 text-right">{sent}</td>
                          <td className="px-4 py-3 text-right">{opened}</td>
                          <td className="px-4 py-3 text-right font-medium">{or}%</td>
                          <td className="px-4 py-3 text-right">{replied}</td>
                          <td className="px-4 py-3 text-right font-medium">{rr}%</td>
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
