'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

interface Suggestion {
  id: string;
  client: string;
  status: string;
  score: number;
}

interface UnlinkedRow {
  id: string;
  name: string;
  createdAt: string | null;
  contacted: number;
  accountId: string;
  /** Проекты, из карточек которых кампанию удалили руками. */
  removedBy: string[];
  suggestions: Suggestion[];
}

interface ProjectOption {
  id: string;
  client: string;
  status: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Нужно войти заново');
  return { Authorization: `Bearer ${session.access_token}` };
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: '2-digit' });
}

/**
 * Кампании Instantly, не привязанные ни к одному проекту. Автопривязка не
 * берёт на себя случаи, где на кампанию одинаково претендуют два проекта
 * («Markway медицина ОКДЕСК») или где имени проекта в названии нет вовсе, —
 * раньше такие кампании нигде не показывались и их ответы терялись.
 */
export function UnlinkedCampaignsView() {
  const [rows, setRows] = useState<UnlinkedRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  /** campaign_id → выбранный в списке проект, пока не нажали «Привязать». */
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/instantly/unlinked-campaigns?q=${encodeURIComponent(search)}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Ошибка ${res.status}`);
      setRows(json.rows ?? []);
      setProjects(json.projects ?? []);
      setTotal(json.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  const attach = useCallback(async (campaignId: string, projectId: string) => {
    setBusyId(campaignId);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/projects/${projectId}/campaigns`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `Ошибка ${res.status}`);
      const client = projects.find((p) => p.id === projectId)?.client ?? 'проекту';
      setDoneIds((current) => ({ ...current, [campaignId]: client }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось привязать кампанию');
    } finally {
      setBusyId(null);
    }
  }, [projects]);

  const visible = useMemo(() => rows.filter((r) => !doneIds[r.id]), [rows, doneIds]);
  const attachedCount = Object.keys(doneIds).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Кампании без проекта</h1>
          <p className="mt-1 text-sm text-gray-500">
            Портал не привязал их сам: на кампанию претендуют два проекта или имени проекта нет в названии.
            Пока кампания ничья, её ответы не видны ни в одном проекте.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title="Обновить"
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </div>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          placeholder="Найти кампанию по названию"
          aria-label="Найти кампанию по названию"
          className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-8 text-sm text-gray-900 focus:border-blue-400 focus:outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Очистить поиск"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-gray-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      {attachedCount > 0 ? (
        <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Привязано за этот заход: {attachedCount}. Ответы появятся в проекте после ближайшего синка.
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-gray-500">Загрузка...</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500">
          {search ? 'По этому поиску ничего нет.' : 'Все кампании Instantly разобраны по проектам.'}
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-400">
            {total > visible.length ? `Показаны ${visible.length} из ${total}, свежие сверху` : `Всего: ${visible.length}`}
          </p>
          <ul className="space-y-2">
            {visible.map((row) => {
              const selected = choice[row.id] ?? row.suggestions[0]?.id ?? '';
              return (
                <li key={row.id} className="rounded-xl border border-gray-200 bg-white p-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-gray-900">{row.name || row.id}</span>
                    <span className="text-xs text-gray-400">
                      {formatDate(row.createdAt)}
                      {row.contacted > 0 ? ` · контактов ${row.contacted}` : ''}
                      {row.accountId !== 'main' ? ` · ${row.accountId}` : ''}
                    </span>
                  </div>
                  {row.removedBy.length > 0 ? (
                    <p className="mt-1 text-xs text-amber-600">
                      Её убрали из карточки: {row.removedBy.join(', ')}
                    </p>
                  ) : null}
                  {row.suggestions.length > 1 ? (
                    <p className="mt-1 text-xs text-gray-500">
                      В названии звучат сразу несколько проектов — выберите нужный.
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select
                      value={selected}
                      onChange={(e) => setChoice((c) => ({ ...c, [row.id]: e.target.value }))}
                      aria-label="Проект"
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-blue-400 focus:outline-none"
                    >
                      <option value="">Выберите проект</option>
                      {row.suggestions.length > 0 ? (
                        <optgroup label="Подходят по названию">
                          {row.suggestions.map((s) => (
                            <option key={s.id} value={s.id}>{s.client}{s.status ? ` — ${s.status}` : ''}</option>
                          ))}
                        </optgroup>
                      ) : null}
                      <optgroup label="Все проекты">
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.client}{p.status ? ` — ${p.status}` : ''}</option>
                        ))}
                      </optgroup>
                    </select>
                    <button
                      type="button"
                      onClick={() => selected && attach(row.id, selected)}
                      disabled={!selected || busyId === row.id}
                      className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busyId === row.id ? 'Привязываю...' : 'Привязать'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
