'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SourceBreakdown } from '@/lib/firstSales/metrics';
import type { FiltersState } from '@/components/first-sales/FiltersBar';
import DealDrillDown from '@/components/first-sales/DealDrillDown';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

const fmt = (n: number) => n.toLocaleString('ru-RU');
const fmtMoney = (n: number) => (n > 0 ? `${Math.round(n).toLocaleString('ru-RU')} ₽` : '—');
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '—');

/**
 * Колонки внешней таблицы разбивки по источникам.
 *
 * «Доля» сюда сознательно не входит — она вычисляется из `leads` тем же
 * `totalLeads` для всех строк (`pct(row.leads, totalLeads)`), поэтому её
 * сортировка ВСЕГДА даёт тот же порядок строк, что сортировка по «Лиды»: доля
 * — монотонное преобразование лидов при фиксированном знаменателе, знак
 * разницы двух долей совпадает со знаком разницы двух `leads`. Возможного
 * случая, когда порядок разошёлся бы, нет. Кликабельный заголовок для колонки,
 * которая всегда дублирует соседнюю, — не польза, а обман: подписывает
 * пользователя ожидать независимую сортировку там, где её нет. Поэтому
 * заголовок остаётся обычным `<th>`, как раньше.
 */
const sourceSortColumns: SortColumns<SourceBreakdown> = {
  source: { type: 'string', getValue: (r) => r.source },
  leads: { type: 'number', getValue: (r) => r.leads },
  qualified: { type: 'number', getValue: (r) => r.qualified },
  meetings: { type: 'number', getValue: (r) => r.meetings },
  contracts: { type: 'number', getValue: (r) => r.contracts },
  money: { type: 'number', getValue: (r) => r.money },
};

export default function SourceTable({ rows, filters }: { rows: SourceBreakdown[]; filters: FiltersState }) {
  const totalLeads = rows.reduce((sum, r) => sum + r.leads, 0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, sourceSortColumns);

  const toggle = (key: string) => {
    setExpanded((cur) => (cur === key ? null : key));
  };

  return (
    <div className="glass-frame overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
            <SortableTh label="Источник" sortKey="source" sort={sort} onSort={toggleSort} />
            <SortableTh label="Лиды" sortKey="leads" sort={sort} onSort={toggleSort} align="right" />
            <th className="px-3 py-2 text-right font-medium">Доля</th>
            <SortableTh label="Квал" sortKey="qualified" sort={sort} onSort={toggleSort} align="right" />
            <SortableTh label="Встречи" sortKey="meetings" sort={sort} onSort={toggleSort} align="right" />
            <SortableTh label="Договоры" sortKey="contracts" sort={sort} onSort={toggleSort} align="right" />
            {/* Деньги, связанные со сделкой по ИНН плательщика. Прочерк —
                «связать не смогли», а не «денег не было»; доля покрытия стоит
                на карточке «Деньги» вверху дашборда. */}
            <SortableTh
              label={
                <span title="Банковские приходы, связанные со сделкой по ИНН плательщика. Прочерк значит «связать не смогли» — ИНН заполнен не у всех сделок.">
                  Деньги
                </span>
              }
              sortKey="money"
              sort={sort}
              onSort={toggleSort}
              align="right"
            />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isOpen = expanded === row.key;
            return (
              <Fragment key={row.key}>
                <tr
                  onClick={() => toggle(row.key)}
                  className="cursor-pointer border-b border-zinc-50 hover:bg-[var(--glass-row-hover)]"
                  aria-expanded={isOpen}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      )}
                      <span className="font-medium text-zinc-800">{row.source}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.leads)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(row.leads, totalLeads)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.qualified)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.meetings)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(row.contracts)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmtMoney(row.money)}</td>
                </tr>
                {isOpen && <DealDrillDown query={{ source: row.key }} filters={filters} colSpan={7} />}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-zinc-400">
                Нет данных за выбранный период.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
