'use client';

import { useState } from 'react';

import IncomeOperations from '@/components/expenses/IncomeOperations';
import { UnconvertedNote } from '@/components/expenses/KpiTile';
import { formatDelta, formatRub, formatShare } from '@/lib/expenses/client';
import type { PayerBreakdownItem } from '@/lib/expenses/types';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

const TOP_N = 15;

/**
 * Колонки таблицы разбивки по плательщикам — см. тот же выбор в
 * VendorBreakdown.tsx (соседний компонент по назначению). «Доля» не входит по
 * той же причине: `item.share = item.total / total` с общим знаменателем,
 * порядок по ней всегда совпадает с порядком по «Сумма» (см. `aggregate.ts`,
 * `breakdownByPayer`).
 */
const payerSortColumns: SortColumns<PayerBreakdownItem> = {
  payerName: { type: 'string', getValue: (r) => r.payerName },
  payerInn: { type: 'string', getValue: (r) => r.payerInn },
  total: { type: 'number', getValue: (r) => r.total },
  ops: { type: 'number', getValue: (r) => r.ops },
  deltaPrev: { type: 'number', getValue: (r) => r.deltaPrev },
};

/**
 * Разбивка дохода по плательщикам.
 *
 * Соседний компонент к `VendorBreakdown`, а не его переиспользование: у сторон
 * различается всё, что таблица делает. Строка разбивки опознаётся по ИНН и
 * имени (справочника плательщиков нет и не будет), колонки другие, а раскрытая
 * строка ходит в другой эндпоинт с другими параметрами. Свести это в один
 * компонент можно было бы только через ворох колбэков, которые меняли бы
 * половину его поведения. Общее — оформление и список операций — вынесено и
 * переиспользуется.
 */
function rowKey(item: PayerBreakdownItem): string {
  return item.payerKey || 'no-payer';
}

/**
 * Query раскрытой строки либо null, если фильтровать не по чему.
 *
 * `revenue=true` обязателен: сама разбивка считается по выручке (не-выручку
 * `breakdownByPayer` отбрасывает), и без этого параметра список операций не
 * сошёлся бы с суммой в строке над ним.
 */
function drillQuery(item: PayerBreakdownItem, base: string): string | null {
  if (item.payerInn) {
    return `${base}&revenue=true&payerInn=${encodeURIComponent(item.payerInn)}`;
  }
  // `payerName` у строки без плательщика — это подпись «Плательщик не указан»,
  // а не имя из выписки; фильтровать по ней нельзя. Отличает их префикс ключа.
  if (item.payerKey.startsWith('name:') && item.payerName) {
    return `${base}&revenue=true&payerName=${encodeURIComponent(item.payerName)}`;
  }
  return null;
}

export default function PayerBreakdown({
  items,
  query,
}: {
  items: PayerBreakdownItem[];
  /** from/to/groupBy/source — то же окно, что у сводки. */
  query: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const withBars = items.filter((item) => item.total > 0).slice(0, TOP_N);
  const max = withBars[0]?.total ?? 0;

  // Как и в VendorBreakdown: сортировка касается только таблицы, бары наверху
  // всегда TOP_N по сумме.
  const { sortedRows, sort, toggleSort } = useSortableRows(items, payerSortColumns);

  return (
    <div className="glass-tile p-3">
      <h3 className="mb-2 text-sm font-semibold text-zinc-900">Разбивка по плательщикам</h3>

      {items.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-zinc-400">
          Поступлений за выбранный период нет.
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {withBars.map((item) => (
              <div key={rowKey(item)} className="flex items-center gap-2">
                <span className="w-32 shrink-0 truncate text-xs text-zinc-700 sm:w-44" title={item.payerName}>
                  {item.payerName}
                </span>
                <span className="h-3.5 flex-1 rounded bg-zinc-100">
                  <span
                    className="block h-3.5 rounded bg-emerald-700"
                    style={{ width: max > 0 ? `${(item.total / max) * 100}%` : '0%' }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-zinc-900 sm:w-28">
                  {formatRub(item.total)} ₽
                </span>
              </div>
            ))}
          </div>

          {/* Плотная подложка под таблицей: на стекле строки просвечивают
              друг через друга. Размытия здесь нет — плитка уже стеклянная. */}
          <div className="mt-4 overflow-x-auto rounded-lg bg-[var(--glass-rows)]">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-400">
                  <SortableTh label="Плательщик" sortKey="payerName" sort={sort} onSort={toggleSort} className="py-2" />
                  <SortableTh label="ИНН" sortKey="payerInn" sort={sort} onSort={toggleSort} className="py-2" />
                  <SortableTh
                    label="Сумма"
                    sortKey="total"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                    className="py-2"
                  />
                  <th className="py-2 text-right font-medium">Доля</th>
                  <SortableTh
                    label="Операций"
                    sortKey="ops"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                    className="py-2"
                  />
                  <SortableTh
                    label="Δ"
                    sortKey="deltaPrev"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                    className="py-2"
                  />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((item) => {
                  const key = rowKey(item);
                  return (
                    <PayerRow
                      key={key}
                      item={item}
                      drill={drillQuery(item, query)}
                      open={openKey === key}
                      onToggle={() => setOpenKey((prev) => (prev === key ? null : key))}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PayerRow({
  item,
  drill,
  open,
  onToggle,
}: {
  item: PayerBreakdownItem;
  drill: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  // Рост дохода от плательщика — хорошая новость, падение — плохая: цвет
  // обратный расходному, где растущая сумма тревожит.
  const deltaColor =
    item.deltaPrev === null || item.deltaPrev === 0
      ? 'text-zinc-400'
      : item.deltaPrev > 0
        ? 'text-emerald-600'
        : 'text-rose-600';

  return (
    <>
      <tr className="border-t border-zinc-100 align-top">
        <td className="py-2">
          {drill ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="text-left text-emerald-800 hover:underline"
            >
              {open ? '▾ ' : '▸ '}
              {item.payerName}
            </button>
          ) : (
            // Ни ИНН, ни имени — отобрать такие операции нечем, и раскрывать
            // строку было бы обманом: фильтр «плательщик не указан» роут не
            // понимает, а без него список показал бы вообще весь приход.
            <span className="text-zinc-500" title="Ни имени, ни ИНН — отобрать эти операции нечем.">
              {item.payerName}
            </span>
          )}
          {item.total === 0 ? (
            <span className="ml-1.5 text-[10px] text-zinc-400">в этом периоде не платил</span>
          ) : null}
        </td>
        <td className="py-2 tabular-nums text-zinc-600">{item.payerInn ?? '—'}</td>
        <td className="py-2 text-right tabular-nums text-zinc-900">
          {formatRub(item.total)} ₽
          <UnconvertedNote count={item.unconvertedCount} byCurrency={item.unconvertedByCurrency} />
        </td>
        <td className="py-2 text-right tabular-nums text-zinc-600">{formatShare(item.share)}</td>
        <td className="py-2 text-right tabular-nums text-zinc-600">{item.ops}</td>
        <td className={`py-2 text-right tabular-nums ${deltaColor}`}>{formatDelta(item.deltaPrev)}</td>
      </tr>

      {open && drill ? (
        <tr className="border-t border-zinc-50">
          <td colSpan={6} className="px-2 pb-3">
            <div className="rounded-lg border-l-2 border-zinc-200 bg-zinc-50/60 px-3 py-2">
              {item.payerInn === null ? (
                <p className="mb-1.5 text-[11px] text-zinc-500">
                  Плательщик без ИНН опознаётся по имени, и разные написания одного имени в строку выше
                  сведены, а в список ниже попадает только написание из последнего платежа.
                </p>
              ) : null}
              <IncomeOperations query={drill} emptyText="Операций нет." />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
