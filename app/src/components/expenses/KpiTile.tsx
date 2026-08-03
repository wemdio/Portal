'use client';

import type { ReactNode } from 'react';

import { formatCurrencyMap, formatDelta } from '@/lib/expenses/client';

/**
 * Кирпичи KPI-строки, общие у расхода и дохода.
 *
 * Общая здесь только форма плитки — набор плиток у сторон разный и сводить его
 * в один компонент с флагом нельзя: у расхода есть очередь разметки и
 * перемещения, у дохода — не-выручка с причинами. Поэтому переиспользуется
 * оформление, а не состав.
 */

export function Tile({
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
 * Плитка «к прошлому периоду».
 *
 * Цвет роста задаёт вызывающий, и это не украшение: рост расходов — тревожный
 * знак, рост дохода — наоборот. Один и тот же красный на обеих сторонах читался
 * бы как «стало хуже» там, где стало лучше.
 */
export function DeltaTile({
  delta,
  growthMeans,
  emptyHint,
}: {
  delta: number | null;
  growthMeans: 'good' | 'bad';
  /** Подпись, когда сравнивать не с чем: у сторон разные слова про «в прошлом периоде пусто». */
  emptyHint: string;
}) {
  const good = 'text-emerald-600';
  const bad = 'text-rose-600';
  const color =
    delta === null || delta === 0
      ? 'text-zinc-400'
      : delta > 0
        ? growthMeans === 'good'
          ? good
          : bad
        : growthMeans === 'good'
          ? bad
          : good;

  return (
    <div className="h-full rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">К прошлому периоду</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{formatDelta(delta)}</p>
      <p className="mt-0.5 text-[11px] text-zinc-400">
        {delta === null ? emptyHint : 'Период той же длины до текущего'}
      </p>
    </div>
  );
}

/** Операции без курса ЦБ: в рублёвую сумму они не вошли, и молчать об этом нельзя. */
export function UnconvertedNote({
  count,
  byCurrency,
}: {
  count: number;
  byCurrency: Record<string, number>;
}) {
  if (count === 0) return null;
  return (
    <span
      className="ml-1.5 whitespace-nowrap rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800"
      title="Для этих операций не нашёлся курс ЦБ — в рублёвую сумму слева они не входят."
    >
      +{count} без курса: {formatCurrencyMap(byCurrency)}
    </span>
  );
}
