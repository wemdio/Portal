'use client';

/**
 * Чёрный список контактов клиента.
 *
 * Сюда попадают адреса, заблокированные из «Ответов» (негатив) или добавленные
 * вручную на этой странице. Все будущие запуски кампаний и ежедневные догрузки
 * авто-пайплайна отфильтровывают эти адреса ДО загрузки в Instantly — клиент
 * сам управляет тем, кому портал больше никогда не напишет.
 */

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ShieldOff, Trash2 } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

type BlocklistEntry = {
  id: string;
  email: string;
  reason: string | null;
  source: 'manual' | 'reply' | string;
  created_at: string;
};

const SOURCE_LABEL: Record<string, string> = {
  manual: 'вручную',
  reply: 'из ответов',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function ClientBlocklistPage() {
  const [items, setItems] = useState<BlocklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await clientApiFetch<{ items: BlocklistEntry[] }>('/blocklist');
      setItems(res.items);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    const email = newEmail.trim();
    if (!email || adding) return;
    setAdding(true);
    setAddError('');
    try {
      const res = await clientApiFetch<{ entry: BlocklistEntry }>('/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'manual' }),
      });
      // Очищаем ввод ТОЛЬКО при успехе; upsert-дубликат просто обновит строку.
      setNewEmail('');
      setItems((prev) => [res.entry, ...prev.filter((i) => i.id !== res.entry.id)]);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Не удалось добавить контакт');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (entry: BlocklistEntry) => {
    if (removingId) return;
    setRemovingId(entry.id);
    try {
      await clientApiFetch(`/blocklist/${entry.id}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((i) => i.id !== entry.id));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось удалить запись');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Чёрный список
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Адреса из этого списка не попадут в новые кампании — даже если окажутся в загружаемой
          базе. Блокируйте контакты с негативом прямо из «Ответов» или добавляйте вручную здесь.
        </p>
      </header>

      {/* ── Добавление вручную ─────────────────────────────────────────── */}
      <div className="neu-card p-5 sm:p-6">
        <p className="ds-eyebrow mb-3">
          01<span aria-hidden> → </span>добавить контакт
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
            }}
            placeholder="name@company.com"
            className="neu-input flex-1 px-3 py-2 text-sm"
            aria-label="Email для блокировки"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={adding || !newEmail.trim()}
            className="neu-btn shrink-0 px-4 py-2 text-xs font-semibold disabled:opacity-60"
          >
            {adding ? 'Добавляем...' : 'В чёрный список'}
          </button>
        </div>
        {addError && (
          <p className="text-xs mt-2" style={{ color: 'var(--cp-red)' }}>
            {addError}
          </p>
        )}
      </div>

      {/* ── Список ─────────────────────────────────────────────────────── */}
      <div className="neu-card p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="ds-eyebrow m-0">
            02<span aria-hidden> → </span>заблокированные контакты
            {items.length > 0 && ` · ${items.length.toLocaleString('ru-RU')}`}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold"
            style={{ color: 'var(--cp-text-m)' }}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Обновить
          </button>
        </div>

        {loadError && (
          <p className="text-xs mb-3" style={{ color: 'var(--cp-red)' }} role="alert">
            {loadError}
          </p>
        )}

        {loading ? (
          <p className="text-xs py-6 text-center" style={{ color: 'var(--cp-text-l)' }}>
            Загрузка...
          </p>
        ) : items.length === 0 ? (
          <div className="py-8 text-center">
            <ShieldOff
              className="h-6 w-6 mx-auto mb-2"
              style={{ color: 'var(--cp-text-l)' }}
              aria-hidden
            />
            <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
              Список пуст. Заблокируйте контакт из «Ответов» — кнопка «В чёрный список» под
              письмом — или добавьте email вручную выше.
            </p>
          </div>
        ) : (
          <ul className="m-0 p-0 list-none divide-y" style={{ borderColor: 'var(--cp-divider)' }}>
            {items.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate m-0" style={{ color: 'var(--cp-text)' }}>
                    {entry.email}
                  </p>
                  <p className="text-[11px] m-0 mt-0.5" style={{ color: 'var(--cp-text-l)' }}>
                    {SOURCE_LABEL[entry.source] ?? entry.source} · {formatDate(entry.created_at)}
                    {entry.reason ? ` · ${entry.reason}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemove(entry)}
                  disabled={removingId === entry.id}
                  className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold shrink-0 disabled:opacity-60"
                  style={{ color: 'var(--cp-text-m)' }}
                  aria-label={`Убрать ${entry.email} из чёрного списка`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                  {removingId === entry.id ? 'Удаляем...' : 'Убрать'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
