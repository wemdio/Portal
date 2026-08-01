'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { RenewalsResult } from '@/lib/renewals/metrics';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import FiltersBar, { getDefaultFilters, type FiltersState } from '@/components/renewals/FiltersBar';
import KpiRow from '@/components/renewals/KpiRow';
import RenewalsTable from '@/components/renewals/RenewalsTable';
import RenewalsChart from '@/components/renewals/RenewalsChart';

type SummaryResponse = RenewalsResult & { tableRows: RenewalTableRow[] };

export default function RenewalsView() {
  const [filters, setFilters] = useState<FiltersState>(() => getDefaultFilters());
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Тот же приём, что в FirstSalesView: AbortController реально обрывает
  // устаревший запрос при быстрой смене фильтров, флаг `active` подстраховывает
  // на случай, если промис успел зарезолвиться до того, как abort долетел.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to, groupBy: filters.groupBy });
        if (filters.kpiMin !== '') qs.set('kpiMin', filters.kpiMin);
        if (filters.kpiMax !== '') qs.set('kpiMax', filters.kpiMax);

        const res = await authFetch(`/api/analytics/renewals/summary?${qs.toString()}`, {
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
        logError('renewals.summary.fetch_failed', e);
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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Продления</h1>
        <p className="text-xs text-zinc-500">
          Проекты с типом «Продление»: сколько продлений, на какую сумму, средний чек и цикл.
        </p>
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
          <KpiRow totals={data.totals} />

          <RenewalsTable rows={data.tableRows} withoutDate={data.totals.withoutDate} />

          {/* Заметка про отсутствующие фильтры — сразу под таблицей, чтобы не
              заставлять первым делом спрашивать «а где канал и сфера»:
              канал заполнен у 3 продлений из 32, поля сферы деятельности в
              схеме нет вообще. Строить фильтр на трёх заполненных значениях
              из тридцати двух значит показать инструмент, который врёт при
              каждом использовании — поэтому фильтров нет, и это осознанный
              отказ, а не забытая часть. */}
          <p className="text-[11px] text-zinc-400">
            Фильтров по каналу маркетинга и сфере деятельности здесь пока нет: канал заполнен только у 3 продлений из
            32, а поле сферы деятельности в базе не заведено. Добавим, когда появятся данные.
          </p>

          <RenewalsChart series={data.series} groupBy={filters.groupBy} />
        </>
      )}
    </div>
  );
}
