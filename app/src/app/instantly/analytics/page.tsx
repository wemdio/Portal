'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, BarChart3, Send, Eye, MessageSquare, AlertTriangle, Users, TrendingUp,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';
import { CampaignStatus, CampaignStatusLabels } from '@/lib/instantly/types';

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

export default function AnalyticsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [analytics, setAnalytics] = useState<CampaignAnalytics[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [aData, cData] = await Promise.all([
        instantlyFetch<CampaignAnalytics[]>('/analytics?type=campaigns'),
        instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=all'),
      ]);
      setAnalytics(Array.isArray(aData) ? aData : []);
      setCampaigns(cData.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = selectedCampaign
    ? analytics.filter((a) => a.campaign_id === selectedCampaign)
    : analytics;

  type Totals = { sent: number; opened: number; replied: number; bounced: number; contacted: number; leads: number };
  const totals = filtered.reduce<Totals>(
    (acc, a) => ({
      sent: acc.sent + (a.emails_sent_count ?? 0),
      opened: acc.opened + (a.open_count ?? 0),
      replied: acc.replied + (a.reply_count ?? 0),
      bounced: acc.bounced + (a.bounced_count ?? 0),
      contacted: acc.contacted + (a.new_leads_contacted_count ?? 0),
      leads: acc.leads + (a.leads_count ?? 0),
    }),
    { sent: 0, opened: 0, replied: 0, bounced: 0, contacted: 0, leads: 0 },
  );

  const openRate = totals.sent > 0 ? ((totals.opened / totals.sent) * 100).toFixed(1) : '0';
  const replyRate = totals.contacted > 0 ? ((totals.replied / totals.contacted) * 100).toFixed(1) : '0';

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Аналитика</h1>
          <p className="mt-1 text-sm text-zinc-500">Статистика по кампаниям Instantly</p>
        </div>
        <Link
          href={'/tools/auto-report' as Route}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
        >
          Автоотчёт
        </Link>
      </div>

      <div className="mb-6">
        <select
          value={selectedCampaign}
          onChange={(e) => setSelectedCampaign(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
        >
          <option value="">Все кампании</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
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
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <MetricCard label="Отправлено" value={totals.sent} icon={Send} color="bg-blue-50 text-blue-600" />
            <MetricCard label="Открытия" value={totals.opened} icon={Eye} color="bg-emerald-50 text-emerald-600" />
            <MetricCard label="Ответы" value={totals.replied} icon={MessageSquare} color="bg-violet-50 text-violet-600" />
            <MetricCard label="Bounce" value={totals.bounced} icon={AlertTriangle} color="bg-red-50 text-red-600" />
            <MetricCard label="Open rate" value={`${openRate}%`} icon={TrendingUp} color="bg-amber-50 text-amber-600" />
            <MetricCard label="Reply rate" value={`${replyRate}%`} icon={TrendingUp} color="bg-cyan-50 text-cyan-600" />
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
              <BarChart3 className="mx-auto h-8 w-8 text-zinc-300" />
              <p className="mt-3 text-sm text-zinc-500">Нет данных аналитики</p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Кампания</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Лидов</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Контактов</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Отправлено</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Открытия</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Open %</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Ответы</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Reply %</th>
                      <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Bounce</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {filtered.map((a, i) => {
                      const sent = a.emails_sent_count ?? 0;
                      const opened = a.open_count ?? 0;
                      const replied = a.reply_count ?? 0;
                      const contacted = a.new_leads_contacted_count ?? 0;
                      const bounced = a.bounced_count ?? 0;
                      const leads = a.leads_count ?? 0;
                      const or = sent > 0 ? ((opened / sent) * 100).toFixed(1) : '0';
                      const rr = contacted > 0 ? ((replied / contacted) * 100).toFixed(1) : '0';
                      return (
                        <tr key={a.campaign_id ?? i} className="hover:bg-zinc-50">
                          <td className="px-4 py-3">
                            <Link
                              href={`/instantly/campaigns/${a.campaign_id}` as Route}
                              className="font-medium text-zinc-800 hover:text-blue-600 transition-colors truncate block max-w-[250px]"
                            >
                              {a.campaign_name ?? a.campaign_id ?? `Campaign ${i + 1}`}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-right">{leads}</td>
                          <td className="px-4 py-3 text-right">{contacted}</td>
                          <td className="px-4 py-3 text-right">{sent}</td>
                          <td className="px-4 py-3 text-right">{opened}</td>
                          <td className="px-4 py-3 text-right font-medium">{or}%</td>
                          <td className="px-4 py-3 text-right">{replied}</td>
                          <td className="px-4 py-3 text-right font-medium">{rr}%</td>
                          <td className="px-4 py-3 text-right text-red-500">{bounced}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-zinc-200 bg-zinc-50 font-semibold">
                      <td className="px-4 py-3">Итого ({filtered.length} кампаний)</td>
                      <td className="px-4 py-3 text-right">{totals.leads}</td>
                      <td className="px-4 py-3 text-right">{totals.contacted}</td>
                      <td className="px-4 py-3 text-right">{totals.sent}</td>
                      <td className="px-4 py-3 text-right">{totals.opened}</td>
                      <td className="px-4 py-3 text-right">{openRate}%</td>
                      <td className="px-4 py-3 text-right">{totals.replied}</td>
                      <td className="px-4 py-3 text-right">{replyRate}%</td>
                      <td className="px-4 py-3 text-right text-red-500">{totals.bounced}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
