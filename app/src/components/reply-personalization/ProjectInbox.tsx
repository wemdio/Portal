'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchReplies } from './api';
import { ReplyDetailPanel } from './ReplyDetailPanel';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

function formatDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function ProjectInbox({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ReplyListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsKb, setNeedsKb] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchReplies(projectId)
      .then((res) => {
        setItems(res.replies);
        setNeedsKb(res.needsKnowledgeBase);
        setSelectedId((current) => current ?? res.replies[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить письма'))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  if (needsKb) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        У проекта не заполнена база знаний — откройте «Настроить базу знаний».
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(320px,2fr)_3fr]">
      <div className="flex flex-col border-r border-zinc-200 bg-white">
        <div className="flex-1 overflow-y-auto divide-y divide-zinc-100">
          {loading ? <div className="p-4 text-sm text-zinc-500">Загрузка...</div> : null}
          {error ? <div className="p-4 text-sm text-red-600">{error}</div> : null}
          {!loading && !items.length ? (
            <div className="p-4 text-sm text-zinc-500">Пока никто не ответил.</div>
          ) : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className={`block w-full px-3 py-2.5 text-left ${
                selectedId === item.id ? 'bg-zinc-100' : 'hover:bg-zinc-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-900">
                  {item.companyName || item.leadEmail}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-[11px] ${
                    item.listStatus === 'sent' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                  }`}
                >
                  {item.listStatus === 'sent' ? 'отправлено' : 'новый'}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-zinc-500">{item.replyBody}</div>
              <div className="mt-0.5 text-[11px] text-zinc-400">{formatDate(item.replyTimestamp)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-y-auto bg-white">
        {selected ? (
          <ReplyDetailPanel key={selected.id} projectId={projectId} item={selected} onHandled={load} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Выберите письмо из списка
          </div>
        )}
      </div>
    </div>
  );
}
