'use client';

import { useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/lib/authFetch';

type Props = {
  apiUrl: string;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  onClose: () => void;
};

export function ActivityTypesModal({ apiUrl, selected, onChange, onClose }: Props) {
  const [search, setSearch] = useState('');
  const [allTypes, setAllTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(apiUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { types: string[] };
        if (!cancelled) {
          setAllTypes(json.types ?? []);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Ошибка загрузки');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [apiUrl]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTypes;
    return allTypes.filter((t) => t.toLowerCase().includes(q));
  }, [search, allTypes]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((t) => selected.has(t));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allFilteredSelected) {
      for (const t of filtered) next.delete(t);
    } else {
      for (const t of filtered) next.add(t);
    }
    onChange(next);
  };

  const toggle = (type: string) => {
    const next = new Set(selected);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onChange(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-8 pt-6 pb-3">
          <h3 className="text-base font-semibold text-gray-900">Виды деятельности</h3>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-8 pb-3">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Быстрый поиск"
              className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
            />
          </div>
        </div>

        {!loading && !error && filtered.length > 0 && (
          <div className="px-8 pb-2">
            <label className="flex items-center gap-2 cursor-pointer py-1 hover:bg-gray-50 rounded px-1 -mx-1">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                ref={(el) => {
                  if (el) {
                    const someSelected = filtered.some((t) => selected.has(t));
                    el.indeterminate = !allFilteredSelected && someSelected;
                  }
                }}
                onChange={toggleAll}
                className="w-4 h-4 accent-blue-600 flex-shrink-0"
              />
              <span className="text-sm font-medium text-gray-700">
                {search.trim() ? `Выбрать все найденные (${filtered.length})` : `Выбрать все (${allTypes.length})`}
              </span>
            </label>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-8 pb-4">
          {loading && (
            <div className="text-sm text-gray-500 py-8 text-center">Загрузка...</div>
          )}
          {error && (
            <div className="text-sm text-red-600 py-8 text-center">{error}</div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-sm text-gray-500 py-8 text-center">Ничего не найдено</div>
          )}
          {filtered.map((type) => (
            <label
              key={type}
              className="flex items-center gap-2 cursor-pointer py-1 hover:bg-gray-50 rounded px-1 -mx-1"
            >
              <input
                type="checkbox"
                checked={selected.has(type)}
                onChange={() => toggle(type)}
                className="w-4 h-4 accent-blue-600 flex-shrink-0"
              />
              <span className="text-sm">{type}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between px-8 py-5 border-t border-gray-100">
          <span className="text-sm text-gray-500">
            Выбрано: {selected.size}
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Очистить
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(allTypes))}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Все
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-gray-900 px-8 py-3 text-base font-medium text-white hover:bg-gray-800 transition-colors"
            >
              Готово
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
