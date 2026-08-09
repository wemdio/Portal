'use client';

import { useEffect, useMemo, useState } from 'react';

import PeriodBar, { type PeriodValue } from '@/components/expenses/PeriodBar';
import ProfitChart, { type ProfitPoint } from '@/components/expenses/ProfitChart';
import { Tile } from '@/components/expenses/KpiTile';
import { expensesFetch, formatRub, formatShare } from '@/lib/expenses/client';
import type { ExpensesSummary, IncomesSummary } from '@/lib/expenses/types';
import { logError } from '@/lib/loggerClient';

/**
 * «Итог» — единственное место, где расход и доход встречаются.
 *
 * Раньше их было не сложить: две взаимоисключающие вкладки, и чтобы узнать
 * прибыль, приходилось открывать обе и вычитать в уме. Обе сводки уже считаются
 * по одному и тому же периоду и раскладываются по одинаковым бакетам, так что
 * работы с базой здесь нет — только два параллельных запроса и вычитание.
 *
 * Что считается прибылью, стоит проговорить, потому что это НЕ бухгалтерская
 * прибыль: доход — клиентские платежи без возвратов и переводов себе, расход —
 * траты без перемещений между своими счетами. Обе стороны берут только те
 * строки, для которых нашёлся курс ЦБ.
 */

interface Totals {
  income: number;
  expense: number;
  profit: number;
  /** Доля прибыли в доходе. null — дохода не было, делить не на что. */
  margin: number | null;
}

function mergeSeries(incomes: IncomesSummary, expenses: ExpensesSummary): ProfitPoint[] {
  const byBucket = new Map<string, ProfitPoint>();

  for (const point of incomes.series) {
    byBucket.set(point.bucket, {
      bucket: point.bucket,
      income: point.total,
      expense: 0,
      partial: point.partial,
    });
  }
  for (const point of expenses.series) {
    const existing = byBucket.get(point.bucket);
    if (existing) {
      existing.expense = point.total;
      // Неполнота — свойство самого бакета, а не стороны: если хоть одна
      // сторона считает его обрезанным, он обрезан.
      existing.partial = existing.partial || point.partial;
    } else {
      byBucket.set(point.bucket, {
        bucket: point.bucket,
        income: 0,
        expense: point.total,
        partial: point.partial,
      });
    }
  }

  // Ключ бакета — YYYY-MM-DD, поэтому обычная сортировка строк даёт
  // хронологический порядок.
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export default function ProfitView({
  period,
  onPeriodChange,
}: {
  period: PeriodValue;
  onPeriodChange: (next: PeriodValue) => void;
}) {
  const [incomes, setIncomes] = useState<IncomesSummary | null>(null);
  const [expenses, setExpenses] = useState<ExpensesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(
    () => new URLSearchParams({ from: period.from, to: period.to, groupBy: period.groupBy }).toString(),
    [period.from, period.to, period.groupBy],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const [incomeRes, expenseRes] = await Promise.all([
          expensesFetch<IncomesSummary>(`/incomes/summary?${query}`, { signal: controller.signal }),
          expensesFetch<ExpensesSummary>(`/summary?${query}`, { signal: controller.signal }),
        ]);
        if (!active) return;
        setError(null);
        setIncomes(incomeRes);
        setExpenses(expenseRes);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        logError('money.profit.fetch_failed', e);
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
  }, [query]);

  const totals: Totals | null = useMemo(() => {
    if (!incomes || !expenses) return null;
    const profit = incomes.total - expenses.total;
    return {
      income: incomes.total,
      expense: expenses.total,
      profit,
      margin: incomes.total > 0 ? profit / incomes.total : null,
    };
  }, [incomes, expenses]);

  const points = useMemo(
    () => (incomes && expenses ? mergeSeries(incomes, expenses) : []),
    [incomes, expenses],
  );

  const unconverted = (incomes?.unconvertedCount ?? 0) + (expenses?.unconvertedCount ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Итог</h1>
          <p className="text-xs text-zinc-500">
            Доход минус расход за период. Без перемещений между своими счетами и без возвратов.
          </p>
        </div>
      </div>

      {/* На вкладках «Расходы» и «Доходы» период живёт внутри стеклянной
          панели фильтров. Здесь фильтров нет, но панель нужна та же — иначе
          при переключении вкладок верх экрана прыгает. */}
      <div className="glass-panel px-3 py-2.5">
        <PeriodBar value={period} onChange={onPeriodChange} />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Ошибка загрузки: {error}
        </div>
      ) : null}

      {loading && !totals ? <div className="py-10 text-center text-sm text-zinc-400">Загружаю…</div> : null}

      {totals ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Доход" value={`${formatRub(totals.income)} ₽`} sub="Клиентские платежи" />
            <Tile label="Расход" value={`${formatRub(totals.expense)} ₽`} sub="Без перемещений" />
            <Tile
              label={totals.profit < 0 ? 'Убыток' : 'Прибыль'}
              value={`${formatRub(totals.profit)} ₽`}
              // Минус подсвечиваем, а не прячем: это ровно то число, ради
              // которого экран и открывают.
              tone={totals.profit < 0 ? 'warning' : 'normal'}
              sub="Доход минус расход"
            />
            <Tile
              label="Маржа"
              value={totals.margin === null ? '—' : formatShare(totals.margin)}
              sub={totals.margin === null ? 'Дохода за период не было' : 'Доля прибыли в доходе'}
            />
          </div>

          {unconverted > 0 ? (
            <p className="text-[11px] text-amber-700">
              {unconverted} операций без курса ЦБ не вошли в расчёт — итог занижен.
            </p>
          ) : null}

          <ProfitChart points={points} groupBy={period.groupBy} />
        </>
      ) : null}
    </div>
  );
}
