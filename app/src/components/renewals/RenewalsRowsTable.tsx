'use client';

import type { RenewalTableRow } from '@/lib/renewals/tableRows';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';
import { SortableTh } from '@/components/ui/SortableTh';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

function fmtMoneyCell(value: number | null, raw: string | null) {
  if (value !== null) return `${value.toLocaleString('ru-RU')} ₽`;
  if (raw && raw.trim() !== '') {
    return (
      <span className="text-amber-700" title="Не удалось распознать сумму, показана как в базе">
        {raw}
      </span>
    );
  }
  return '—';
}

/**
 * Колонки таблицы продлений для общего механизма сортировки
 * (`@/components/ui/useSortableRows`).
 *
 * `budget` сортируется по уже распарсенному числу (`row.budget` из
 * tableRows.ts), а НЕ по «сырой» строке `budgetRaw`. Строка, которая не
 * распозналась как число (`budgetRaw` показан как есть, амбер-цветом), даёт
 * `budget === null` — а `null` попадает в общее правило «пустое значение — в
 * конец» из useSortableRows. Другого осмысленного места для неё нет:
 * сравнивать по величине нечего (нет числа), а протащить в сортировку
 * строковое сравнение сломало бы то самое «100 меньше 20», которого требует
 * задача — но для другого типа колонки.
 * Строка при этом остаётся видна в ячейке (амбер, как и раньше), просто не
 * участвует в порядке по величине.
 *
 * KPI — исключение: после переезда на AMO (см. amoRenewals.ts) туда приходит
 * поле карточки «KPI проекта», а это свободный текст («20 лидов», «без KPI»,
 * «-»). Числа там нет и не будет, поэтому и сортировка строковая, по
 * `kpiFactRaw`.
 */
export const renewalsSortColumns: SortColumns<RenewalTableRow> = {
  client: { type: 'string', getValue: (r) => r.client },
  name: { type: 'string', getValue: (r) => r.name },
  budget: { type: 'number', getValue: (r) => r.budget },
  paymentDate: { type: 'date', getValue: (r) => r.paymentDate },
  contractDate: { type: 'date', getValue: (r) => r.contractDate },
  kpiFact: { type: 'string', getValue: (r) => r.kpiFactRaw },
  status: { type: 'string', getValue: (r) => r.status },
  manager: { type: 'string', getValue: (r) => r.manager },
};

/**
 * Таблица строк продлений — общая разметка для основной таблицы
 * (`RenewalsTable`) и блока «без даты оплаты» (`RenewalsUndatedSection`): те
 * же восемь колонок, те же ячейки, та же сортировка. Общий компонент вместо
 * копипасты `<table>` в двух местах — колонка, добавленная сюда, появится в
 * обоих местах сразу и не разъедется.
 *
 * Каждый экземпляр держит своё независимое состояние сортировки — сортировка
 * в блоке «без даты» не переключает сортировку основной таблицы, и наоборот.
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
    <table className="w-full min-w-[760px] text-xs">
      <thead>
        <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
          <SortableTh label="Клиент" sortKey="client" sort={sort} onSort={toggleSort} />
          <SortableTh label="Услуга" sortKey="name" sort={sort} onSort={toggleSort} />
          <SortableTh label="Сумма" sortKey="budget" sort={sort} onSort={toggleSort} align="right" />
          <SortableTh label="Дата оплаты" sortKey="paymentDate" sort={sort} onSort={toggleSort} />
          <SortableTh label="Дата договора" sortKey="contractDate" sort={sort} onSort={toggleSort} />
          <SortableTh label="KPI" sortKey="kpiFact" sort={sort} onSort={toggleSort} />
          <SortableTh label="Статус" sortKey="status" sort={sort} onSort={toggleSort} />
          <SortableTh label="Менеджер" sortKey="manager" sort={sort} onSort={toggleSort} />
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => (
          <tr key={row.id} className="border-b border-zinc-50 last:border-0 hover:bg-[var(--glass-row-hover)]">
            <td className="px-3 py-2 font-medium text-zinc-800">{row.client || '—'}</td>
            <td className="px-3 py-2 text-zinc-600">{row.name || '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
              {fmtMoneyCell(row.budget, row.budgetRaw)}
            </td>
            <td className="px-3 py-2 tabular-nums text-zinc-600">
              <div className="flex items-center gap-1.5">
                {fmtDate(row.paymentDate)}
                {row.isPlanned && (
                  <span
                    title="Дата оплаты в будущем — это план, не свершившееся продление"
                    className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                  >
                    план
                  </span>
                )}
                {row.paymentDate === null && (
                  <span
                    title="Дата оплаты пуста или не в формате YYYY-MM-DD"
                    className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                  >
                    без даты
                  </span>
                )}
              </div>
            </td>
            <td className="px-3 py-2 tabular-nums text-zinc-600">{fmtDate(row.contractDate)}</td>
            {/* Текст, а не число: «KPI проекта» в AMO заполняют словами.
                Поэтому и без амбер-подсветки «не удалось распознать» — здесь
                нечего распознавать, это не ошибка данных. */}
            <td className="px-3 py-2 text-zinc-600">{row.kpiFactRaw?.trim() || '—'}</td>
            <td className="px-3 py-2 text-zinc-600">{row.status || '—'}</td>
            <td className="px-3 py-2 text-zinc-600">{row.manager || '—'}</td>
          </tr>
        ))}
        {sortedRows.length === 0 && (
          <tr>
            <td colSpan={8} className="px-3 py-8 text-center text-zinc-400">
              {emptyMessage}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
