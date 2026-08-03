'use client';

import { DeltaTile, Tile } from '@/components/expenses/KpiTile';
import { formatCurrencyMap, formatRub, pluralOps } from '@/lib/expenses/client';
import type { ExpensesSummary } from '@/lib/expenses/types';

/**
 * KPI-строка расходов.
 *
 * Три числа здесь стоят рядом с итогом не для красоты:
 * - «не размечено» — пока оно большое, разбивке по сервисам верить нельзя;
 * - «без курса ЦБ» — эти операции в рублёвый итог не вошли вовсе;
 * - «перемещения» — внутренние движения денег, которых в итоге нет, но без
 *   которых сумма не сойдётся с банковской выпиской.
 */
export default function KpiRow({
  summary,
  onOpenQueue,
  queueOpen,
  hasCategoryFilter,
}: {
  summary: ExpensesSummary;
  onOpenQueue: () => void;
  queueOpen: boolean;
  hasCategoryFilter: boolean;
}) {
  const unclassifiedTone = summary.unclassifiedCount > 0 ? 'warning' : 'normal';
  const unconvertedTone = summary.unconvertedCount > 0 ? 'warning' : 'normal';

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Всего за период"
        value={`${formatRub(summary.total)} ₽`}
        sub="Без перемещений между своими счетами"
      />
      <Tile label="В среднем в день" value={`${formatRub(summary.avgPerDay)} ₽`} />

      {/* Рост расходов красим тревожным, снижение — спокойным. */}
      <DeltaTile
        delta={summary.deltaPrev}
        growthMeans="bad"
        emptyHint="В прошлом периоде трат не было"
      />

      <Tile
        label="Перемещения"
        value={`${formatRub(summary.transfersTotal)} ₽`}
        sub="В итог не входят: пополнение карт, возмещения, переводы между своими счетами"
        title="Внутренние движения денег. В итог не входят, но без них сумма не сойдётся с банковской выпиской."
      />

      {/* Неразмеченное — кнопка: цифра без способа её уменьшить бесполезна. */}
      <button
        type="button"
        onClick={onOpenQueue}
        aria-expanded={queueOpen}
        className="h-full rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-amber-400"
      >
        <Tile
          label="Не размечено"
          value={hasCategoryFilter ? '—' : `${formatRub(summary.unclassifiedTotal)} ₽`}
          sub={
            hasCategoryFilter
              ? 'Скрыто фильтром по категории'
              : `${pluralOps(summary.unclassifiedCount)} · ${queueOpen ? 'скрыть очередь' : 'разметить'}`
          }
          tone={hasCategoryFilter ? 'normal' : unclassifiedTone}
          title="Пока это число большое, разбивке по сервисам верить нельзя."
        />
      </button>

      <Tile
        label="Без курса ЦБ"
        value={String(summary.unconvertedCount)}
        sub={
          summary.unconvertedCount > 0
            ? `${formatCurrencyMap(summary.unconvertedByCurrency)} — не вошли в итог`
            : 'Все траты пересчитаны в рубли'
        }
        tone={unconvertedTone}
        title="Операции, для которых не нашёлся курс ЦБ. В рублёвую сумму они не входят."
      />
    </div>
  );
}
