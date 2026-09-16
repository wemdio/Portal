'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchReplies, type ReplyDto } from './api';

const FILTERS = [
  { id: 'human', label: 'Ответы людей' },
  { id: 'bounce', label: 'Недоставленные' },
  { id: 'auto_reply', label: 'Автоответы' },
  { id: 'all', label: 'Все' },
];

export function RepliesTab() {
  const [replies, setReplies] = useState<ReplyDto[]>([]);
  const [kind, setKind] = useState('human');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { replies: rows } = await fetchReplies(kind);
      setReplies(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить ответы');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setKind(filter.id)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              kind === filter.id ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : replies.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">Пока ничего нет.</p>
      ) : (
        <div className="space-y-3">
          {replies.map((reply) => (
            <div key={reply.id} className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-zinc-900">
                  {reply.from_name ? `${reply.from_name} · ` : ''}
                  {reply.from_email ?? 'без адреса'}
                </span>
                <span className="text-xs text-zinc-500">
                  {reply.received_at ? new Date(reply.received_at).toLocaleString('ru-RU') : ''}
                </span>
              </div>
              {reply.subject ? <div className="mt-1 text-sm text-zinc-700">{reply.subject}</div> : null}
              {reply.body ? (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600">
                  {reply.body.slice(0, 1200)}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
