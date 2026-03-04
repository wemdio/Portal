'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Shield, Plus, Search,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { BlockListEntry, PaginatedResponse } from '@/lib/instantly/types';

export default function BlockListPage() {
  const [entries, setEntries] = useState<BlockListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const all: BlockListEntry[] = [];
      let startingAfter: string | undefined;
      do {
        const params = new URLSearchParams({ limit: '100' });
        if (startingAfter) params.set('starting_after', startingAfter);
        const data = await instantlyFetch<PaginatedResponse<BlockListEntry>>(`/block-list?${params}`);
        if (data.items?.length) all.push(...data.items);
        startingAfter = data.next_starting_after;
      } while (startingAfter);
      setEntries(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = useCallback(async () => {
    if (!newValue.trim()) return;
    setAdding(true);
    try {
      const entry = await instantlyFetch<BlockListEntry>('/block-list', {
        method: 'POST',
        body: JSON.stringify({ value: newValue.trim() }),
      });
      setEntries((prev) => [entry, ...prev]);
      setNewValue('');
      setShowAdd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления');
    } finally {
      setAdding(false);
    }
  }, [newValue]);

  const filtered = entries.filter((e) =>
    !search || e.value.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Блок-лист</h1>
          <p className="mt-1 text-sm text-zinc-500">Заблокированные email и домены</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors"
        >
          <Plus className="h-4 w-4" /> Добавить
        </button>
      </div>

      {showAdd && (
        <div className="mb-5 rounded-xl border border-zinc-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900">Добавить в блок-лист</h3>
          <p className="mb-3 text-xs text-zinc-500">Введите email или домен (например: spam@example.com или example.com)</p>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="email или домен"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              autoFocus
            />
            <button
              onClick={handleAdd}
              disabled={adding || !newValue.trim()}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Добавить'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setNewValue(''); }}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="mb-5">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Shield className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">{search ? 'Ничего не найдено' : 'Блок-лист пуст'}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {filtered.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-5 py-3 hover:bg-zinc-50">
              <span className="text-sm font-medium text-zinc-800">{e.value}</span>
              <span className="text-xs text-zinc-400">
                {e.timestamp_created ? new Date(e.timestamp_created).toLocaleDateString('ru-RU') : ''}
              </span>
            </div>
          ))}
          <div className="px-5 py-3 text-xs text-zinc-400">{filtered.length} записей</div>
        </div>
      )}
    </div>
  );
}
