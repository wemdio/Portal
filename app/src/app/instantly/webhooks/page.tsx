'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Webhook, Plus, TestTube, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Webhook as WebhookType, WebhookEventType, PaginatedResponse } from '@/lib/instantly/types';

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookType[]>([]);
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [wData, etData] = await Promise.all([
        instantlyFetch<PaginatedResponse<WebhookType>>('/webhooks'),
        instantlyFetch<WebhookEventType[]>('/webhooks?type=event-types').catch(() => []),
      ]);
      setWebhooks(wData.items ?? []);
      setEventTypes(Array.isArray(etData) ? etData : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim() || !newUrl.trim() || newEvents.length === 0) return;
    setCreating(true);
    try {
      const webhook = await instantlyFetch<WebhookType>('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), url: newUrl.trim(), event_types: newEvents }),
      });
      setWebhooks((prev) => [webhook, ...prev]);
      setNewName('');
      setNewUrl('');
      setNewEvents([]);
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания');
    } finally {
      setCreating(false);
    }
  }, [newName, newUrl, newEvents]);

  const handleTest = useCallback(async (id: string) => {
    setTestingId(id);
    try {
      await instantlyFetch(`/webhooks/${id}`, { method: 'POST' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка тестирования');
    } finally {
      setTestingId(null);
    }
  }, []);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      const updated = await instantlyFetch<WebhookType>(`/webhooks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !enabled }),
      });
      setWebhooks((prev) => prev.map((w) => (w.id === id ? updated : w)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  }, []);

  const toggleEvent = (eventName: string) => {
    setNewEvents((prev) =>
      prev.includes(eventName) ? prev.filter((e) => e !== eventName) : [...prev, eventName],
    );
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Webhooks</h1>
          <p className="mt-1 text-sm text-zinc-500">Уведомления о событиях в Instantly</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors"
        >
          <Plus className="h-4 w-4" /> Создать
        </button>
      </div>

      {showCreate && (
        <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5">
          <h3 className="mb-4 text-sm font-semibold text-zinc-900">Новый webhook</h3>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Название"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
            />
            <input
              type="url"
              placeholder="URL (https://...)"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
            />
            {eventTypes.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-500">Типы событий</p>
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                  {eventTypes.map((et) => (
                    <button
                      key={et.name}
                      onClick={() => toggleEvent(et.name)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        newEvents.includes(et.name)
                          ? 'bg-zinc-900 text-white'
                          : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
                      }`}
                    >
                      {et.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => { setShowCreate(false); setNewName(''); setNewUrl(''); setNewEvents([]); }} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700 transition-colors">Отмена</button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim() || !newUrl.trim() || newEvents.length === 0}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : webhooks.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Webhook className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">Нет webhooks</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {webhooks.map((w) => (
            <div key={w.id} className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800">{w.name ?? 'Webhook'}</p>
                <p className="text-xs text-zinc-400 truncate">{w.url}</p>
                {w.event_types && w.event_types.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {w.event_types.map((et) => (
                      <span key={et} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{et}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggle(w.id, w.enabled ?? true)}
                  className="text-zinc-400 hover:text-zinc-600 transition-colors"
                  title={w.enabled ? 'Отключить' : 'Включить'}
                >
                  {w.enabled !== false ? (
                    <ToggleRight className="h-6 w-6 text-emerald-500" />
                  ) : (
                    <ToggleLeft className="h-6 w-6" />
                  )}
                </button>
                <button
                  onClick={() => handleTest(w.id)}
                  disabled={testingId === w.id}
                  className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors disabled:opacity-50"
                  title="Тестировать"
                >
                  {testingId === w.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube className="h-4 w-4" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
