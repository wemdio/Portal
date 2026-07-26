'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Send, Loader2, Search, Play, Pause, ChevronLeft, ExternalLink,
} from 'lucide-react';
import { instantlyFetch } from '@/lib/instantly/fetcher';
import type { Campaign, PaginatedResponse } from '@/lib/instantly/types';
import { CampaignStatus, CampaignStatusLabels } from '@/lib/instantly/types';

const STATUS_FILTERS = [
  { label: 'Все', value: undefined },
  { label: 'Активные', value: CampaignStatus.Active },
  { label: 'На паузе', value: CampaignStatus.Paused },
  { label: 'Черновики', value: CampaignStatus.Draft },
  { label: 'Завершённые', value: CampaignStatus.Completed },
] as const;

function statusBadgeClass(status: number): string {
  switch (status) {
    case CampaignStatus.Active: return 'bg-emerald-50 text-emerald-700';
    case CampaignStatus.Paused: return 'bg-amber-50 text-amber-700';
    case CampaignStatus.Completed: return 'bg-blue-50 text-blue-700';
    case CampaignStatus.Draft: return 'bg-zinc-100 text-zinc-600';
    default: return 'bg-red-50 text-red-700';
  }
}

function sortNewest(items: Campaign[]): Campaign[] {
  return [...items].sort((a, b) => {
    const ta = a.timestamp_created ?? '';
    const tb = b.timestamp_created ?? '';
    return tb > ta ? 1 : tb < ta ? -1 : 0;
  });
}

const PAGE_SIZE = 20;

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRest, setLoadingRest] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<number | undefined>(undefined);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const abortRef = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError('');
      try {
        const first = await instantlyFetch<PaginatedResponse<Campaign>>('/campaigns?limit=100');
        if (cancelled) return;
        const items = first.items ?? [];
        setCampaigns(sortNewest(items));
        setLoading(false);

        if (!first.next_starting_after) return;

        setLoadingRest(true);
        let after: string | undefined = first.next_starting_after;
        const all = [...items];

        while (after && !cancelled) {
          const page: PaginatedResponse<Campaign> = await instantlyFetch(
            `/campaigns?limit=100&starting_after=${after}`,
          );
          if (cancelled) return;
          const pageItems = page.items ?? [];
          if (pageItems.length === 0) break;
          all.push(...pageItems);
          setCampaigns(sortNewest(all));
          after = page.next_starting_after ?? undefined;
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadingRest(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const filtered = campaigns.filter((c) => {
    if (statusFilter !== undefined && c.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
    }
    return true;
  });

  // При смене фильтра/поиска возвращаемся на первую страницу — чтобы после
  // сужения списка не остаться на пустой странице 10 без единой кампании.
  useEffect(() => { setPage(1); }, [search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const handleAction = useCallback(async (id: string, action: 'activate' | 'pause') => {
    setActionLoading(id);
    try {
      await instantlyFetch(`/campaigns/${id}/${action}`, { method: 'POST' });
      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, status: action === 'activate' ? CampaignStatus.Active : CampaignStatus.Paused }
            : c,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(null);
    }
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <Link href={'/instantly' as Route} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 mb-3 transition-colors">
          <ChevronLeft className="h-3 w-3" /> Instantly
        </Link>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-zinc-900">Кампании</h1>
          <Link
            href={'/instantly/campaigns/new' as Route}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors"
          >
            <Send className="h-4 w-4" />
            Создать
          </Link>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Поиск по названию..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-400"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={String(f.value)}
              onClick={() => setStatusFilter(f.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === f.value
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              {f.label}
            </button>
          ))}
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
          <Send className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-500">
            {search || statusFilter !== undefined ? 'Ничего не найдено' : 'Нет кампаний'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <div className="divide-y divide-zinc-100">
            {visible.map((c) => (
              <div key={c.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50 transition-colors">
                <Link
                  href={`/instantly/campaigns/${c.id}` as Route}
                  className="flex-1 min-w-0"
                >
                  <p className="truncate text-sm font-medium text-zinc-800">{c.name}</p>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-zinc-400">
                    {c.timestamp_created && (
                      <span>{new Date(c.timestamp_created).toLocaleDateString('ru-RU')}</span>
                    )}
                    {c.email_list && c.email_list.length > 0 && (
                      <span>{c.email_list.length} аккаунтов</span>
                    )}
                    {c.daily_limit != null && (
                      <span>лимит: {c.daily_limit}/день</span>
                    )}
                  </div>
                </Link>
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(c.status)}`}>
                  {CampaignStatusLabels[c.status] ?? `Status ${c.status}`}
                </span>
                <div className="flex items-center gap-1">
                  {c.status === CampaignStatus.Draft || c.status === CampaignStatus.Paused ? (
                    <button
                      onClick={() => handleAction(c.id, 'activate')}
                      disabled={actionLoading === c.id}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 transition-colors disabled:opacity-50"
                      title="Активировать"
                    >
                      {actionLoading === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    </button>
                  ) : c.status === CampaignStatus.Active ? (
                    <button
                      onClick={() => handleAction(c.id, 'pause')}
                      disabled={actionLoading === c.id}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-amber-50 hover:text-amber-600 transition-colors disabled:opacity-50"
                      title="Поставить на паузу"
                    >
                      {actionLoading === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                    </button>
                  ) : null}
                  <a
                    href={`https://app.instantly.ai/app/campaign/${c.id}/analytics`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"
                    title="Открыть в Instantly"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              </div>
            ))}
          </div>
          <CampaignsPaginationBar
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={filtered.length}
            allItems={campaigns.length}
            pageSize={PAGE_SIZE}
            loadingRest={loadingRest}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Пагинация в стиле accounts/page.tsx: номер текущей страницы + первая/последняя
 * + ±1 соседей, между «…». На узком списке (≤7 страниц) показываем все номера.
 * Также подсвечиваем «подгружаем остальные…» пока идёт фоновая догрузка кампаний.
 */
function CampaignsPaginationBar({
  currentPage,
  totalPages,
  totalItems,
  allItems,
  pageSize,
  loadingRest,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  allItems: number;
  pageSize: number;
  loadingRest: boolean;
  onPageChange: (page: number) => void;
}) {
  const from = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, totalItems);
  const canPrev = currentPage > 1;
  const canNext = currentPage < totalPages;

  const pageNumbers: (number | 'gap')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i);
  } else {
    const push = (n: number) => {
      if (pageNumbers[pageNumbers.length - 1] !== n) pageNumbers.push(n);
    };
    push(1);
    if (currentPage > 3) pageNumbers.push('gap');
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) push(i);
    if (currentPage < totalPages - 2) pageNumbers.push('gap');
    push(totalPages);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
      <span className="inline-flex items-center gap-1.5">
        {totalItems === allItems
          ? <>{from}–{to} из {totalItems} кампаний</>
          : <>{from}–{to} из {totalItems} (всего {allItems})</>}
        {loadingRest && (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>подгружаем остальные…</span>
          </>
        )}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={!canPrev}
            className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-600 transition-colors"
          >
            ‹
          </button>
          {pageNumbers.map((n, idx) =>
            n === 'gap' ? (
              <span key={`gap-${idx}`} className="px-1 text-zinc-400">…</span>
            ) : (
              <button
                key={n}
                type="button"
                onClick={() => onPageChange(n)}
                className={`min-w-[28px] rounded-md px-2 py-1 font-medium transition-colors ${
                  n === currentPage
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={!canNext}
            className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-600 transition-colors"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
