'use client';

import { useState, useEffect, useCallback } from 'react';
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
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Базы</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>Lead-списки из ваших кампаний</p>
      </div>

      <div className="mb-4 sm:mb-6 sm:max-w-sm">
        <input
          type="text"
          placeholder="Поиск..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="neu-input w-full py-2 sm:py-2.5 px-3 sm:px-4 text-sm"
        />
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
      ) : filtered.length === 0 ? (
        <div className="neu-card py-16 text-center">
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {search ? 'Ничего не найдено' : 'В кампаниях нет загруженных списков'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((l) => (
            <div key={l.id} className="neu-sm flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
              <div className="min-w-0 flex-1 mr-3">
                <p className="text-xs sm:text-sm font-semibold truncate">{l.name}</p>
                <p className="text-[10px] sm:text-xs mt-0.5" style={{ color: 'var(--cp-text-l)' }}>
                  {l.timestamp_created ? new Date(l.timestamp_created).toLocaleDateString('ru-RU') : ''}
                </p>
              </div>
              <span className="text-[10px] sm:text-[11px] font-mono shrink-0 hidden sm:inline" style={{ color: 'var(--cp-text-l)' }}>
                {l.id.slice(0, 8)}...
              </span>
            </div>
          ))}
          <p className="text-center text-xs pt-2" style={{ color: 'var(--cp-text-l)' }}>
            {filtered.length} {filtered.length === 1 ? 'список' : 'списков'}
          </p>
        </div>
      )}
    </div>
  );
}
