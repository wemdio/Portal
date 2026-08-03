'use client';

import { useMemo, useState } from 'react';

import StackedTimeChart, { type StackedPoint } from '@/components/expenses/StackedTimeChart';
import {
  EXPENSE_CATEGORY_VALUES,
  EXPENSE_SOURCE_VALUES,
  categoryColor,
  categoryLabel,
  sourceColor,
  sourceLabel,
} from '@/lib/expenses/labels';
import type { GroupBy } from '@/lib/expenses/period';
import { UNCLASSIFIED_CATEGORY_KEY, type SeriesPoint } from '@/lib/expenses/types';

type StackBy = 'category' | 'source';

/**
 * График расходов по времени.
 *
 * Собственного у него ровно одно — переключатель разреза: у расхода есть и
 * категории, и источники. Рисование, тултип и пометка неполных столбцов общие с
 * доходом и живут в `StackedTimeChart`.
 */
export default function TimeChart({ series, groupBy }: { series: SeriesPoint[]; groupBy: GroupBy }) {
  const [stackBy, setStackBy] = useState<StackBy>('category');

  const points = useMemo<StackedPoint[]>(
    () =>
      series.map((point) => ({
        bucket: point.bucket,
        total: point.total,
        partial: point.partial,
        parts: stackBy === 'category' ? point.byCategory : point.bySource,
      })),
    [series, stackBy],
  );

  const canonicalOrder = useMemo(
    () =>
      stackBy === 'category'
        ? [...EXPENSE_CATEGORY_VALUES, UNCLASSIFIED_CATEGORY_KEY]
        : [...EXPENSE_SOURCE_VALUES],
    [stackBy],
  );

  return (
    <StackedTimeChart
      title="Расходы по времени"
      points={points}
      groupBy={groupBy}
      canonicalOrder={canonicalOrder}
      labelOf={(key) => (stackBy === 'category' ? categoryLabel(key) : sourceLabel(key))}
      colorOf={(key) => (stackBy === 'category' ? categoryColor(key) : sourceColor(key))}
      emptyText="Трат за выбранный период нет."
      zeroBucketText="Трат нет"
      partialTooltip="Неполный столбец: в выбранный период попала только часть этого отрезка. Он ниже соседних из-за границ периода, а не из-за падения расходов."
      partialFootnote="в выбранный период попала только часть этого отрезка. Они ниже соседних из-за границ периода, а не из-за падения расходов."
      toolbar={
        <div className="flex items-center gap-1">
          {(['category', 'source'] as StackBy[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setStackBy(mode)}
              aria-pressed={stackBy === mode}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                stackBy === mode ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {mode === 'category' ? 'По категориям' : 'По источникам'}
            </button>
          ))}
        </div>
      }
    />
  );
}
