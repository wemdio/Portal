'use client';

import type { ReactNode } from 'react';

import { formatCurrencyMap, formatDelta, formatRub, pluralOps } from '@/lib/expenses/client';
import type { ExpensesSummary } from '@/lib/expenses/types';

function Tile({
  label,
  value,
  sub,
  tone = 'normal',
  title,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: 'normal' | 'warning';
  title?: string;
}) {
  const warning = tone === 'warning';
  return (
    <div
      title={title}
      className={`h-full rounded-xl border px-4 py-3 text-left ${
        warning ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white'
      }`}
    >
      <p
        className={`text-[10px] font-medium uppercase tracking-wider ${
          warning ? 'text-amber-600' : 'text-zinc-400'
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${warning ? 'text-amber-800' : 'text-zinc-900'}`}
      >
        {value}
      </p>
      {sub ? (
        <p className={`mt-0.5 text-[11px] ${warning ? 'text-amber-700' : 'text-zinc-400'}`}>{sub}</p>
      ) : null}
    </div>
  );
}

/**
 * KPI-строка.
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

  // Рост расходов красим тревожным, снижение — спокойным. Для дашборда затрат
  // это читается однозначно, в отличие от нейтрального серого.
  const deltaColor =
    summary.deltaPrev === null
      ? 'text-zinc-400'
      : summary.deltaPrev > 0
        ? 'text-rose-600'
        : summary.deltaPrev < 0
          ? 'text-emerald-600'
          : 'text-zinc-400';

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Всего за период"
        value={`${formatRub(summary.total)} ₽`}
        sub="Без перемещений между своими счетами"
      />
      <Tile label="В среднем в день" value={`${formatRub(summary.avgPerDay)} ₽`} />

      <div className="h-full rounded-xl border border-zinc-200 bg-white px-4 py-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">К прошлому периоду</p>
        <p className={`mt-1 text-xl font-semibold tabular-nums ${deltaColor}`}>
          {formatDelta(summary.deltaPrev)}
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-400">
          {summary.deltaPrev === null ? 'В прошлом периоде трат не было' : 'Период той же длины до текущего'}
        </p>
      </div>

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
