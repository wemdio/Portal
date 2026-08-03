'use client';

import type { RenewalsTotals } from '@/lib/renewals/metrics';

const fmt = (n: number) => n.toLocaleString('ru-RU');
const fmtMoney = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
const fmtDays = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

function Tile({
  label,
  value,
  sub,
  amber,
}: {
  label: string;
  value: string;
  sub?: string;
  amber?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        amber ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white'
      }`}
    >
      <p className={`text-[10px] font-medium uppercase tracking-wider ${amber ? 'text-amber-600' : 'text-zinc-400'}`}>
        {label}
      </p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${amber ? 'text-amber-800' : 'text-zinc-900'}`}>
        {value}
      </p>
      {sub && <p className={`mt-0.5 text-[11px] ${amber ? 'text-amber-700' : 'text-zinc-400'}`}>{sub}</p>}
    </div>
  );
}

export default function KpiRow({ totals }: { totals: RenewalsTotals }) {
  const cycleSubParts: string[] = [];
  if (totals.cycleAvgDays !== null) cycleSubParts.push(`среднее: ${fmtDays(totals.cycleAvgDays)} дн.`);
  if (totals.cycleSampleSize < totals.cycleCandidates) {
    cycleSubParts.push(`цикл посчитан для ${fmt(totals.cycleSampleSize)} из ${fmt(totals.cycleCandidates)}`);
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label="Продлений" value={fmt(totals.count)} sub="за выбранный период" />
      <Tile label="Оборот" value={fmtMoney(totals.revenue)} sub="за выбранный период" />
      {/* Медиана крупно, среднее подписью — распределение чеков длиннохвостое
          (в данных рядом 45 000 и 600 000), среднее без медианы вводит в
          заблуждение сильнее, чем помогает. */}
      <Tile
        label="Средний чек"
        value={totals.medianCheck !== null ? fmtMoney(totals.medianCheck) : '—'}
        sub={totals.avgCheck !== null ? `среднее: ${fmtMoney(totals.avgCheck)}` : undefined}
      />
      <Tile
        label="Средний цикл"
        value={totals.cycleMedianDays !== null ? `${fmtDays(totals.cycleMedianDays)} дн.` : '—'}
        sub={cycleSubParts.length > 0 ? cycleSubParts.join(' · ') : undefined}
      />
      {/* «Не разобрано» — кандидаты периода (повторный приход с ИНН) без
          решения человека или автомата. Пока цифра большая, «Продлениям» и
          «Обороту» слева верить нельзя — часть неразобранных станет
          продлениями только после разбора. Амбер и подпись держат это на
          виду, а не в примечании под таблицей. */}
      <Tile
        label="Не разобрано"
        value={fmt(totals.unresolved)}
        sub="ждут решения — «Продления» пока занижены"
        amber={totals.unresolved > 0}
      />
    </div>
  );
}
