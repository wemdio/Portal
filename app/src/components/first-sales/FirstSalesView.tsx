'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { FirstSalesSeries } from '@/lib/firstSales/metrics';
import FiltersBar, { getDefaultFilters, type FiltersState } from '@/components/first-sales/FiltersBar';
import KpiRow from '@/components/first-sales/KpiRow';
import TimeSeriesChart from '@/components/first-sales/TimeSeriesChart';
import SourceTable from '@/components/first-sales/SourceTable';

type SummaryResponse = FirstSalesSeries & {
  previousTotals: FirstSalesSeries['totals'];
  syncedAt: string | null;
};

export default function FirstSalesView() {
  const [filters, setFilters] = useState<FiltersState>(() => getDefaultFilters());
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Фетч в эффекте по ключу = весь объект фильтров. Клик по каналу или пресету
  // периода запускает новый запрос при каждом изменении; быстрые повторные
  // клики иначе дали бы гонку — ответ на устаревший запрос может прийти позже
  // ответа на свежий. Защита в два слоя: AbortController реально обрывает
  // предыдущий fetch (не тратим впустую бэкенд, который тянет и текущее, и
  // прошлое окно), а флаг `active` подстраховывает на случай, если промис уже
  // успел зарезолвиться до того, как abort долетел — тот же идиом, что в
  // analytics/mailbox-load/page.tsx.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, groupBy: filters.groupBy });
        for (const channel of filters.channels) qs.append('channel', channel);

        const res = await authFetch(`/api/analytics/first-sales/summary?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as SummaryResponse;
        if (!active) return;
        setError(null);
        setData(json);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return; // отменено новым фильтром, не ошибка
        logError('first-sales.summary.fetch_failed', e);
        setError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [filters]);

  const isEmpty = !!data && data.totals.leads === 0 && data.bySource.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Первичка</h1>
        <p className="text-xs text-zinc-500">Воронка первичных продаж: лиды, квалификация, встречи и договоры.</p>
      </div>

      <FiltersBar value={filters} onChange={setFilters} />

      {loading && <div className="py-10 text-center text-sm text-zinc-400">Загрузка…</div>}
      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Ошибка загрузки: {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          <KpiRow totals={data.totals} previousTotals={data.previousTotals} syncedAt={data.syncedAt} />

          {isEmpty ? (
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-8 text-center text-sm text-zinc-400">
              Данных за выбранный период нет.
            </div>
          ) : (
            <>
              <TimeSeriesChart series={data.series} groupBy={filters.groupBy} />
              <SourceTable rows={data.bySource} />
            </>
          )}
        </>
      )}
    </div>
  );
}
