'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { AddSuppressionModal } from './AddSuppressionModal';
import { fetchSuppressions, removeSuppression, type SuppressionDto, type SuppressionScope } from './api';

const SEARCH_DEBOUNCE_MS = 300;

const REASON_LABELS: Record<string, string> = {
  hard_bounce: 'отбойник',
  unsubscribe: 'отписка',
  manual: 'вручную',
  complaint: 'жалоба',
};

const SCOPES: { id: SuppressionScope; label: string }[] = [
  { id: 'global', label: 'Глобальный' },
  { id: 'campaign', label: 'По кампаниям' },
  { id: 'all', label: 'Все' },
];

/** Цвета кампаний: одна и та же кампания — всегда один цвет. */
const CAMPAIGN_TONES = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-violet-100 text-violet-700',
  'bg-amber-100 text-amber-700',
  'bg-pink-100 text-pink-700',
  'bg-cyan-100 text-cyan-700',
  'bg-orange-100 text-orange-700',
  'bg-lime-100 text-lime-700',
];

function campaignTone(campaignId: string): string {
  let hash = 0;
  for (const char of campaignId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CAMPAIGN_TONES[hash % CAMPAIGN_TONES.length];
}

/**
 * Стоп-лист (задача 5.3 хендоффа фич): общий и по кампаниям. Общий
 * пополняется и сам — отбойники, отказы SMTP, «стоп» в ответе; стоп-лист
 * кампании — только руками. Добавление — в окне, на экране только список.
 */
export function StoplistTab() {
  const [rows, setRows] = useState<SuppressionDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<SuppressionScope>('all');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(
    async (targetPage: number) => {
      try {
        const res = await fetchSuppressions({ page: targetPage, search: appliedSearch || undefined, scope });
        setRows(res.suppressions);
        setTotal(res.total);
        setPageSize(res.pageSize);
        if (res.suppressions.length === 0 && res.total > 0 && targetPage > 1) {
          setPage(Math.max(1, Math.ceil(res.total / res.pageSize)));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить стоп-лист');
      } finally {
        setLoading(false);
      }
    },
    [appliedSearch, scope],
  );

  useEffect(() => {
    setLoading(true);
    void load(page).finally(() => setLoading(false));
  }, [load, page]);

  useEffect(() => () => {
    if (timer) window.clearTimeout(timer);
  }, [timer]);

  const onSearch = (value: string) => {
    setSearch(value);
    if (timer) window.clearTimeout(timer);
    setTimer(window.setTimeout(() => {
      setAppliedSearch(value.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS));
  };

  const clearSearch = () => {
    if (timer) window.clearTimeout(timer);
    setSearch('');
    setAppliedSearch('');
    setPage(1);
  };

  const remove = async (row: SuppressionDto) => {
    const question = row.campaign_id
      ? `Снять ${row.email} со стоп-листа кампании «${row.campaign_name ?? ''}»?`
      : `Вернуть ${row.email} в рассылку? Новые кампании смогут ему писать.`;
    if (!window.confirm(question)) return;
    setError(null);
    try {
      await removeSuppression(row.email, row.campaign_id);
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось снять адрес');
    }
  };

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {/* Поиск над списком, а не в его шапке: он про весь стоп-лист, в том
          числе про переключатель «глобальный / по кампаниям». */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="relative w-full max-w-[30rem]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Поиск по адресу"
            aria-label="Поиск по адресу"
            className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-9 text-sm text-zinc-900"
          />
          {search ? (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Очистить поиск"
              title="Очистить поиск"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" />
          Добавить
        </button>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Стоп-лист ({total})</h2>
          <div className="inline-flex gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1">
            {SCOPES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={scope === item.id}
                onClick={() => {
                  setScope(item.id);
                  setPage(1);
                }}
                className={`rounded-lg px-3 py-1 text-sm font-medium transition-colors ${
                  scope === item.id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">
            {appliedSearch ? 'Под поиск не попал ни один адрес.' : 'Стоп-лист пуст.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="py-2 pl-5 pr-3 font-medium">Адрес</th>
                <th className="py-2 pr-3 font-medium">Кампания</th>
                <th className="py-2 pr-3 font-medium">Причина</th>
                <th className="py-2 pr-3 font-medium">Добавлен</th>
                <th className="py-2 pr-3 font-medium">Заметка</th>
                <th className="py-2 pr-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.campaign_id ?? 'global'}:${row.email}`} className="border-b border-zinc-100 last:border-0">
                  <td className="py-2 pl-5 pr-3 font-medium text-zinc-900">{row.email}</td>
                  <td className="py-2 pr-3">
                    {row.campaign_id ? (
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${campaignTone(row.campaign_id)}`}>
                        {row.campaign_name}
                      </span>
                    ) : (
                      <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">Глобально</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600">{REASON_LABELS[row.reason] ?? row.reason}</td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">
                    {new Date(row.created_at).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">{row.note ?? '—'}</td>
                  <td className="py-2 pr-5 text-right">
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      title="Снять со стоп-листа"
                      aria-label={`Снять ${row.email}`}
                      className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {total > pageSize ? (
          <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-zinc-500">Стр. {page} из {maxPage} · {total}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage || loading}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>

      {addOpen ? (
        <AddSuppressionModal
          onClose={() => setAddOpen(false)}
          onAdded={(text) => {
            setNotice(text);
            setError(null);
            void load(page);
          }}
        />
      ) : null}
    </div>
  );
}
