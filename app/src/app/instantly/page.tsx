'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Mail, Users, BarChart3, Send, Pause, FileText, ChevronRight,
  Loader2, AlertCircle, Activity, ListChecks, AlertTriangle,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import { getCurrentUserRole, isAdmin } from '@/lib/roles';
import type { Campaign, Account } from '@/lib/instantly/types';
import { CampaignStatus, CampaignStatusLabels, AccountStatus, WarmupStatus } from '@/lib/instantly/types';

type DashboardStats = {
  totalCampaigns: number;
  activeCampaigns: number;
  pausedCampaigns: number;
  draftCampaigns: number;
  completedCampaigns: number;
  totalAccounts: number;
  activeAccounts: number;
  warmupActive: number;
};

function computeStats(campaigns: Campaign[], accounts: Account[]): DashboardStats {
  return {
    totalCampaigns: campaigns.length,
    activeCampaigns: campaigns.filter((c) => c.status === CampaignStatus.Active).length,
    pausedCampaigns: campaigns.filter((c) => c.status === CampaignStatus.Paused).length,
    draftCampaigns: campaigns.filter((c) => c.status === CampaignStatus.Draft).length,
    completedCampaigns: campaigns.filter((c) => c.status === CampaignStatus.Completed).length,
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.status === AccountStatus.Active).length,
    warmupActive: accounts.filter((a) => a.warmup_status === WarmupStatus.Active).length,
  };
}

function StatCard({ label, value, icon: Icon, href, color, loading: isLoading }: {
  label: string;
  value: number | null;
  icon: React.ElementType;
  href?: string;
  color: string;
  loading?: boolean;
}) {
  const inner = (
    <div className={`rounded-xl border border-zinc-200 bg-white p-5 transition-shadow hover:shadow-md ${href ? 'cursor-pointer' : ''}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</p>
          {isLoading ? (
            <div className="mt-2 h-7 w-10 animate-pulse rounded bg-zinc-100" />
          ) : (
            <p className="mt-1 text-2xl font-bold text-zinc-900">{value ?? 0}</p>
          )}
        </div>
        <div className={`rounded-lg p-2.5 ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );

  if (href) {
    return <Link href={href as Route}>{inner}</Link>;
  }
  return inner;
}

const NAV_LINKS: { label: string; href: string; icon: React.ElementType; desc: string; adminOnly?: boolean }[] = [
  { label: 'Кампании', href: '/instantly/campaigns', icon: Send, desc: 'Создание, настройка и управление кампаниями' },
  { label: 'Аккаунты', href: '/instantly/accounts', icon: Mail, desc: 'Email-аккаунты, прогрев, статусы' },
  { label: 'Lead списки', href: '/instantly/lead-lists', icon: ListChecks, desc: 'Списки лидов и импорт баз' },
  { label: 'Лиды', href: '/instantly/leads', icon: Users, desc: 'Просмотр и управление лидами' },
  { label: 'Письма', href: '/instantly/emails', icon: Mail, desc: 'Входящие и исходящие письма по кампаниям' },
  { label: 'Аналитика', href: '/instantly/analytics', icon: BarChart3, desc: 'Аналитика кампаний и аккаунтов' },
  { label: 'Блок-лист', href: '/instantly/block-list', icon: AlertCircle, desc: 'Заблокированные домены и email' },
  { label: 'Анализатор', href: '/instantly/analyzer', icon: AlertTriangle, desc: 'Неактивные кампании с лидами, занимающими тариф', adminOnly: true },
];

export default function InstantlyDashboard() {
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentCampaigns, setRecentCampaigns] = useState<Campaign[]>([]);
  const [userIsAdmin, setUserIsAdmin] = useState(false);

  useEffect(() => {
    getCurrentUserRole().then((role) => setUserIsAdmin(isAdmin(role)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setStatsLoading(true);
    setError('');
    try {
      const quickData = await instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=100');
      const quickCampaigns = quickData.items ?? [];
      const sorted = [...quickCampaigns].sort(
        (a, b) => new Date(b.timestamp_created ?? 0).getTime() - new Date(a.timestamp_created ?? 0).getTime(),
      );
      setRecentCampaigns(sorted.slice(0, 5));
      setLoading(false);

      const [allCampData, accData] = await Promise.all([
        instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=all'),
        instantlyFetch<{ items: Account[] }>('/accounts?limit=all'),
      ]);
      setStats(computeStats(allCampData.items ?? [], accData.items ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Instantly</h1>
          <p className="mt-1 text-sm text-zinc-500">Управление email-аутричем</p>
        </div>
        <Link
          href={'/instantly/campaigns/new' as Route}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
        >
          <Send className="h-4 w-4" />
          Создать кампанию
        </Link>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Активные кампании" value={stats?.activeCampaigns ?? null} icon={Activity} href="/instantly/campaigns" color="bg-emerald-50 text-emerald-600" loading={statsLoading} />
            <StatCard label="На паузе" value={stats?.pausedCampaigns ?? null} icon={Pause} href="/instantly/campaigns" color="bg-amber-50 text-amber-600" loading={statsLoading} />
            <StatCard label="Черновики" value={stats?.draftCampaigns ?? null} icon={FileText} color="bg-zinc-100 text-zinc-600" loading={statsLoading} />
            <StatCard label="Аккаунты" value={stats?.totalAccounts ?? null} icon={Mail} href="/instantly/accounts" color="bg-blue-50 text-blue-600" loading={statsLoading} />
          </div>

          <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 bg-white">
              <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
                <h2 className="text-sm font-semibold text-zinc-900">Последние кампании</h2>
                <Link href={'/instantly/campaigns' as Route} className="text-xs font-medium text-zinc-500 hover:text-zinc-900 transition-colors">
                  Все кампании
                </Link>
              </div>
              <div className="divide-y divide-zinc-50">
                {recentCampaigns.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-zinc-400">Нет кампаний</p>
                ) : (
                  recentCampaigns.map((c) => (
                    <Link
                      key={c.id}
                      href={`/instantly/campaigns/${c.id}` as Route}
                      className="flex items-center justify-between px-5 py-3 hover:bg-zinc-50 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-800">{c.name}</p>
                        <p className="text-xs text-zinc-400">
                          {c.timestamp_created ? new Date(c.timestamp_created).toLocaleDateString('ru-RU') : ''}
                        </p>
                      </div>
                      <span className={`ml-3 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.status === CampaignStatus.Active ? 'bg-emerald-50 text-emerald-700' :
                        c.status === CampaignStatus.Paused ? 'bg-amber-50 text-amber-700' :
                        c.status === CampaignStatus.Completed ? 'bg-blue-50 text-blue-700' :
                        'bg-zinc-100 text-zinc-600'
                      }`}>
                        {CampaignStatusLabels[c.status] ?? `Status ${c.status}`}
                      </span>
                    </Link>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white">
              <div className="border-b border-zinc-100 px-5 py-4">
                <h2 className="text-sm font-semibold text-zinc-900">Разделы</h2>
              </div>
              <div className="divide-y divide-zinc-50">
                {NAV_LINKS.filter((link) => !link.adminOnly || userIsAdmin).map((link) => (
                  <Link
                    key={link.href}
                    href={link.href as Route}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50 transition-colors"
                  >
                    <div className="rounded-lg bg-zinc-100 p-2">
                      <link.icon className="h-4 w-4 text-zinc-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-800">{link.label}</p>
                      <p className="text-xs text-zinc-400">{link.desc}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-zinc-300" />
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
