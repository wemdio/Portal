'use client';

import { useState, useMemo } from 'react';
import { Plus, Search, Trash2, Settings, ChevronUp, ChevronDown, Loader2 } from 'lucide-react';
import { useTgOutreachAccounts } from '@/lib/tgOutreach/hooks';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';
import { AddAccountModal } from './AddAccountModal';
import { AccountSettingsModal } from './AccountSettingsModal';
import { CheckDropdown } from './CheckDropdown';
import { UnblockDropdown } from './UnblockDropdown';
import type { TgOutreachAccount, TgOutreachTag, AccountStatus } from '@/lib/tgOutreach/types';

type SortKey = 'first_name' | 'phone' | 'username' | 'status' | 'created_at';
type SortDir = 'asc' | 'desc';

const STATUS_CONFIG: Record<AccountStatus, { label: string; cls: string }> = {
  active: { label: 'Активен', cls: 'bg-emerald-50 text-emerald-700' },
  banned: { label: 'Забанен', cls: 'bg-red-50 text-red-700' },
  frozen: { label: 'Заморожен', cls: 'bg-blue-50 text-blue-700' },
  limited: { label: 'Ограничен', cls: 'bg-amber-50 text-amber-700' },
};

interface Props {
  allTags: TgOutreachTag[];
  onTagsChange: () => void;
}

export function AccountsTab({ allTags, onTagsChange: _ }: Props) {
  const { accounts, loading, error, reload } = useTgOutreachAccounts();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<AccountStatus | null>(null);
  const [filterTagId, setFilterTagId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showAdd, setShowAdd] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    let list = accounts;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        a.first_name.toLowerCase().includes(q) ||
        a.last_name.toLowerCase().includes(q) ||
        a.phone.includes(q) ||
        a.username.toLowerCase().includes(q)
      );
    }
    if (filterStatus) {
      list = list.filter((a) => a.status === filterStatus);
    }
    if (filterTagId) {
      list = list.filter((a) => a.tags?.some((t) => t.id === filterTagId));
    }
    list.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [accounts, search, filterStatus, filterTagId, sortKey, sortDir]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((a) => a.id)));
  };

  const handleDeleteSelected = async () => {
    if (!selected.size) return;
    await Promise.all([...selected].map((id) => tgOutreachFetch(`/accounts/${id}`, { method: 'DELETE' })));
    setSelected(new Set());
    reload();
  };

  const handleDelete = async (id: string) => {
    await tgOutreachFetch(`/accounts/${id}`, { method: 'DELETE' });
    reload();
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
  };

  const uniqueTags = useMemo(() => {
    const map = new Map<string, TgOutreachTag>();
    accounts.forEach((a) => a.tags?.forEach((t) => map.set(t.id, t)));
    return [...map.values()];
  }, [accounts]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    accounts.forEach((a) => { counts[a.status] = (counts[a.status] ?? 0) + 1; });
    return counts;
  }, [accounts]);

  const settingsAccount = settingsId ? accounts.find((a) => a.id === settingsId) : null;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(Object.entries(STATUS_CONFIG) as [AccountStatus, { label: string; cls: string }][]).map(([status, cfg]) => (
          <button
            key={status}
            onClick={() => setFilterStatus(filterStatus === status ? null : status)}
            className={`rounded-xl border p-4 text-left transition-colors ${
              filterStatus === status ? 'border-blue-300 bg-blue-50/50' : 'border-zinc-200 hover:border-zinc-300'
            }`}
          >
            <div className="text-2xl font-bold text-zinc-900">{statusCounts[status] ?? 0}</div>
            <div className="mt-1">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
                {cfg.label}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по имени, телефону, юзернейму..."
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
            Добавить аккаунт
          </button>
        </div>
      </div>

      {/* Table */}
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
          <p className="text-zinc-500">Аккаунтов пока нет</p>
          <p className="text-sm text-zinc-400 mt-1">Добавьте первый аккаунт для начала работы.</p>
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
                    <button onClick={() => toggleSort('first_name')} className="flex items-center gap-1 text-xs font-medium text-zinc-500 uppercase">
                      Имя <SortIcon col="first_name" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button onClick={() => toggleSort('phone')} className="flex items-center gap-1 text-xs font-medium text-zinc-500 uppercase">
                      Телефон <SortIcon col="phone" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button onClick={() => toggleSort('username')} className="flex items-center gap-1 text-xs font-medium text-zinc-500 uppercase">
                      Username <SortIcon col="username" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button onClick={() => toggleSort('status')} className="flex items-center gap-1 text-xs font-medium text-zinc-500 uppercase">
                      Статус <SortIcon col="status" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Прокси</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Теги</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {filtered.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    selected={selected.has(account.id)}
                    onToggle={() => toggleSelect(account.id)}
                    onSettings={() => setSettingsId(account.id)}
                    onDelete={() => handleDelete(account.id)}
                    onReload={reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-400">
            {filtered.length} из {accounts.length} аккаунтов
          </div>
        </div>
      )}

      {showAdd && (
        <AddAccountModal
          allTags={allTags}
          onClose={() => setShowAdd(false)}
          onCreated={reload}
        />
      )}

      {settingsAccount && (
        <AccountSettingsModal
          account={settingsAccount}
          allTags={allTags}
          onClose={() => setSettingsId(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

function AccountRow({
  account,
  selected,
  onToggle,
  onSettings,
  onDelete,
  onReload,
}: {
  account: TgOutreachAccount;
  selected: boolean;
  onToggle: () => void;
  onSettings: () => void;
  onDelete: () => void;
  onReload: () => void;
}) {
  const statusCfg = STATUS_CONFIG[account.status] ?? STATUS_CONFIG.active;
  const proxy = account.proxy;

  return (
    <tr className={`hover:bg-zinc-50 ${selected ? 'bg-blue-50/30' : ''}`}>
      <td className="px-4 py-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="rounded border-zinc-300" />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {account.avatar_url ? (
            <img src={account.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover" />
          ) : (
            <div className="h-7 w-7 rounded-full bg-zinc-200 flex items-center justify-center text-xs font-medium text-zinc-500">
              {(account.first_name?.[0] ?? '?').toUpperCase()}
            </div>
          )}
          <div>
            <div className="font-medium text-zinc-800">
              {account.first_name} {account.last_name}
            </div>
            {account.format && (
              <span className="text-[10px] text-zinc-400 uppercase">{account.format}</span>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{account.phone || '—'}</td>
      <td className="px-4 py-3 text-zinc-600">
        {account.username ? `@${account.username}` : '—'}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusCfg.cls}`}>
          {statusCfg.label}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500">
        {proxy ? `${proxy.ip}:${proxy.port}` : '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {account.tags?.map((tag) => (
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
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <CheckDropdown accountId={account.id} onActionComplete={onReload} />
          <UnblockDropdown accountId={account.id} onActionComplete={onReload} />
          <button onClick={onSettings} className="p-1 text-zinc-400 hover:text-zinc-600 transition-colors">
            <Settings className="h-4 w-4" />
          </button>
          <button onClick={onDelete} className="p-1 text-zinc-400 hover:text-red-500 transition-colors">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
