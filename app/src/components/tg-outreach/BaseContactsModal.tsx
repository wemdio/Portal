'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Search, Trash2, X } from 'lucide-react';

import { authFetch } from '@/lib/authFetch';

/**
 * Контакты базы: посмотреть, поправить, удалить — не выгружая файл.
 *
 * До этого база была чёрным ящиком: видны только счётчики «всего / ждут /
 * отправлено». Чтобы убрать один неверный ник или поправить опечатку в тексте,
 * оператор выгружал триста строк, правил в таблице и заливал обратно — а
 * загрузка кладёт контакты заново, то есть теряет статусы отправки по всей
 * базе. Ради одной строки терялась история работы по остальным.
 */

const API_BASE = '/api/tools/tg-outreach';
const PAGE = 100;

interface Contact {
  id: string;
  username: string;
  message: string;
  status: string | null;
  skip_reason: string | null;
  attempts: number | null;
  sent_at: string | null;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: 'ждёт', cls: 'bg-gray-100 text-gray-600' },
  sent: { text: 'отправлено', cls: 'bg-emerald-50 text-emerald-700' },
  skipped: { text: 'пропущен', cls: 'bg-amber-50 text-amber-700' },
  failed: { text: 'отложен', cls: 'bg-rose-50 text-rose-700' },
};

export function BaseContactsModal({
  baseId,
  baseName,
  onClose,
  onChanged,
}: {
  baseId: string;
  baseName: string;
  onClose: () => void;
  /** База изменилась — списку баз пора перечитать счётчики. */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Строка, которую сейчас правят, и её черновик. */
  const [editing, setEditing] = useState<{ id: string; username: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (query.trim()) params.set('q', query.trim());
      const res = await authFetch(`${API_BASE}/bases/${baseId}/contacts?${params}`);
      const body = await res.json().catch(() => null) as { items?: Contact[]; total?: number; error?: string } | null;
      if (!res.ok) { setError(body?.error ?? `Ошибка ${res.status}`); return; }
      setItems(body?.items ?? []);
      setTotal(body?.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [baseId, offset, query]);

  // Полсекунды тишины — и запрос уходит: поиск набирают по буквам.
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, query ? 500 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  const saveEdit = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${baseId}/contacts/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: editing.username, message: editing.message }),
      });
      const body = await res.json().catch(() => null) as (Contact & { error?: string }) | null;
      if (!res.ok) { setError(body?.error ?? 'Не сохранилось'); return; }
      setItems((prev) => prev.map((c) => (c.id === editing.id ? { ...c, ...body } : c)));
      setEditing(null);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const removeContact = async (contact: Contact) => {
    if (!confirm(`Удалить @${contact.username} из базы? Контакт исчезнет из очереди.`)) return;
    setBusyId(contact.id);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${baseId}/contacts/${contact.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? 'Не удалилось');
        return;
      }
      setItems((prev) => prev.filter((c) => c.id !== contact.id));
      setTotal((n) => Math.max(n - 1, 0));
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Очистка требует подтверждения числом строк.
   *
   * Действие необратимо и снимает всю базу разом, поэтому сервер сверяет
   * присланное число с фактическим: если кто-то залил контакты, пока окно было
   * открыто, очистка не пройдёт и попросит обновить список.
   */
  const clearAll = async () => {
    const ok = confirm(
      `Удалить все ${total} контактов из базы «${baseName}»? Сама база, её название и чаты-источники останутся. Отменить нельзя.`,
    );
    if (!ok) return;
    setBusyId('all');
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${baseId}/contacts?confirm_total=${total}`, { method: 'DELETE' });
      const body = await res.json().catch(() => null) as { error?: string; deleted?: number } | null;
      if (!res.ok) { setError(body?.error ?? 'Не получилось'); return; }
      setItems([]);
      setTotal(0);
      setOffset(0);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
            База «{baseName}» · контактов {total}
          </h3>
          <button
            type="button"
            disabled={busyId !== null || total === 0}
            onClick={() => void clearAll()}
            title="Удалить все контакты. База, её название и чаты-источники останутся."
            className="cursor-pointer rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[11px] font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busyId === 'all' ? 'Очищаю…' : 'Очистить базу'}
          </button>
          <button type="button" onClick={onClose} className="cursor-pointer rounded-lg p-1 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-gray-100 px-4 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOffset(0); }}
              placeholder="Поиск по нику или тексту сообщения"
              className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-2.5 text-xs outline-none focus:border-indigo-400"
            />
          </div>
        </div>

        {error && (
          <p className="mx-4 mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">{error}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-xs text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />Загрузка…
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-xs text-gray-400">
              {query.trim() ? 'Ничего не нашлось' : 'В базе нет контактов'}
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((c) => {
                const st = STATUS_LABEL[c.status ?? 'pending'] ?? STATUS_LABEL.pending;
                const isEditing = editing?.id === c.id;
                return (
                  <li key={c.id} className="rounded-lg border border-gray-100 px-3 py-2">
                    <div className="flex items-center gap-2">
                      {isEditing ? (
                        <input
                          value={editing.username}
                          onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                          className="w-48 rounded border border-gray-200 px-2 py-1 text-xs outline-none focus:border-indigo-400"
                        />
                      ) : (
                        <span className="text-xs font-medium text-gray-800">@{c.username}</span>
                      )}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${st.cls}`}>{st.text}</span>
                      {(c.attempts ?? 0) > 0 && (
                        <span className="text-[10px] text-gray-400">попыток {c.attempts}</span>
                      )}
                      {c.skip_reason && (
                        <span title={c.skip_reason} className="cursor-help truncate text-[10px] text-amber-700">
                          {c.skip_reason}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1">
                        {isEditing ? (
                          <>
                            <button type="button" disabled={busyId === c.id} onClick={() => void saveEdit()}
                              className="cursor-pointer rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700 disabled:opacity-50">
                              Сохранить
                            </button>
                            <button type="button" onClick={() => setEditing(null)}
                              className="cursor-pointer rounded px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100">
                              Отмена
                            </button>
                          </>
                        ) : (
                          <>
                            {/* Отправленный контакт не правим: текст уже ушёл
                                человеку, и подмена его в базе сделала бы
                                историю переписки неверной. */}
                            {c.status !== 'sent' && (
                              <button type="button"
                                onClick={() => setEditing({ id: c.id, username: c.username, message: c.message })}
                                className="cursor-pointer rounded px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100">
                                Править
                              </button>
                            )}
                            <button type="button" disabled={busyId === c.id} onClick={() => void removeContact(c)}
                              title="Удалить контакт из базы"
                              className="cursor-pointer rounded p-1 text-gray-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    {isEditing ? (
                      <textarea
                        value={editing.message}
                        onChange={(e) => setEditing({ ...editing, message: e.target.value })}
                        rows={3}
                        className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-[11px] outline-none focus:border-indigo-400"
                      />
                    ) : (
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-gray-500">{c.message}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-[11px] text-gray-500">
            <span>{offset + 1}–{Math.min(offset + PAGE, total)} из {total}</span>
            <span className="flex gap-2">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))}
                className="cursor-pointer rounded border border-gray-200 px-2 py-1 disabled:opacity-40">Назад</button>
              <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}
                className="cursor-pointer rounded border border-gray-200 px-2 py-1 disabled:opacity-40">Вперёд</button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
