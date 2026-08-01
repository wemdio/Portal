'use client';

import { useEffect, useMemo, useState } from 'react';

import ClassifyQueue from '@/components/expenses/ClassifyQueue';
import Filters, { getDefaultFilters, type FiltersValue } from '@/components/expenses/Filters';
import KpiRow from '@/components/expenses/KpiRow';
import ManualExpenseForm from '@/components/expenses/ManualExpenseForm';
import type { PeriodValue } from '@/components/expenses/PeriodBar';
import TimeChart from '@/components/expenses/TimeChart';
import VendorBreakdown from '@/components/expenses/VendorBreakdown';
import { expensesDownload, expensesFetch } from '@/lib/expenses/client';
import type { ExpensesSummary, VendorBreakdownItem, VendorOption } from '@/lib/expenses/types';

/**
 * Расходная сторона раздела «Деньги».
 *
 * Период сюда приходит сверху, из `MoneyView`: он общий у обеих сторон и не
 * должен теряться при переключении вкладок. Свои у расхода только фильтры,
 * которых у дохода не бывает, — источник и категория разметки.
 */
export default function ExpensesView({
  period,
  onPeriodChange,
}: {
  period: PeriodValue;
  onPeriodChange: (next: PeriodValue) => void;
}) {
  const [filters, setFilters] = useState<FiltersValue>(() => getDefaultFilters());
  const [summary, setSummary] = useState<ExpensesSummary | null>(null);
  const [vendors, setVendors] = useState<VendorBreakdownItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Справочник для выбора вендора — все активные, независимо от периода.
  // Тянется здесь один раз и раздаётся вниз пропсами: и очередь разметки, и
  // форма ручной траты выбирают из одного и того же списка, и незачем ходить
  // за ним дважды.
  const [directory, setDirectory] = useState<VendorOption[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // Вендоры, заведённые в этой сессии. Справочник перечитывается только при
  // открытии страницы, а выбрать нового нужно сразу же.
  const [createdVendors, setCreatedVendors] = useState<VendorOption[]>([]);
  // Перечитать сводку после разметки или правки ручной траты, не трогая фильтры.
  const [reloadKey, setReloadKey] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams({ from: period.from, to: period.to, groupBy: period.groupBy });
    if (filters.source) params.set('source', filters.source);
    if (filters.category) params.set('category', filters.category);
    return params.toString();
  }, [period, filters]);

  // Очередь разметки живёт без фильтра по категории: у неразмеченной операции
  // категории нет по определению, и любой такой фильтр опустошил бы очередь.
  const queueQuery = useMemo(() => {
    const params = new URLSearchParams({ from: period.from, to: period.to });
    if (filters.source) params.set('source', filters.source);
    return params.toString();
  }, [period, filters]);

  const range = useMemo(() => ({ from: period.from, to: period.to }), [period.from, period.to]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      setLoading(true);
      try {
        const [summaryRes, vendorsRes] = await Promise.all([
          expensesFetch<ExpensesSummary>(`/summary?${query}`, { signal: controller.signal }),
          expensesFetch<{ items: VendorBreakdownItem[] }>(`/vendors?${query}`, {
            signal: controller.signal,
          }),
        ]);
        if (!active) return;
        setSummary(summaryRes);
        setVendors(vendorsRes.items);
        setError(null);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить расходы');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [query, reloadKey]);

  // Справочник от периода не зависит, поэтому и от `query` эффект не зависит:
  // перечитывать его на каждую смену дат значило бы гонять один и тот же
  // список по кругу.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const res = await expensesFetch<{ items: VendorOption[] }>('/vendors/directory', {
          signal: controller.signal,
        });
        if (!active) return;
        setDirectory(res.items);
        setDirectoryError(null);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Отдельно от ошибки сводки: без справочника таблица расходов
        // по-прежнему читается, не работает только выбор вендора.
        setDirectoryError(e instanceof Error ? e.message : 'Не удалось загрузить справочник вендоров');
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  // Категория едет вместе с вендором: по ней выпадающий список группируется, и
  // без неё все два десятка вендоров сваливаются в кучу «без категории».
  const vendorOptions = useMemo(() => {
    const byId = new Map<string, VendorOption>();
    for (const item of directory) byId.set(item.id, item);
    for (const item of createdVendors) byId.set(item.id, item);
    // Ручка отдаёт список уже отсортированным, но заведённые в этой сессии
    // вендоры приезжают в конец — сортируем повторно, уже по-русски.
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [directory, createdVendors]);

  // Полоса ошибки в разметке одна: сводка ломается чаще, поэтому её текст и
  // показывается первым — про справочник человек прочтёт, когда сводка
  // починится.
  const shownError = error ?? directoryError;

  const addVendor = (vendor: VendorOption) =>
    setCreatedVendors((prev) => (prev.some((item) => item.id === vendor.id) ? prev : [...prev, vendor]));

  const reload = () => setReloadKey((prev) => prev + 1);

  async function exportXlsx() {
    setExporting(true);
    setError(null);
    try {
      await expensesDownload(`/export?${query}`, `expenses-${period.from}_${period.to}.xlsx`);
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
          <h1 className="text-lg font-semibold text-zinc-900">Расходы</h1>
          <p className="text-xs text-zinc-500">
            Траты по сервисам: банковские выписки, карты и ручной ввод. Суммы — в рублях по курсу ЦБ на дату
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

      <Filters period={period} onPeriodChange={onPeriodChange} value={filters} onChange={setFilters} />

      {shownError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {shownError}
        </div>
      ) : null}

      {loading && !summary ? <div className="py-10 text-center text-sm text-zinc-400">Загружаю…</div> : null}

      {summary ? (
        <>
          <KpiRow
            summary={summary}
            onOpenQueue={() => setShowQueue((prev) => !prev)}
            queueOpen={showQueue}
            hasCategoryFilter={filters.category !== ''}
          />

          {showQueue ? (
            <ClassifyQueue
              queueQuery={queueQuery}
              vendors={vendorOptions}
              onVendorCreated={addVendor}
              onDone={reload}
            />
          ) : null}

          <TimeChart series={summary.series} groupBy={period.groupBy} />

          <VendorBreakdown items={vendors} query={query} queueQuery={queueQuery} />

          <ManualExpenseForm
            range={range}
            vendors={vendorOptions}
            onVendorCreated={addVendor}
            onChanged={reload}
          />
        </>
      ) : null}
    </div>
  );
}
