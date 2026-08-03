'use client';

import { DeltaTile, Tile } from '@/components/expenses/KpiTile';
import { formatCurrencyMap, formatRub, pluralOps } from '@/lib/expenses/client';
import type { IncomesSummary } from '@/lib/expenses/types';

/**
 * KPI-строка доходов.
 *
 * Состав не зеркалит расходный, потому что не зеркалят и сущности: очереди
 * разметки у прихода нет вовсе, а роль перемещений играет не-выручка. Она
 * стоит рядом с итогом ровно по той же причине, что перемещения в расходах:
 * без неё сумма не сойдётся с банковской выпиской. Само число здесь только
 * итоговое — почему эти деньги пришли, разбирает соседняя разбивка по причинам.
 */
export default function IncomeKpiRow({ summary }: { summary: IncomesSummary }) {
  const unconvertedTone = summary.unconvertedCount > 0 ? 'warning' : 'normal';

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile
        label="Доход за период"
        value={`${formatRub(summary.total)} ₽`}
        sub="Клиентские платежи, без возвратов и переводов себе"
      />
      <Tile label="В среднем в день" value={`${formatRub(summary.avgPerDay)} ₽`} />

      {/* Рост дохода — хорошая новость: цвет здесь обратный расходному. */}
      <DeltaTile
        delta={summary.deltaPrev}
        growthMeans="good"
        emptyHint="В прошлом периоде дохода не было"
      />

      <Tile
        label="Не выручка"
        value={`${formatRub(summary.nonRevenueTotal)} ₽`}
        sub={`${pluralOps(summary.nonRevenueCount)} · в доход не входят`}
        title="Приход, который выручкой не считается: возвраты, банковская механика, переводы себе. В итог не входит, но без него сумма не сойдётся с банковской выпиской."
      />

      <Tile
        label="Без курса ЦБ"
        value={String(summary.unconvertedCount)}
        sub={
          summary.unconvertedCount > 0
            ? `${formatCurrencyMap(summary.unconvertedByCurrency)} — не вошли в итог`
            : 'Весь доход пересчитан в рубли'
        }
        tone={unconvertedTone}
        title="Операции, для которых не нашёлся курс ЦБ. В рублёвую сумму они не входят."
      />
    </div>
  );
}
