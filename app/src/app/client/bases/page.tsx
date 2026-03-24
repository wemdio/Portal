'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Database, Search } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import type { LeadList } from '@/lib/instantly/types';

export default function ClientBasesPage() {
  const [lists, setLists] = useState<LeadList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<{ items: LeadList[] }>('/lead-lists');
      setLists(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = lists.filter((l) =>
    !search || l.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Базы</h1>
        <p className="mt-1 text-sm text-zinc-500">Lead-списки из ваших кампаний</p>
      </div>

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
          <Database className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">{search ? 'Ничего не найдено' : 'В кампаниях нет загруженных списков'}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {filtered.map((l) => (
            <div
              key={l.id}
              className="flex items-center justify-between px-5 py-3.5"
            >
              <div>
                <p className="text-sm font-medium text-zinc-800">{l.name}</p>
                <p className="text-xs text-zinc-400">
                  {l.timestamp_created ? new Date(l.timestamp_created).toLocaleDateString('ru-RU') : ''}
                </p>
              </div>
              <span className="text-xs text-zinc-400 font-mono">ID: {l.id.slice(0, 8)}...</span>
            </div>
          ))}
          <div className="px-5 py-3 text-xs text-zinc-400">{filtered.length} списков</div>
        </div>
      )}
    </div>
  );
}
