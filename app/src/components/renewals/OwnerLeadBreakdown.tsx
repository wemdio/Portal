'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import type { RenewalTableRow } from '@/lib/renewals/tableRows';

/**
 * Разбивка продлений по ответственным лидам — близнец блока «По менеджерам» на
 * дашборде первички.
 *
 * «Ответственный лид» — поле карточки AMO: кто ведёт клиента по продлению. Это
 * не то же самое, что ответственный за сделку (он в таблице ниже колонкой
 * «Менеджер»): карточку двигает менеджер, а за отношения с клиентом отвечает
 * лид, и на планёрке спрашивают именно с него.
 *
 * Считается из тех же строк, что показывает таблица под ней. Это не экономия
 * запроса, а гарантия: два независимых среза под одним фильтром рано или
 * поздно разойдутся, и объяснять расхождение будет нечем.
 */

type SortKey = 'owner' | 'count' | 'revenue' | 'avgCheck' | 'planned' | 'withoutBudget';
type SortDir = 'asc' | 'desc';

const NO_OWNER = 'Без ответственного лида';

export type OwnerLeadRow = {
  owner: string;
  /** Свершившиеся продления периода: дата оплаты есть и она не в будущем. */
  count: number;
  revenue: number;
  avgCheck: number | null;
  /** Дата оплаты позже сегодняшнего дня — план, не факт. */
  planned: number;
  /** Из `count` — те, у кого сумма не распарсилась: в выручку они не вошли. */
  withoutBudget: number;
};

export function buildOwnerLeadRows(rows: RenewalTableRow[]): OwnerLeadRow[] {
  const byOwner = new Map<string, OwnerLeadRow>();

  for (const row of rows) {
    const owner = row.ownerLead?.trim() || NO_OWNER;
    let acc = byOwner.get(owner);
    if (!acc) {
      acc = { owner, count: 0, revenue: 0, avgCheck: null, planned: 0, withoutBudget: 0 };
      byOwner.set(owner, acc);
    }

    // Плановые продления не смешиваем со свершившимися: оплата в будущем — это
    // ожидание, и складывать её с полученными деньгами значит завышать факт.
    if (row.isPlanned) {
      acc.planned += 1;
      continue;
    }

    acc.count += 1;
    if (row.budget === null) acc.withoutBudget += 1;
    else acc.revenue += row.budget;
  }

  for (const acc of byOwner.values()) {
    const withBudget = acc.count - acc.withoutBudget;
    acc.avgCheck = withBudget > 0 ? acc.revenue / withBudget : null;
  }

  // По умолчанию — по деньгам вниз: первый вопрос к разбивке всегда «кто
  // принёс больше».
  return [...byOwner.values()].sort((a, b) => b.revenue - a.revenue);
}

const MONEY = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmtMoney = (value: number | null) => (value === null ? '—' : `${MONEY.format(Math.round(value))} ₽`);

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 text-zinc-300" />;
  return dir === 'asc'
    ? <ArrowUp className="h-3 w-3 text-zinc-500" />
    : <ArrowDown className="h-3 w-3 text-zinc-500" />;
}

export default function OwnerLeadBreakdown({ rows }: { rows: RenewalTableRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'revenue', dir: 'desc' });

  const data = useMemo(() => buildOwnerLeadRows(rows), [rows]);

  const sorted = useMemo(() => {
    const value = (row: OwnerLeadRow): string | number => {
      switch (sort.key) {
        case 'owner': return row.owner;
        case 'count': return row.count;
        case 'revenue': return row.revenue;
        // Пустой средний чек — вниз при любом направлении: «неизвестно»
        // не должно выигрывать сортировку у настоящих чисел.
        case 'avgCheck': return row.avgCheck ?? (sort.dir === 'desc' ? -1 : Number.MAX_SAFE_INTEGER);
        case 'planned': return row.planned;
        case 'withoutBudget': return row.withoutBudget;
        default: return 0;
      }
    };
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
      return String(va).localeCompare(String(vb), 'ru') * sign;
    });
  }, [data, sort]);

  const totals = useMemo(
    () => ({
      count: data.reduce((sum, r) => sum + r.count, 0),
      revenue: data.reduce((sum, r) => sum + r.revenue, 0),
      planned: data.reduce((sum, r) => sum + r.planned, 0),
      withoutBudget: data.reduce((sum, r) => sum + r.withoutBudget, 0),
    }),
    [data],
  );

  const toggle = (key: SortKey) => {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  const th = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => toggle(key)}
        className="inline-flex items-center gap-1 transition hover:text-zinc-700 cursor-pointer"
      >
        {label}
        <SortIcon active={sort.key === key} dir={sort.dir} />
      </button>
    </th>
  );

  return (
    <div className="glass-tile overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-800">По ответственным лидам</h3>
        <span className="text-[11px] text-zinc-500">
          {totals.count} продлений · {fmtMoney(totals.revenue)}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-400">
              {th('owner', 'Ответственный лид', 'left')}
              {th('count', 'Продлений')}
              {th('revenue', 'Сумма')}
              {th('avgCheck', 'Средний чек')}
              {th('planned', 'В плане')}
              {th('withoutBudget', 'Без суммы')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.owner} className="border-b border-zinc-50 last:border-0 hover:bg-[var(--glass-row-hover)]">
                <td className="px-3 py-2 font-medium text-zinc-800">{row.owner}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{row.count}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-900">{fmtMoney(row.revenue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{fmtMoney(row.avgCheck)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500" title="Дата оплаты в будущем — ожидаемое продление">
                  {row.planned || '—'}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${row.withoutBudget > 0 ? 'text-amber-600' : 'text-zinc-400'}`}
                  title="Продления, у которых поле «Сумма продления, ₽» пустое: в выручку они не вошли"
                >
                  {row.withoutBudget || '—'}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-zinc-400">
                  За период продлений нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totals.withoutBudget > 0 && (
        <p className="border-t border-zinc-100 px-4 py-2 text-[10px] text-zinc-400">
          У {totals.withoutBudget} продлений не заполнена сумма в карточке AMO — они посчитаны в
          количестве, но не в деньгах и не в среднем чеке.
        </p>
      )}
    </div>
  );
}
