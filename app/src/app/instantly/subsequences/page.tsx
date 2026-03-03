'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, GitBranch, Plus, Play, Pause, Copy,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Subsequence, Campaign, PaginatedResponse } from '@/lib/instantly/types';

export default function SubsequencesPage() {
  const [subsequences, setSubsequences] = useState<Subsequence[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cData, sData] = await Promise.all([
        instantlyFetch<{ items: Campaign[] }>('/campaigns?limit=all'),
        instantlyFetch<PaginatedResponse<Subsequence>>(`/subsequences${selectedCampaign ? `?campaign_id=${selectedCampaign}` : ''}`),
      ]);
      setCampaigns(cData.items ?? []);
      setSubsequences(sData.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [selectedCampaign]);

  useEffect(() => { load(); }, [load]);

  const handleAction = useCallback(async (id: string, action: 'pause' | 'resume' | 'duplicate') => {
    setActionLoading(id);
    try {
      await instantlyFetch(`/subsequences/${id}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(null);
    }
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-zinc-900">Подпоследовательности</h1>

      <div className="mb-5">
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

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
      ) : subsequences.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <GitBranch className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">Нет подпоследовательностей</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {subsequences.map((s) => (
            <div key={s.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800">{s.name ?? `Subsequence`}</p>
                <p className="text-xs text-zinc-400">
                  ID: {s.id.slice(0, 8)}...
                  {s.campaign_id && ` | Campaign: ${s.campaign_id.slice(0, 8)}...`}
                </p>
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                s.status === 1 ? 'bg-emerald-50 text-emerald-700' :
                s.status === 2 ? 'bg-amber-50 text-amber-700' :
                'bg-zinc-100 text-zinc-600'
              }`}>
                {s.status === 1 ? 'Активна' : s.status === 2 ? 'Пауза' : `Status ${s.status ?? '?'}`}
              </span>
              <div className="flex items-center gap-1">
                {s.status === 2 ? (
                  <button onClick={() => handleAction(s.id, 'resume')} disabled={actionLoading === s.id} className="rounded-md p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 transition-colors disabled:opacity-50" title="Запустить">
                    {actionLoading === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  </button>
                ) : s.status === 1 ? (
                  <button onClick={() => handleAction(s.id, 'pause')} disabled={actionLoading === s.id} className="rounded-md p-1.5 text-zinc-400 hover:bg-amber-50 hover:text-amber-600 transition-colors disabled:opacity-50" title="Пауза">
                    {actionLoading === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                  </button>
                ) : null}
                <button onClick={() => handleAction(s.id, 'duplicate')} disabled={actionLoading === s.id} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors disabled:opacity-50" title="Дублировать">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          <div className="px-5 py-3 text-xs text-zinc-400">{subsequences.length} подпоследовательностей</div>
        </div>
      )}
    </div>
  );
}
