'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Tag, Plus, Search, Pencil, Check, X,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { CustomTag } from '@/lib/instantly/types';

export default function TagsPage() {
  const [tags, setTags] = useState<CustomTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await instantlyFetch<{ items: CustomTag[] }>('/tags?limit=all');
      setTags(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const tag = await instantlyFetch<CustomTag>('/tags', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setTags((prev) => [tag, ...prev]);
      setNewName('');
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания');
    } finally {
      setCreating(false);
    }
  }, [newName]);

  const handleSave = useCallback(async (id: string) => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const updated = await instantlyFetch<CustomTag>(`/tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editName.trim() }),
      });
      setTags((prev) => prev.map((t) => (t.id === id ? updated : t)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  }, [editName]);

  const filtered = tags.filter((t) =>
    !search || (t.name ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">Теги</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors"
        >
          <Plus className="h-4 w-4" /> Создать тег
        </button>
      </div>

      {showCreate && (
        <div className="mb-5 rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Название тега"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              autoFocus
            />
            <button onClick={handleCreate} disabled={creating || !newName.trim()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Создать'}
            </button>
            <button onClick={() => { setShowCreate(false); setNewName(''); }} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors">Отмена</button>
          </div>
        </div>
      )}

      <div className="mb-5">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input type="text" placeholder="Поиск..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400" />
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Tag className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">{search ? 'Ничего не найдено' : 'Нет тегов'}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {filtered.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-zinc-50">
              {editingId === t.id ? (
                <div className="flex flex-1 items-center gap-2">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSave(t.id)}
                    className="flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
                    autoFocus
                  />
                  <button onClick={() => handleSave(t.id)} disabled={saving} className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50"><Check className="h-4 w-4" /></button>
                  <button onClick={() => setEditingId(null)} className="text-zinc-400 hover:text-zinc-600"><X className="h-4 w-4" /></button>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium text-zinc-800">{t.name}</span>
                  <button
                    onClick={() => { setEditingId(t.id); setEditName(t.name); }}
                    className="rounded-md p-1.5 text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="px-5 py-3 text-xs text-zinc-400">{filtered.length} тегов</div>
        </div>
      )}
    </div>
  );
}
