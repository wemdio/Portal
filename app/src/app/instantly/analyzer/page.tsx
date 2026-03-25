'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Search, Trash2, ExternalLink, AlertTriangle,
  ArrowUpDown, ArrowUp, ArrowDown, ShieldAlert,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import { isAdmin } from '@/lib/roles';
import { useUser } from '@/lib/UserProvider';
import type { Campaign, CampaignAnalytics } from '@/lib/instantly/types';
import { CampaignStatus, CampaignStatusLabels } from '@/lib/instantly/types';

const ANALYZABLE_STATUSES = [
  CampaignStatus.Completed,
  CampaignStatus.Paused,
  CampaignStatus.Draft,
  CampaignStatus.AccountsUnhealthy,
  CampaignStatus.AccountSuspended,
  CampaignStatus.BounceProtect,
] as const;

const STATUS_COLORS: Record<number, string> = {
  [CampaignStatus.Completed]: 'bg-blue-50 text-blue-700',
  [CampaignStatus.Paused]: 'bg-amber-50 text-amber-700',
  [CampaignStatus.Draft]: 'bg-zinc-100 text-zinc-600',
  [CampaignStatus.AccountsUnhealthy]: 'bg-red-50 text-red-600',
  [CampaignStatus.AccountSuspended]: 'bg-red-50 text-red-700',
  [CampaignStatus.BounceProtect]: 'bg-orange-50 text-orange-600',
};

interface CampaignRow {
  id: string;
  name: string;
  status: number;
  statusLabel: string;
  leadsCount: number;
  sentCount: number;
  replyCount: number;
  bouncedCount: number;
  timestampCreated: string;
  timestampUpdated: string;
  lastActivityAgo: string;
  inactiveDays: number;
}

function formatAgo(dateStr: string): { label: string; days: number } {
  if (!dateStr) return { label: '—', days: 0 };
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1) return { label: 'сегодня', days: 0 };
  if (days === 1) return { label: '1 день назад', days: 1 };
  if (days < 30) return { label: `${days} дн. назад`, days };
  const months = Math.floor(days / 30);
  if (months < 12) return { label: `${months} мес. назад`, days };
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return { label: remMonths > 0 ? `${years} г. ${remMonths} мес. назад` : `${years} г. назад`, days };
}

type SortKey = 'leadsCount' | 'sentCount' | 'inactiveDays' | 'name';
type SortDir = 'asc' | 'desc';

const ANALYZABLE_SET = new Set<number>(ANALYZABLE_STATUSES as unknown as number[]);

export default function CompletedCampaignAnalyzer() {
  const { userRole } = useUser();
  const authorized = userRole === null ? null : isAdmin(userRole);
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('leadsCount');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [onlyWithLeads, setOnlyWithLeads] = useState(true);
  const [statusFilters, setStatusFilters] = useState<Set<number>>(new Set(ANALYZABLE_STATUSES));

  const [minLeads, setMinLeads] = useState('');
  const [maxLeads, setMaxLeads] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [clearing, setClearing] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<{ id: string; name: string; count: number } | null>(null);

  const toggleStatus = (status: number) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [campData, analyticsRaw] = await Promise.all([
        instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=all'),
        instantlyFetch<CampaignAnalytics[] | { data: CampaignAnalytics[] }>('/analytics?type=campaigns'),
      ]);

      const campaigns = campData.items ?? [];
      const relevant = campaigns.filter((c) => ANALYZABLE_SET.has(c.status));

      const analyticsArr = Array.isArray(analyticsRaw)
        ? analyticsRaw
        : Array.isArray((analyticsRaw as { data?: unknown }).data)
          ? (analyticsRaw as { data: CampaignAnalytics[] }).data
          : [];

      const analyticsMap = new Map<string, CampaignAnalytics>();
      for (const a of analyticsArr) {
        const key = a.campaign_id ?? (a as Record<string, unknown>).id;
        if (typeof key === 'string') analyticsMap.set(key, a);
      }

      const result: CampaignRow[] = relevant.map((c) => {
        const a = analyticsMap.get(c.id);
        const dateRef = c.timestamp_updated || c.timestamp_created || '';
        const ago = formatAgo(dateRef);
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          statusLabel: CampaignStatusLabels[c.status] ?? `Status ${c.status}`,
          leadsCount: a?.leads_count ?? 0,
          sentCount: a?.emails_sent_count ?? 0,
          replyCount: a?.reply_count ?? 0,
          bouncedCount: a?.bounced_count ?? 0,
          timestampCreated: c.timestamp_created ?? '',
          timestampUpdated: c.timestamp_updated ?? '',
          lastActivityAgo: ago.label,
          inactiveDays: ago.days,
        };
      });

      setRows(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authorized) load();
  }, [authorized, load]);

  const handleClearLeads = useCallback(async (campaignId: string) => {
    setClearing(campaignId);
    setConfirmClear(null);
    try {
      const token = (await (await import('@/lib/supabaseClient')).supabase.auth.getSession()).data.session?.access_token ?? '';
      const res = await fetch('/api/instantly/leads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-by-campaign', campaign_id: campaignId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(errBody?.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json();
      const deleted = result?.count ?? 0;
      setRows((prev) => prev.map((r) => r.id === campaignId ? { ...r, leadsCount: Math.max(0, r.leadsCount - deleted) } : r));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления лидов');
    } finally {
      setClearing(null);
    }
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let list = rows;
    list = list.filter((r) => statusFilters.has(r.status));
    if (onlyWithLeads) list = list.filter((r) => r.leadsCount > 0);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }
    const minL = minLeads ? parseInt(minLeads, 10) : NaN;
    const maxL = maxLeads ? parseInt(maxLeads, 10) : NaN;
    if (!isNaN(minL)) list = list.filter((r) => r.leadsCount >= minL);
    if (!isNaN(maxL)) list = list.filter((r) => r.leadsCount <= maxL);
    if (dateFrom) {
      const from = new Date(dateFrom).getTime();
      list = list.filter((r) => {
        const d = r.timestampUpdated || r.timestampCreated;
        return d && new Date(d).getTime() >= from;
      });
    }
    if (dateTo) {
      const to = new Date(dateTo).getTime() + 86400000;
      list = list.filter((r) => {
        const d = r.timestampUpdated || r.timestampCreated;
        return d && new Date(d).getTime() < to;
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'ru') * dir;
      return ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir;
    });
    return list;
  }, [rows, search, sortKey, sortDir, onlyWithLeads, statusFilters, minLeads, maxLeads, dateFrom, dateTo]);

  const totalLeads = useMemo(() => filtered.reduce((sum, r) => sum + r.leadsCount, 0), [filtered]);
  const totalCampaigns = filtered.length;

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  }

  if (authorized === null) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <ShieldAlert className="mx-auto h-12 w-12 text-zinc-300 mb-4" />
        <h2 className="text-lg font-semibold text-zinc-800 mb-2">Доступ ограничен</h2>
        <p className="text-sm text-zinc-500">Эта страница доступна только администраторам.</p>
        <Link href={'/instantly' as Route} className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          Вернуться
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-4 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          Анализатор неактивных кампаний
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Завершённые, паузнутые и черновые кампании с загруженными лидами, которые занимают место по тарифу.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          <p className="text-sm text-zinc-400">Загрузка кампаний и аналитики…</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-3">
            <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 min-w-[100px]">
              <p className="text-[10px] font-medium text-zinc-400 uppercase">Кампаний</p>
              <p className="text-lg font-bold text-zinc-900 leading-tight">{totalCampaigns} <span className="text-xs font-normal text-zinc-400">/ {rows.length}</span></p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 min-w-[120px]">
              <p className="text-[10px] font-medium text-amber-500 uppercase">Лидов в них</p>
              <p className="text-lg font-bold text-amber-700 leading-tight">{totalLeads.toLocaleString('ru-RU')}</p>
            </div>
            <div className="rounded-lg border border-blue-100 bg-blue-50/30 px-3 py-2 min-w-[100px]">
              <p className="text-[10px] font-medium text-blue-500 uppercase">Завершённых</p>
              <p className="text-lg font-bold text-blue-700 leading-tight">{rows.filter((r) => r.status === CampaignStatus.Completed).length}</p>
            </div>
            <div className="rounded-lg border border-amber-100 bg-amber-50/30 px-3 py-2 min-w-[100px]">
              <p className="text-[10px] font-medium text-amber-500 uppercase">На паузе</p>
              <p className="text-lg font-bold text-amber-700 leading-tight">{rows.filter((r) => r.status === CampaignStatus.Paused).length}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 min-w-[100px]">
              <p className="text-[10px] font-medium text-zinc-400 uppercase">Черновики</p>
              <p className="text-lg font-bold text-zinc-700 leading-tight">{rows.filter((r) => r.status === CampaignStatus.Draft).length}</p>
            </div>
            <div className="rounded-lg border border-red-100 bg-red-50/30 px-3 py-2 min-w-[100px]">
              <p className="text-[10px] font-medium text-red-500 uppercase">Проблемные</p>
              <p className="text-lg font-bold text-red-600 leading-tight">{rows.filter((r) => r.status < 0).length}</p>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="relative min-w-[180px] max-w-xs flex-1">
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">Поиск</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Название кампании…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                />
              </div>
            </div>
            <div className="min-w-[120px]">
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">Лидов от</label>
              <input
                type="number"
                min={0}
                placeholder="0"
                value={minLeads}
                onChange={(e) => setMinLeads(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <div className="min-w-[120px]">
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">Лидов до</label>
              <input
                type="number"
                min={0}
                placeholder="∞"
                value={maxLeads}
                onChange={(e) => setMaxLeads(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <div className="min-w-[140px]">
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">Дата от</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <div className="min-w-[140px]">
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">Дата до</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">Статус</label>
              <div className="flex items-center gap-1">
                {ANALYZABLE_STATUSES.map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => toggleStatus(st)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors border ${
                      statusFilters.has(st)
                        ? STATUS_COLORS[st] + ' border-current'
                        : 'bg-white text-zinc-400 border-zinc-200'
                    }`}
                  >
                    {CampaignStatusLabels[st]}
                  </button>
                ))}
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none pb-2">
              <input
                type="checkbox"
                checked={onlyWithLeads}
                onChange={(e) => setOnlyWithLeads(e.target.checked)}
                className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
              />
              Только с лидами
            </label>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center">
              <Trash2 className="mx-auto h-8 w-8 text-zinc-300 mb-3" />
              <p className="text-sm text-zinc-500">
                {onlyWithLeads ? 'Нет завершённых кампаний с оставшимися лидами' : 'Нет завершённых кампаний'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 bg-zinc-50/50">
                      <th className="px-3 py-2 text-left">
                        <button onClick={() => handleSort('name')} className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-900">
                          Кампания <SortIcon col="name" />
                        </button>
                      </th>
                      <th className="px-2 py-2 text-center">
                        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Статус</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <button onClick={() => handleSort('leadsCount')} className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-900">
                          Лидов <SortIcon col="leadsCount" />
                        </button>
                      </th>
                      <th className="px-2 py-2 text-right hidden md:table-cell">
                        <button onClick={() => handleSort('sentCount')} className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-900">
                          Отпр. <SortIcon col="sentCount" />
                        </button>
                      </th>
                      <th className="px-2 py-2 text-right hidden lg:table-cell">
                        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Ответы</span>
                      </th>
                      <th className="px-2 py-2 text-right">
                        <button onClick={() => handleSort('inactiveDays')} className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-900">
                          Неакт. <SortIcon col="inactiveDays" />
                        </button>
                      </th>
                      <th className="px-2 py-2 text-center whitespace-nowrap">
                        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Действия</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {filtered.map((r) => (
                      <tr key={r.id} className="hover:bg-zinc-50 transition-colors">
                        <td className="px-3 py-2 max-w-[260px]">
                          <Link href={`/instantly/campaigns/${r.id}` as Route} className="text-[13px] font-medium text-zinc-800 hover:text-blue-600 transition-colors truncate block" title={r.name}>
                            {r.name}
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${STATUS_COLORS[r.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                            {r.statusLabel}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className={`text-[13px] font-semibold ${r.leadsCount > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>
                            {r.leadsCount.toLocaleString('ru-RU')}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right text-[13px] text-zinc-600 hidden md:table-cell">
                          {r.sentCount.toLocaleString('ru-RU')}
                        </td>
                        <td className="px-2 py-2 text-right text-[13px] text-zinc-600 hidden lg:table-cell">
                          {r.replyCount.toLocaleString('ru-RU')}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className="text-[13px] text-zinc-500 whitespace-nowrap">{r.lastActivityAgo}</span>
                        </td>
                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {r.leadsCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setConfirmClear({ id: r.id, name: r.name, count: r.leadsCount })}
                                disabled={clearing === r.id}
                                className="inline-flex items-center gap-0.5 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-100 transition-colors disabled:opacity-50 whitespace-nowrap"
                                title="Удалить всех лидов из этой кампании"
                              >
                                {clearing === r.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-2.5 w-2.5" />
                                )}
                                Очистить
                              </button>
                            )}
                            <a
                              href={`https://app.instantly.ai/app/campaign/${r.id}/leads`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex text-zinc-400 hover:text-zinc-600 transition-colors p-0.5"
                              title="Открыть в Instantly"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {confirmClear && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setConfirmClear(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-full bg-red-100 p-2">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900">Очистить лидов?</h3>
            </div>
            <p className="text-sm text-zinc-600 mb-1">
              Будут удалены <strong className="text-red-600">{confirmClear.count.toLocaleString('ru-RU')}</strong> лидов из кампании:
            </p>
            <p className="text-sm font-medium text-zinc-800 mb-4 truncate">{confirmClear.name}</p>
            <p className="text-xs text-zinc-500 mb-5">Сама кампания не будет удалена. Это действие необратимо.</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmClear(null)}
                className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => handleClearLeads(confirmClear.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Удалить лидов
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
