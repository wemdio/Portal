'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Search, Mail, Flame, Tag, Plus, X, Check,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Account, CustomTag } from '@/lib/instantly/types';
import {
  AccountStatus, AccountStatusLabels,
  WarmupStatus, WarmupStatusLabels,
  ProviderLabels,
} from '@/lib/instantly/types';

interface TagMapping {
  id: string;
  tag_id: string;
  resource_id: string;
  resource_type: string;
}

function statusDot(status: number): string {
  switch (status) {
    case AccountStatus.Active: return 'bg-emerald-400';
    case AccountStatus.Paused: return 'bg-amber-400';
    case AccountStatus.Maintenance: return 'bg-blue-400';
    default: return 'bg-red-400';
  }
}

function warmupBadge(ws: number) {
  const cls =
    ws === WarmupStatus.Active ? 'bg-emerald-50 text-emerald-700' :
    ws === WarmupStatus.Paused ? 'bg-zinc-100 text-zinc-600' :
    'bg-red-50 text-red-700';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Flame className="h-3 w-3" />
      {WarmupStatusLabels[ws] ?? `${ws}`}
    </span>
  );
}

const TAG_COLORS = [
  'bg-blue-50 text-blue-700 border-blue-200',
  'bg-purple-50 text-purple-700 border-purple-200',
  'bg-amber-50 text-amber-700 border-amber-200',
  'bg-emerald-50 text-emerald-700 border-emerald-200',
  'bg-rose-50 text-rose-700 border-rose-200',
  'bg-cyan-50 text-cyan-700 border-cyan-200',
  'bg-orange-50 text-orange-700 border-orange-200',
  'bg-indigo-50 text-indigo-700 border-indigo-200',
];

function tagColor(index: number) {
  return TAG_COLORS[index % TAG_COLORS.length];
}

function TagDropdown({
  accountEmail,
  allTags,
  assignedTagIds,
  tagColorMap,
  onToggle,
}: {
  accountEmail: string;
  allTags: CustomTag[];
  assignedTagIds: Set<string>;
  tagColorMap: Map<string, number>;
  onToggle: (tagId: string, accountEmail: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleToggle = async (tagId: string) => {
    setToggling(tagId);
    try {
      await onToggle(tagId, accountEmail);
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="rounded-md p-1 text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
        title="Управление тегами"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-zinc-200 bg-white shadow-lg">
          <div className="p-2 text-xs font-medium text-zinc-400 uppercase">Теги</div>
          <div className="max-h-48 overflow-y-auto">
            {allTags.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-zinc-400">Нет тегов</div>
            )}
            {allTags.map((t) => {
              const assigned = assignedTagIds.has(t.id);
              const colorIdx = tagColorMap.get(t.id) ?? 0;
              return (
                <button
                  key={t.id}
                  onClick={() => handleToggle(t.id)}
                  disabled={toggling === t.id}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 transition-colors"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${assigned ? 'border-zinc-900 bg-zinc-900' : 'border-zinc-300'}`}>
                    {assigned && <Check className="h-3 w-3 text-white" />}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tagColor(colorIdx)}`}>
                    {t.name}
                  </span>
                  {toggling === t.id && <Loader2 className="ml-auto h-3 w-3 animate-spin text-zinc-400" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [allTags, setAllTags] = useState<CustomTag[]>([]);
  const [mappings, setMappings] = useState<TagMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filterTagId, setFilterTagId] = useState<string | null>(null);
  const [warmupAction, setWarmupAction] = useState<string | null>(null);

  const tagColorMap = React.useMemo(() => {
    const m = new Map<string, number>();
    allTags.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [allTags]);

  const accountTagsMap = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const mapping of mappings) {
      if (mapping.resource_type !== 'account') continue;
      if (!m.has(mapping.resource_id)) m.set(mapping.resource_id, new Set());
      m.get(mapping.resource_id)!.add(mapping.tag_id);
    }
    return m;
  }, [mappings]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [accountsData, tagsData, mappingsData] = await Promise.all([
        instantlyFetch<{ items: Account[] }>('/accounts?limit=all'),
        instantlyFetch<{ items: CustomTag[] }>('/tags?limit=all'),
        instantlyFetch<{ items: TagMapping[] }>('/tag-mappings?limit=all&resource_type=account'),
      ]);
      setAccounts(accountsData.items ?? []);
      setAllTags(tagsData.items ?? []);
      setMappings(mappingsData.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = accounts.filter((a) => {
    if (filterTagId) {
      const tags = accountTagsMap.get(a.email);
      if (!tags || !tags.has(filterTagId)) return false;
    }
    if (!search) return true;
    const q = search.toLowerCase();
    return a.email.toLowerCase().includes(q) ||
      (a.first_name ?? '').toLowerCase().includes(q) ||
      (a.last_name ?? '').toLowerCase().includes(q);
  });

  const handleWarmup = useCallback(async (email: string, action: 'enable' | 'disable') => {
    setWarmupAction(email);
    try {
      await instantlyFetch('/accounts/warmup', {
        method: 'POST',
        body: JSON.stringify({ emails: [email], action }),
      });
      setAccounts((prev) =>
        prev.map((a) =>
          a.email === email
            ? { ...a, warmup_status: action === 'enable' ? WarmupStatus.Active : WarmupStatus.Paused }
            : a,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setWarmupAction(null);
    }
  }, []);

  const handleToggleTag = useCallback(async (tagId: string, accountEmail: string) => {
    try {
      await instantlyFetch('/tags', {
        method: 'POST',
        body: JSON.stringify({
          action: 'toggle',
          tag_id: tagId,
          resource_id: accountEmail,
          resource_type: 'account',
        }),
      });
      setMappings((prev) => {
        const existing = prev.find(
          (m) => m.tag_id === tagId && m.resource_id === accountEmail && m.resource_type === 'account',
        );
        if (existing) {
          return prev.filter((m) => m !== existing);
        }
        return [...prev, { id: `temp-${Date.now()}`, tag_id: tagId, resource_id: accountEmail, resource_type: 'account' }];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  }, []);

  const activeCount = accounts.filter((a) => a.status === AccountStatus.Active).length;
  const warmupActiveCount = accounts.filter((a) => a.warmup_status === WarmupStatus.Active).length;
  const errorCount = accounts.filter((a) => a.status < 0).length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <h1 className="mb-2 text-2xl font-bold text-zinc-900">Аккаунты</h1>
      <p className="mb-6 text-sm text-zinc-500">Просмотр email-аккаунтов, управление прогревом и тегами</p>

      {!loading && (
        <div className="mb-6 grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="text-xs font-medium text-zinc-500">Активные</p>
            <p className="mt-1 text-2xl font-bold text-emerald-600">{activeCount}</p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="text-xs font-medium text-zinc-500">Прогрев активен</p>
            <p className="mt-1 text-2xl font-bold text-orange-500">{warmupActiveCount}</p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="text-xs font-medium text-zinc-500">С ошибками</p>
            <p className="mt-1 text-2xl font-bold text-red-500">{errorCount}</p>
          </div>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Поиск по email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 text-zinc-400" />
            {allTags.map((t, i) => (
              <button
                key={t.id}
                onClick={() => setFilterTagId(filterTagId === t.id ? null : t.id)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${
                  filterTagId === t.id
                    ? 'ring-2 ring-zinc-900 ring-offset-1 ' + tagColor(i)
                    : tagColor(i) + ' opacity-70 hover:opacity-100'
                }`}
              >
                {t.name}
              </button>
            ))}
            {filterTagId && (
              <button onClick={() => setFilterTagId(null)} className="ml-1 rounded-full p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white py-16 text-center">
          <Mail className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">{search || filterTagId ? 'Ничего не найдено' : 'Нет аккаунтов'}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50/50 text-left">
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Email</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Имя</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Провайдер</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Статус</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Прогрев</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Теги</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Score</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Лимит</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {filtered.map((a) => {
                  const acctTags = accountTagsMap.get(a.email) ?? new Set<string>();
                  return (
                    <tr key={a.email} className="hover:bg-zinc-50">
                      <td className="px-4 py-3 font-medium text-zinc-800 truncate max-w-[200px]">{a.email}</td>
                      <td className="px-4 py-3 text-zinc-500">{a.first_name} {a.last_name}</td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">{ProviderLabels[a.provider_code] ?? a.provider_code}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${statusDot(a.status)}`} />
                          <span className="text-xs">{AccountStatusLabels[a.status] ?? `${a.status}`}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3">{warmupBadge(a.warmup_status)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          {allTags
                            .filter((t) => acctTags.has(t.id))
                            .map((t) => (
                              <span
                                key={t.id}
                                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${tagColor(tagColorMap.get(t.id) ?? 0)}`}
                              >
                                {t.name}
                              </span>
                            ))}
                          <TagDropdown
                            accountEmail={a.email}
                            allTags={allTags}
                            assignedTagIds={acctTags}
                            tagColorMap={tagColorMap}
                            onToggle={handleToggleTag}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {a.stat_warmup_score != null ? (
                          <span className={`font-medium ${a.stat_warmup_score >= 80 ? 'text-emerald-600' : a.stat_warmup_score >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                            {a.stat_warmup_score}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-500">{a.daily_limit ?? '—'}</td>
                      <td className="px-4 py-3">
                        {a.warmup_status === WarmupStatus.Active ? (
                          <button
                            onClick={() => handleWarmup(a.email, 'disable')}
                            disabled={warmupAction === a.email}
                            className="text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50"
                          >
                            {warmupAction === a.email ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Стоп прогрев'}
                          </button>
                        ) : a.warmup_status === WarmupStatus.Paused ? (
                          <button
                            onClick={() => handleWarmup(a.email, 'enable')}
                            disabled={warmupAction === a.email}
                            className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                          >
                            {warmupAction === a.email ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Запуск прогрев'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-400">
            {filtered.length} из {accounts.length} аккаунтов
          </div>
        </div>
      )}
    </div>
  );
}
