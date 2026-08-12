'use client';

import { useMemo, useState } from 'react';
import type { ManagerBreakdown } from '@/lib/firstSales/metrics';

/**
 * Разбивка первички по ответственным менеджерам.
 *
 * Соседняя таблица отвечает на «откуда приходят», эта — на «кто ведёт». Обе
 * считаются одними и теми же правилами (лиды по дате создания, договоры по дате
 * этапа, встречи по записям разговоров), поэтому итоги сходятся между срезами.
 *
 * Конверсий тут намеренно две, и обе — «из лидов»: в лиде → квал → встреча →
 * договор соседние шаги считаются по разным датам (квал когортно от создания,
 * встречи и договоры — по дате самого события), поэтому «встреч к квалам»
 * складывало бы разные вопросы в одну дробь. «Из лидов» честна: и числитель, и
 * знаменатель — про один и тот же набор сделок в окне.
 */

type SortKey = 'manager' | 'leads' | 'qualified' | 'meetings' | 'contracts';

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';

export default function ManagerTable({ rows }: { rows: ManagerBreakdown[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('leads');
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const sign = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === 'manager') return sign * a.manager.localeCompare(b.manager, 'ru');
      return sign * (a[sortKey] - b[sortKey]) || a.manager.localeCompare(b.manager, 'ru');
    });
  }, [rows, sortKey, asc]);

  const totals = useMemo(
    () => rows.reduce(
      (acc, r) => ({
        leads: acc.leads + r.leads,
        qualified: acc.qualified + r.qualified,
        meetings: acc.meetings + r.meetings,
        contracts: acc.contracts + r.contracts,
      }),
      { leads: 0, qualified: 0, meetings: 0, contracts: 0 },
    ),
    [rows],
  );

  if (rows.length === 0) return null;

  const onSort = (key: SortKey) => {
    if (key === sortKey) { setAsc((v) => !v); return; }
    setSortKey(key);
    setAsc(key === 'manager');
  };

  const th = (label: string, key: SortKey, right = true) => (
    <th className={`px-3 py-2 font-medium ${right ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(key)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-zinc-700 cursor-pointer ${
          sortKey === key ? 'text-zinc-700' : ''
        }`}
      >
        {label}
        <span className={`text-[9px] ${sortKey === key ? 'opacity-100' : 'opacity-0'}`} aria-hidden>
          {asc ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-800">По менеджерам</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
              {th('Менеджер', 'manager', false)}
              {th('Лиды', 'leads')}
              {th('Квалы', 'qualified')}
              {th('Встречи', 'meetings')}
              {th('Договоры', 'contracts')}
              <th className="px-3 py-2 font-medium text-right">Квал / лид</th>
              <th className="px-3 py-2 font-medium text-right">Договор / лид</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.manager} className="border-b border-zinc-50 last:border-0">
                <td className="px-3 py-2 text-zinc-800">{r.manager}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{r.leads}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{r.qualified}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{r.meetings}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{r.contracts}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(r.qualified, r.leads)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(r.contracts, r.leads)}</td>
              </tr>
            ))}
            <tr className="bg-zinc-50 font-medium">
              <td className="px-3 py-2 text-zinc-700">Итого</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{totals.leads}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{totals.qualified}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{totals.meetings}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{totals.contracts}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(totals.qualified, totals.leads)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(totals.contracts, totals.leads)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* Оговорка нужна: строка «Без ответственного» читается как сбой данных,
          хотя это состояние самой CRM, и чинится оно в AMO, а не тут. */}
      <p className="text-[11px] text-zinc-400">
        Разбивка по ответственному в AMO на момент синка. «Без ответственного» — сделки, за
        которыми в CRM никто не закреплён. Встречи относятся к тому, за кем закреплена сделка.
      </p>
    </section>
  );
}
