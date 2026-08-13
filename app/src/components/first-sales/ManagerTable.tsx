'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ManagerBreakdown } from '@/lib/firstSales/metrics';
import type { FiltersState } from '@/components/first-sales/FiltersBar';
import DealDrillDown from '@/components/first-sales/DealDrillDown';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

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
 *
 * Столбец «Деньги» — банковские приходы, связанные со сделкой менеджера по ИНН
 * плательщика. Он заведомо неполон (ИНН заполнен у меньшинства сделок), и
 * пустая клетка здесь значит «связать не смогли», а не «денег не было»; общая
 * оговорка с долей покрытия стоит на карточке «Деньги» вверху дашборда.
 */

const fmt = (n: number) => n.toLocaleString('ru-RU');
const fmtMoney = (n: number) => (n > 0 ? `${Math.round(n).toLocaleString('ru-RU')} ₽` : '—');

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';

/**
 * Конверсии не сортируются по той же причине, что «Доля» в таблице источников
 * (см. `SourceTable`): при фиксированном знаменателе строки они монотонны по
 * числителю — но здесь знаменатель у каждой строки СВОЙ (лиды менеджера),
 * поэтому порядок мог бы и отличаться. Причина другая: доля от трёх лидов
 * («33%») и доля от трёхсот — величины разной надёжности, и сортировка по ним
 * ставит наверх тех, у кого просто мало лидов. Это не тот вопрос, ради
 * которого таблицу открывают.
 */
const managerSortColumns: SortColumns<ManagerBreakdown> = {
  manager: { type: 'string', getValue: (r) => r.manager },
  leads: { type: 'number', getValue: (r) => r.leads },
  qualified: { type: 'number', getValue: (r) => r.qualified },
  meetings: { type: 'number', getValue: (r) => r.meetings },
  contracts: { type: 'number', getValue: (r) => r.contracts },
  money: { type: 'number', getValue: (r) => r.money },
};

export default function ManagerTable({
  rows,
  filters,
}: {
  rows: ManagerBreakdown[];
  filters: FiltersState;
}) {
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, managerSortColumns);
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (manager: string) => {
    setExpanded((cur) => (cur === manager ? null : manager));
  };

  const totals = rows.reduce(
    (acc, r) => ({
      leads: acc.leads + r.leads,
      qualified: acc.qualified + r.qualified,
      meetings: acc.meetings + r.meetings,
      contracts: acc.contracts + r.contracts,
      money: acc.money + r.money,
    }),
    { leads: 0, qualified: 0, meetings: 0, contracts: 0, money: 0 },
  );

  if (rows.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-800">По менеджерам</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
              <SortableTh label="Менеджер" sortKey="manager" sort={sort} onSort={toggleSort} />
              <SortableTh label="Лиды" sortKey="leads" sort={sort} onSort={toggleSort} align="right" />
              <SortableTh label="Квалы" sortKey="qualified" sort={sort} onSort={toggleSort} align="right" />
              <SortableTh label="Встречи" sortKey="meetings" sort={sort} onSort={toggleSort} align="right" />
              <SortableTh label="Договоры" sortKey="contracts" sort={sort} onSort={toggleSort} align="right" />
              <SortableTh label="Деньги" sortKey="money" sort={sort} onSort={toggleSort} align="right" />
              <th className="px-3 py-2 text-right font-medium">Квал / лид</th>
              <th className="px-3 py-2 text-right font-medium">Договор / лид</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const isOpen = expanded === r.manager;
              return (
              <Fragment key={r.manager}>
              <tr
                onClick={() => toggle(r.manager)}
                className="cursor-pointer border-b border-zinc-50 last:border-0 hover:bg-zinc-50/60"
                aria-expanded={isOpen}
              >
                <td className="px-3 py-2 text-zinc-800">
                  <div className="flex items-center gap-1.5">
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    )}
                    <span>{r.manager}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(r.leads)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(r.qualified)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(r.meetings)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(r.contracts)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmtMoney(r.money)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(r.qualified, r.leads)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{pct(r.contracts, r.leads)}</td>
              </tr>
              {isOpen && <DealDrillDown query={{ manager: r.manager }} filters={filters} colSpan={8} />}
              </Fragment>
              );
            })}
            <tr className="bg-zinc-50 font-medium">
              <td className="px-3 py-2 text-zinc-700">Итого</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(totals.leads)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(totals.qualified)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(totals.meetings)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(totals.contracts)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmtMoney(totals.money)}</td>
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
        Деньги — банковские приходы, которые удалось связать со сделкой по ИНН плательщика:
        прочерк значит «связать не смогли», а не «денег не было».
      </p>
    </section>
  );
}
