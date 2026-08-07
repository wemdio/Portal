'use client';

import { useMemo, useState } from 'react';

import IncomeOperations from '@/components/expenses/IncomeOperations';
import { formatRub, pluralOps } from '@/lib/expenses/client';
import { excludeReasonLabel } from '@/lib/expenses/labels';
import type { IncomesSummary } from '@/lib/expenses/types';

/**
 * Не-выручка в разрезе причин.
 *
 * Разбивка, а не одно число «прочее», — сознательно: причина здесь ценнее
 * суммы. Она объясняет, почему деньги пришли, но доходом не считаются, и
 * позволяет заметить, что классификатор синка отнёс к возвратам платёж, который
 * на самом деле был клиентским.
 *
 * Панель показывается всегда, когда не-выручка в периоде есть, и не прячется
 * за клик: спрятанная причина ничем не лучше отсутствующей.
 */
export default function NonRevenueBreakdown({
  summary,
  query,
}: {
  summary: IncomesSummary;
  /** from/to/groupBy/source — то же окно, что у сводки. */
  query: string;
}) {
  const [showOperations, setShowOperations] = useState(false);

  const reasons = useMemo(
    () =>
      Object.entries(summary.nonRevenueByReason)
        .map(([key, total]) => ({ key, total }))
        .sort((a, b) => b.total - a.total),
    [summary.nonRevenueByReason],
  );

  if (summary.nonRevenueCount === 0) return null;

  const max = reasons[0]?.total ?? 0;

  return (
    <div className="glass-tile p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">Почему приход не стал доходом</h3>
        <span className="text-[11px] text-zinc-400">
          {pluralOps(summary.nonRevenueCount)} на {formatRub(summary.nonRevenueTotal)} ₽ — в итог не входят
        </span>
      </div>

      <div className="space-y-1.5">
        {reasons.map((reason) => (
          <div key={reason.key} className="flex items-center gap-2">
            <span
              className="w-32 shrink-0 truncate text-xs text-zinc-700 sm:w-56"
              title={excludeReasonLabel(reason.key)}
            >
              {excludeReasonLabel(reason.key)}
            </span>
            <span className="h-3.5 flex-1 rounded bg-zinc-100">
              <span
                className="block h-3.5 rounded bg-zinc-400"
                style={{ width: max > 0 ? `${(reason.total / max) * 100}%` : '0%' }}
              />
            </span>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-zinc-900 sm:w-28">
              {formatRub(reason.total)} ₽
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShowOperations((prev) => !prev)}
        aria-expanded={showOperations}
        className="mt-3 rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
      >
        {showOperations ? 'Скрыть операции' : 'Показать операции'}
      </button>

      {showOperations ? (
        <div className="mt-2 rounded-lg border-l-2 border-zinc-200 bg-zinc-50/60 px-3 py-2">
          <IncomeOperations query={`${query}&revenue=false`} emptyText="Операций нет." />
        </div>
      ) : null}
    </div>
  );
}
