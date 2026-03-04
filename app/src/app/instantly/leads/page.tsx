'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useSearchParams } from 'next/navigation';
import {
  ChevronLeft, Loader2, Users, Search, ChevronRight,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Lead, PaginatedResponse, Campaign, LeadList } from '@/lib/instantly/types';

const INTEREST_LABELS: Record<number, { label: string; cls: string }> = {
  0: { label: 'Не обработан', cls: 'bg-zinc-100 text-zinc-600' },
  1: { label: 'Заинтересован', cls: 'bg-emerald-50 text-emerald-700' },
  [-1]: { label: 'Не заинтересован', cls: 'bg-red-50 text-red-700' },
  [-2]: { label: 'Ответ получен', cls: 'bg-blue-50 text-blue-700' },
  [-3]: { label: 'Неверный контакт', cls: 'bg-orange-50 text-orange-700' },
};

export default function LeadsPage() {
  const searchParams = useSearchParams();
  const initialCampaign = searchParams.get('campaign_id') ?? '';
  const initialList = searchParams.get('lead_list_id') ?? '';

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [campaignId, setCampaignId] = useState(initialCampaign);
  const [listId, setListId] = useState(initialList);
  const [startingAfter, setStartingAfter] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leadLists, setLeadLists] = useState<LeadList[]>([]);

  useEffect(() => {
    Promise.all([
      instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=all').catch(() => ({ items: [] })),
      instantlyFetch<{ items: LeadList[] }>('/lead-lists?limit=all').catch(() => ({ items: [] })),
    ]).then(([c, l]) => {
      setCampaigns(c.items ?? []);
      setLeadLists(l.items ?? []);
    });
  }, []);

  const loadLeads = useCallback(async (append = false) => {
    if (!campaignId && !listId) return;
    setLoading(true);
    setError('');
    try {
      const data = await instantlyFetch<PaginatedResponse<Lead>>('/leads', {
        method: 'POST',
        body: JSON.stringify({
          action: 'list',
          campaign_id: campaignId || undefined,
          lead_list_id: listId || undefined,
          search: search || undefined,
          limit: 50,
          starting_after: append ? startingAfter : undefined,
        }),
      });
      const items = data.items ?? [];
      setLeads(append ? (prev) => [...prev, ...items] : items);
      setStartingAfter(data.next_starting_after);
      setHasMore(!!data.next_starting_after);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [campaignId, listId, search, startingAfter]);

  useEffect(() => {
    if (campaignId || listId) loadLeads();
  }, [campaignId, listId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setStartingAfter(undefined);
    loadLeads();
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-zinc-900">Лиды</h1>

      <div className="mb-5 flex flex-wrap gap-3">
        <select
          value={campaignId}
          onChange={(e) => { setCampaignId(e.target.value); setListId(''); setLeads([]); setStartingAfter(undefined); }}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
        >
          <option value="">Выберите кампанию</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          value={listId}
          onChange={(e) => { setListId(e.target.value); setCampaignId(''); setLeads([]); setStartingAfter(undefined); }}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
        >
          <option value="">Или lead-список</option>
          {leadLists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Поиск по email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {!campaignId && !listId ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Users className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">Выберите кампанию или lead-список для просмотра лидов</p>
        </div>
      ) : loading && leads.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : leads.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Users className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">Нет лидов</p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Email</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Имя</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Компания</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Статус</th>
                    <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Добавлен</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {leads.map((l) => {
                    const interest = INTEREST_LABELS[l.interest_status ?? 0] ?? INTEREST_LABELS[0];
                    return (
                      <tr key={l.id} className="hover:bg-zinc-50">
                        <td className="px-4 py-3 font-medium text-zinc-800 truncate max-w-[220px]">{l.email}</td>
                        <td className="px-4 py-3 text-zinc-500">{[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}</td>
                        <td className="px-4 py-3 text-zinc-500 truncate max-w-[180px]">{l.company_name || '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${interest.cls}`}>
                            {interest.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-zinc-400">
                          {l.timestamp_created ? new Date(l.timestamp_created).toLocaleDateString('ru-RU') : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-zinc-100 px-5 py-3 flex items-center justify-between">
              <span className="text-xs text-zinc-400">{leads.length} лидов загружено</span>
              {hasMore && (
                <button
                  onClick={() => loadLeads(true)}
                  disabled={loading}
                  className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-50 transition-colors"
                >
                  {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
                  Загрузить ещё
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
