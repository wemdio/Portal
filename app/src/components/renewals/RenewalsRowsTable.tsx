'use client';

import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

const fmtDate = (key: string) => new Date(key).toLocaleDateString('ru-RU');
const fmtMoney = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

/**
 * Колонки таблицы продлений для общего механизма сортировки
 * (`@/components/ui/useSortableRows`). Ссылка на сделку AMO не входит —
 * сортировать список по внутреннему id сделки бессмысленно пользователю.
 */
export const renewalsSortColumns: SortColumns<RenewalTableRow> = {
  client: { type: 'string', getValue: (r) => r.client },
  inn: { type: 'string', getValue: (r) => r.inn },
  amount: { type: 'number', getValue: (r) => r.amount },
  paymentDate: { type: 'date', getValue: (r) => r.paymentDate },
  methodLabel: { type: 'string', getValue: (r) => r.methodLabel },
  purpose: { type: 'string', getValue: (r) => r.purpose },
};

/**
 * Таблица строк продлений. Каждая строка — платёж из банка, подтверждённый
 * как продление (комментарием AMO, текстом задачи, типом проекта — устаревший
 * сигнал — или вручную человеком), см. `tableRows.ts`.
 */
export default function RenewalsRowsTable({
  rows,
  emptyMessage,
}: {
  rows: RenewalTableRow[];
  emptyMessage: string;
}) {
  const { sortedRows, sort, toggleSort } = useSortableRows(rows, renewalsSortColumns);

  return (
    <table className="w-full min-w-[820px] text-xs">
      <thead>
        <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
          <SortableTh label="Клиент" sortKey="client" sort={sort} onSort={toggleSort} />
          <SortableTh label="ИНН" sortKey="inn" sort={sort} onSort={toggleSort} />
          <SortableTh label="Сумма" sortKey="amount" sort={sort} onSort={toggleSort} align="right" />
          <SortableTh label="Дата платежа" sortKey="paymentDate" sort={sort} onSort={toggleSort} />
          <SortableTh label="Подтверждено" sortKey="methodLabel" sort={sort} onSort={toggleSort} />
          <SortableTh label="Назначение платежа" sortKey="purpose" sort={sort} onSort={toggleSort} />
          <th scope="col" className="px-3 py-2 font-medium">
            Сделка AMO
          </th>
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => (
          <tr key={row.transactionId} className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50/60">
            <td className="px-3 py-2 font-medium text-zinc-800">{row.client || '—'}</td>
            <td className="px-3 py-2 tabular-nums text-zinc-600">{row.inn || '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmtMoney(row.amount)}</td>
            <td className="px-3 py-2 tabular-nums text-zinc-600">{fmtDate(row.paymentDate)}</td>
            <td className="px-3 py-2 text-zinc-600" title={row.note ?? undefined}>
              {row.methodLabel}
            </td>
            <td className="max-w-[220px] truncate px-3 py-2 text-zinc-600" title={row.purpose ?? undefined}>
              {row.purpose || '—'}
            </td>
            <td className="px-3 py-2 text-zinc-600">
              {row.amoDealUrl ? (
                <a
                  href={row.amoDealUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  #{row.amoDealId}
                </a>
              ) : row.amoDealId !== null ? (
                `#${row.amoDealId}`
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
        {sortedRows.length === 0 && (
          <tr>
            <td colSpan={7} className="px-3 py-8 text-center text-zinc-400">
              {emptyMessage}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
