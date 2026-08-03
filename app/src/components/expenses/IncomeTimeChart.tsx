'use client';

import { useMemo } from 'react';

import StackedTimeChart, { type StackedPoint } from '@/components/expenses/StackedTimeChart';
import { INCOME_SOURCE_VALUES, sourceColor, sourceLabel } from '@/lib/expenses/labels';
import type { GroupBy } from '@/lib/expenses/period';
import type { IncomeSeriesPoint } from '@/lib/expenses/types';

/**
 * График дохода по времени.
 *
 * Разрез ровно один — по банкам: категорий у прихода нет, и точка ряда
 * (`IncomeSeriesPoint`) их даже не содержит. Поэтому переключателя разреза
 * здесь нет — не «пока нет», а нечем переключать.
 */
export default function IncomeTimeChart({
  series,
  groupBy,
}: {
  series: IncomeSeriesPoint[];
  groupBy: GroupBy;
}) {
  const points = useMemo<StackedPoint[]>(
    () =>
      series.map((point) => ({
        bucket: point.bucket,
        total: point.total,
        partial: point.partial,
        parts: point.bySource,
      })),
    [series],
  );

  return (
    <StackedTimeChart
      title="Доход по времени"
      points={points}
      groupBy={groupBy}
      canonicalOrder={INCOME_SOURCE_VALUES}
      labelOf={sourceLabel}
      colorOf={sourceColor}
      emptyText="Поступлений за выбранный период нет."
      zeroBucketText="Поступлений нет"
      partialTooltip="Неполный столбец: в выбранный период попала только часть этого отрезка. Он ниже соседних из-за границ периода, а не из-за падения дохода."
      partialFootnote="в выбранный период попала только часть этого отрезка. Они ниже соседних из-за границ периода, а не из-за падения дохода."
    />
  );
}
