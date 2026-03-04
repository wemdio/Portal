'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  ChevronLeft, Loader2, Search, Mail, Flame, AlertTriangle, Shield,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Account } from '@/lib/instantly/types';
import {
  AccountStatus, AccountStatusLabels,
  WarmupStatus, WarmupStatusLabels,
  ProviderLabels,
} from '@/lib/instantly/types';

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

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [warmupAction, setWarmupAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await instantlyFetch<{ items: Account[] }>('/accounts?limit=all');
      setAccounts(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = accounts.filter((a) => {
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

  const activeCount = accounts.filter((a) => a.status === AccountStatus.Active).length;
  const warmupActiveCount = accounts.filter((a) => a.warmup_status === WarmupStatus.Active).length;
  const errorCount = accounts.filter((a) => a.status < 0).length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
        <ChevronLeft className="h-3 w-3" /> Instantly
      </Link>
      <h1 className="mb-2 text-2xl font-bold text-zinc-900">Аккаунты</h1>
      <p className="mb-6 text-sm text-zinc-500">Просмотр email-аккаунтов и управление прогревом</p>

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

      <div className="mb-5">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Поиск по email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>
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
          <p className="mt-3 text-sm text-zinc-500">{search ? 'Ничего не найдено' : 'Нет аккаунтов'}</p>
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
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Score</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase text-right">Лимит</th>
                  <th className="px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {filtered.map((a) => (
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
                ))}
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
