'use client';

import { useState, useMemo } from 'react';
import { Plus, Search, Trash2, Pencil, ChevronUp, ChevronDown, Loader2 } from 'lucide-react';
import { useTgOutreachProxies } from '@/lib/tgOutreach/hooks';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';
import { AddProxyModal } from './AddProxyModal';
import type { TgOutreachProxy, TgOutreachTag } from '@/lib/tgOutreach/types';

type SortKey = 'ip' | 'port' | 'type' | 'created_at';
type SortDir = 'asc' | 'desc';

interface Props {
  allTags: TgOutreachTag[];
  onTagsChange: () => void;
}

export function ProxiesTab({ allTags, onTagsChange: _ }: Props) {
  const { proxies, loading, error, reload } = useTgOutreachProxies();
  const [search, setSearch] = useState('');
  const [filterTagId, setFilterTagId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    let list = proxies;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        p.ip.toLowerCase().includes(q) ||
        p.notes.toLowerCase().includes(q) ||
        String(p.port).includes(q)
      );
    }
    if (filterTagId) {
      list = list.filter((p) => p.tags?.some((t) => t.id === filterTagId));
    }
    list.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      const cmp = typeof aVal === 'number' ? aVal - (bVal as number) : String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [proxies, search, filterTagId, sortKey, sortDir]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((p) => p.id)));
  };

  const handleDeleteSelected = async () => {
    if (!selected.size) return;
    await Promise.all([...selected].map((id) => tgOutreachFetch(`/proxies/${id}`, { method: 'DELETE' })));
    setSelected(new Set());
    reload();
  };

  const handleDelete = async (id: string) => {
    await tgOutreachFetch(`/proxies/${id}`, { method: 'DELETE' });
    reload();
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
  };

  const uniqueTags = useMemo(() => {
    const map = new Map<string, TgOutreachTag>();
    proxies.forEach((p) => p.tags?.forEach((t) => map.set(t.id, t)));
    return [...map.values()];
  }, [proxies]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по IP, порту, заметкам..."
            className="w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>

        {uniqueTags.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setFilterTagId(null)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                !filterTagId ? 'bg-zinc-200 text-zinc-800' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
              }`}
            >
              Все
            </button>
            {uniqueTags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => setFilterTagId(filterTagId === tag.id ? null : tag.id)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  filterTagId === tag.id ? 'ring-2 ring-offset-1 ring-blue-400' : 'opacity-70 hover:opacity-100'
                }`}
                style={{ backgroundColor: tag.color + '20', color: tag.color }}
              >
                {tag.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2 ml-auto">
          {selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 hover:bg-red-100 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              Удалить ({selected.size})
            </button>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Добавить прокси
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-10 text-center">
          <p className="text-zinc-500">Прокси пока нет</p>
          <p className="text-sm text-zinc-400 mt-1">Добавьте первый прокси для начала работы.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === filtered.length && filtered.length > 0}
                      onChange={toggleAll}
                      className="rounded border-zinc-300"
                    />
                  </th>
                  <th className="px-4 py-3">
                    <button onClick={() => toggleSort('ip')} className="flex items-center gap-1 text-xs font-medium text-zinc-500 uppercase">
                      IP:Port <SortIcon col="ip" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button onClick={() => toggleSort('type')} className="flex items-center gap-1 text-xs font-medium text-zinc-500 uppercase">
                      Тип <SortIcon col="type" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Логин</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Теги</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Заметки</th>
                  <th className="px-4 py-3 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {filtered.map((proxy) => (
                  <ProxyRow
                    key={proxy.id}
                    proxy={proxy}
                    selected={selected.has(proxy.id)}
                    onToggle={() => toggleSelect(proxy.id)}
                    onDelete={() => handleDelete(proxy.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-400">
            {filtered.length} из {proxies.length} прокси
          </div>
        </div>
      )}

      {showAdd && (
        <AddProxyModal
          allTags={allTags}
          onClose={() => setShowAdd(false)}
          onCreated={reload}
        />
      )}
    </div>
  );
}

function ProxyRow({
  proxy,
  selected,
  onToggle,
  onDelete,
}: {
  proxy: TgOutreachProxy;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className={`hover:bg-zinc-50 ${selected ? 'bg-blue-50/30' : ''}`}>
      <td className="px-4 py-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="rounded border-zinc-300" />
      </td>
      <td className="px-4 py-3 font-mono text-sm text-zinc-800">
        {proxy.ip}:{proxy.port}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
          {proxy.type}
        </span>
      </td>
      <td className="px-4 py-3 text-zinc-600">{proxy.login || '—'}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {proxy.tags?.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: tag.color + '20', color: tag.color }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-3 text-zinc-500 max-w-[200px] truncate">{proxy.notes || '—'}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <button className="p-1 text-zinc-400 hover:text-zinc-600 transition-colors">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={onDelete} className="p-1 text-zinc-400 hover:text-red-500 transition-colors">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
