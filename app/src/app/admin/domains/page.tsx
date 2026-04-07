'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import { RefreshCw, AlertTriangle, Globe, ExternalLink } from 'lucide-react';

interface Domain {
  dname: string;
  service_id: string;
  state: 'A' | 'N' | 'S' | 'D' | 'O';
  creation_date: string;
  expiration_date: string;
  subtype: string;
  account: string;
}

const STATE_LABELS: Record<string, string> = {
  A: 'Активен',
  N: 'Неактивен',
  S: 'Приостановлен',
  D: 'Удалён',
  O: 'Перенесён',
};

function daysUntil(dateStr: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function expirationBadge(days: number) {
  if (days < 0) {
    return { label: `Истёк ${Math.abs(days)} дн. назад`, className: 'bg-red-100 text-red-700 border-red-200' };
  }
  if (days <= 14) {
    return { label: `${days} дн.`, className: 'bg-red-100 text-red-700 border-red-200' };
  }
  if (days <= 30) {
    return { label: `${days} дн.`, className: 'bg-amber-100 text-amber-700 border-amber-200' };
  }
  if (days <= 90) {
    return { label: `${days} дн.`, className: 'bg-yellow-50 text-yellow-700 border-yellow-200' };
  }
  return { label: `${days} дн.`, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const ACCOUNT_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-purple-100 text-purple-700',
  'bg-teal-100 text-teal-700',
  'bg-pink-100 text-pink-700',
  'bg-orange-100 text-orange-700',
];

export default function AdminDomainsPage() {
  const isTma = useIsTma();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [filterAccount, setFilterAccount] = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const loadDomains = useCallback(async () => {
    setLoading(true);
    setError('');
    setWarnings([]);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/api/admin/domains', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j?.error ?? res.statusText);
      }
      const data = await res.json() as { domains: Domain[]; accounts: string[]; errors?: string[] };
      setDomains(data.domains);
      setAccounts(data.accounts);
      if (data.errors?.length) setWarnings(data.errors);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { void loadDomains(); }, [loadDomains]);

  const accountColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    accounts.forEach((a, i) => { map[a] = ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]; });
    return map;
  }, [accounts]);

  const filtered = useMemo(
    () => filterAccount ? domains.filter((d) => d.account === filterAccount) : domains,
    [domains, filterAccount],
  );

  const stats = useMemo(() => {
    const expired = filtered.filter((d) => daysUntil(d.expiration_date) < 0).length;
    const urgent = filtered.filter((d) => { const dd = daysUntil(d.expiration_date); return dd >= 0 && dd <= 30; }).length;
    const ok = filtered.length - expired - urgent;
    return { total: filtered.length, expired, urgent, ok };
  }, [filtered]);

  const gridCols = 'sm:grid-cols-[minmax(140px,1fr)_100px_100px_100px_80px_80px]';

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold text-gray-900`}>
            Мониторинг доменов
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Reg.ru — статус и сроки истечения доменов
          </p>
        </div>
        <button
          onClick={loadDomains}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {warnings.map((w, i) => (
        <div key={i} className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          {w}
        </div>
      ))}

      {loading && domains.length === 0 ? (
        <div className="flex items-center gap-3 py-12 justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-600" />
          <span className="text-gray-500">Загрузка доменов из Reg.ru...</span>
        </div>
      ) : (
        <>
          {/* Stats */}
          {domains.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
                <div className="text-xs text-gray-500 mt-1">Всего доменов</div>
              </div>
              <div className={`border rounded-xl p-4 ${stats.expired > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
                <div className={`text-2xl font-bold ${stats.expired > 0 ? 'text-red-600' : 'text-gray-900'}`}>{stats.expired}</div>
                <div className={`text-xs mt-1 ${stats.expired > 0 ? 'text-red-500' : 'text-gray-500'}`}>Истекли</div>
              </div>
              <div className={`border rounded-xl p-4 ${stats.urgent > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
                <div className={`text-2xl font-bold ${stats.urgent > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{stats.urgent}</div>
                <div className={`text-xs mt-1 ${stats.urgent > 0 ? 'text-amber-500' : 'text-gray-500'}`}>Истекают ≤30 дн.</div>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="text-2xl font-bold text-emerald-600">{stats.ok}</div>
                <div className="text-xs text-gray-500 mt-1">В порядке</div>
              </div>
            </div>
          )}

          {/* Account filter */}
          {accounts.length > 1 && (
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-xs text-gray-500">Аккаунт:</span>
              <button
                onClick={() => setFilterAccount(null)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  filterAccount === null
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                Все
              </button>
              {accounts.map((a) => (
                <button
                  key={a}
                  onClick={() => setFilterAccount(filterAccount === a ? null : a)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    filterAccount === a
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          )}

          {/* Domain table */}
          <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
            <div className="min-w-[700px]">
            <div className={`hidden ${gridCols} bg-gray-50 border-b border-gray-200 text-sm`}>
              <div className="px-3 py-2.5 font-medium text-gray-600">Домен</div>
              <div className="px-3 py-2.5 font-medium text-gray-600">Аккаунт</div>
              <div className="px-3 py-2.5 font-medium text-gray-600">Создан</div>
              <div className="px-3 py-2.5 font-medium text-gray-600">Истекает</div>
              <div className="px-3 py-2.5 font-medium text-gray-600">Осталось</div>
              <div className="px-3 py-2.5 font-medium text-gray-600">Статус</div>
            </div>

            {filtered.length === 0 && !loading && (
              <div className="px-4 py-12 text-center text-gray-400 text-sm">
                {domains.length === 0
                  ? 'Нет доменов или не настроена переменная REGRU_ACCOUNTS'
                  : 'Нет доменов для выбранного фильтра'}
              </div>
            )}

            {filtered.map((d) => {
              const days = daysUntil(d.expiration_date);
              const badge = expirationBadge(days);
              const isExpired = days < 0;

              return (
                <div
                  key={`${d.account}-${d.service_id}`}
                  className={`grid grid-cols-1 ${gridCols} items-center border-b border-gray-100 last:border-b-0 ${
                    isExpired ? 'bg-red-50/40' : days <= 30 ? 'bg-amber-50/30' : 'hover:bg-blue-50/30'
                  }`}
                >
                  <div className="px-3 py-3 flex items-center gap-2 min-w-0">
                    <Globe className={`h-4 w-4 flex-shrink-0 ${isExpired ? 'text-red-400' : 'text-blue-500'}`} />
                    <span className="font-medium text-gray-900 truncate text-sm">{d.dname}</span>
                    <a
                      href={`https://${d.dname}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 text-gray-300 hover:text-blue-500 transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>

                  <div className="px-3 py-1 sm:py-3">
                    <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full truncate max-w-full ${accountColorMap[d.account] ?? 'bg-gray-100 text-gray-600'}`}>
                      {d.account}
                    </span>
                  </div>

                  <div className="px-3 py-1 sm:py-3 text-xs text-gray-500 whitespace-nowrap">
                    <span className="sm:hidden text-xs text-gray-400 mr-1">Создан:</span>
                    {formatDate(d.creation_date)}
                  </div>

                  <div className="px-3 py-1 sm:py-3 text-xs text-gray-500 whitespace-nowrap">
                    <span className="sm:hidden text-xs text-gray-400 mr-1">Истекает:</span>
                    {formatDate(d.expiration_date)}
                  </div>

                  <div className="px-3 py-1 sm:py-3">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${badge.className}`}>
                      {badge.label}
                    </span>
                  </div>

                  <div className="px-3 py-1 pb-3 sm:py-3 text-xs text-gray-500 whitespace-nowrap">
                    <span className="sm:hidden text-xs text-gray-400 mr-1">Статус:</span>
                    {STATE_LABELS[d.state] ?? d.state}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
