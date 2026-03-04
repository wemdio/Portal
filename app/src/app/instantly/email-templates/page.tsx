'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, FileText, Plus, Search,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { EmailTemplate, PaginatedResponse } from '@/lib/instantly/types';

export default function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newBody, setNewBody] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await instantlyFetch<PaginatedResponse<EmailTemplate>>('/email-templates');
      setTemplates(data.items ?? []);
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
      const tmpl = await instantlyFetch<EmailTemplate>('/email-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          subject: newSubject.trim() || undefined,
          body: newBody.trim() || undefined,
        }),
      });
      setTemplates((prev) => [tmpl, ...prev]);
      setNewName('');
      setNewSubject('');
      setNewBody('');
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания');
    } finally {
      setCreating(false);
    }
  }, [newName, newSubject, newBody]);

  const filtered = templates.filter((t) =>
    !search || (t.name ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">Email шаблоны</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors"
        >
          <Plus className="h-4 w-4" /> Создать шаблон
        </button>
      </div>

      {showCreate && (
        <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5">
          <h3 className="mb-4 text-sm font-semibold text-zinc-900">Новый шаблон</h3>
          <div className="space-y-3">
            <input type="text" placeholder="Название шаблона" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400" autoFocus />
            <input type="text" placeholder="Тема письма" value={newSubject} onChange={(e) => setNewSubject(e.target.value)} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400" />
            <textarea placeholder="Тело письма" value={newBody} onChange={(e) => setNewBody(e.target.value)} rows={5} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400 resize-y" />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => { setShowCreate(false); setNewName(''); setNewSubject(''); setNewBody(''); }} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors">Отмена</button>
              <button onClick={handleCreate} disabled={creating || !newName.trim()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Создать'}
              </button>
            </div>
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
          <FileText className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">{search ? 'Ничего не найдено' : 'Нет шаблонов'}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {filtered.map((t) => (
            <div key={t.id} className="px-5 py-4 hover:bg-zinc-50">
              <p className="text-sm font-medium text-zinc-800">{t.name ?? 'Template'}</p>
              {t.subject && <p className="mt-0.5 text-xs text-zinc-500">Тема: {t.subject}</p>}
              {t.body && <p className="mt-1 text-xs text-zinc-400 line-clamp-2 whitespace-pre-wrap">{t.body}</p>}
              <p className="mt-1 text-[10px] text-zinc-300">
                {t.timestamp_created ? new Date(t.timestamp_created).toLocaleDateString('ru-RU') : ''}
              </p>
            </div>
          ))}
          <div className="px-5 py-3 text-xs text-zinc-400">{filtered.length} шаблонов</div>
        </div>
      )}
    </div>
  );
}
