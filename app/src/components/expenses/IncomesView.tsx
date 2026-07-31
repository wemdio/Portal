'use client';

import { useEffect, useMemo, useState } from 'react';

import IncomeFilters, {
  getDefaultIncomeFilters,
  type IncomeFiltersValue,
} from '@/components/expenses/IncomeFilters';
import IncomeKpiRow from '@/components/expenses/IncomeKpiRow';
import IncomeTimeChart from '@/components/expenses/IncomeTimeChart';
import NonRevenueBreakdown from '@/components/expenses/NonRevenueBreakdown';
import PayerBreakdown from '@/components/expenses/PayerBreakdown';
import type { PeriodValue } from '@/components/expenses/PeriodBar';
import { expensesDownload, expensesFetch } from '@/lib/expenses/client';
import type { IncomesSummary, PayerBreakdownItem } from '@/lib/expenses/types';

/**
 * Доходная сторона раздела «Деньги».
 *
 * Период приходит сверху, из `MoneyView`, и потому переживает переключение
 * вкладок. Всё остальное — своё: у прихода нет ни разметки, ни ручного ввода,
 * зато есть не-выручка с причинами, которой нет у расхода.
 */
export default function IncomesView({
  period,
  onPeriodChange,
}: {
  period: PeriodValue;
  onPeriodChange: (next: PeriodValue) => void;
}) {
  const [filters, setFilters] = useState<IncomeFiltersValue>(() => getDefaultIncomeFilters());
  const [summary, setSummary] = useState<IncomesSummary | null>(null);
  const [payers, setPayers] = useState<PayerBreakdownItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ from: period.from, to: period.to, groupBy: period.groupBy });
    if (filters.source) params.set('source', filters.source);
    return params.toString();
  }, [period, filters]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      setLoading(true);
      try {
        const [summaryRes, payersRes] = await Promise.all([
          expensesFetch<IncomesSummary>(`/incomes/summary?${query}`, { signal: controller.signal }),
          expensesFetch<{ items: PayerBreakdownItem[] }>(`/incomes/payers?${query}`, {
            signal: controller.signal,
          }),
        ]);
        if (!active) return;
        setSummary(summaryRes);
        setPayers(payersRes.items);
        setError(null);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить доходы');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [query]);

  async function exportXlsx() {
    setExporting(true);
    setError(null);
    try {
      await expensesDownload(`/incomes/export?${query}`, `incomes-${period.from}_${period.to}.xlsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выгрузить файл');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Доходы</h1>
          <p className="text-xs text-zinc-500">
            Приход по счетам в банках, сгруппированный по плательщикам. Суммы — в рублях по курсу ЦБ на дату
            операции.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void exportXlsx()}
          disabled={exporting}
          className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
        >
          {exporting ? 'Готовлю файл…' : 'Выгрузить в xlsx'}
        </button>
      </div>

      <IncomeFilters
        period={period}
        onPeriodChange={onPeriodChange}
        value={filters}
        onChange={setFilters}
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      ) : null}

      {loading && !summary ? <div className="py-10 text-center text-sm text-zinc-400">Загружаю…</div> : null}

      {summary ? (
        <>
          <IncomeKpiRow summary={summary} />

          <NonRevenueBreakdown summary={summary} query={query} />

          <IncomeTimeChart series={summary.series} groupBy={period.groupBy} />

          <PayerBreakdown items={payers} query={query} />
        </>
      ) : null}
    </div>
  );
}
